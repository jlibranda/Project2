// Integration tests for the security-hardening work: authentication, password hashing/migration,
// scoped state for employee sessions, full-state-write protection, ZK authorization, and tenant
// isolation. Runs the real server.js as a child process against a real (local) Postgres database,
// seeds two tenants directly via SQL, and exercises the actual HTTP API end to end.
//
// Requires a reachable Postgres at TEST_DATABASE_URL (defaults to a local auratest db/user, see
// the project's own established local-test convention).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const TimekeepingCore = require('../public/timekeeping-core.js');
const PayrollRuleEngine = require('../public/payroll-rule-engine.js');

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://auratest:auratest@localhost:5432/auratest';
const PORT = process.env.TEST_PORT || 3901;
const BASE = `http://localhost:${PORT}`;
const SESSION_SECRET = 'test-session-secret-not-for-production-use-only-in-ci';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); } else { console.log('ok - ' + msg); }
}
function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// Mirrors server.js's own sign() so this test can mint a token of a specific shape (here, a
// Web Bundy guest token) without needing a live email provider to obtain one the normal way.
function signTestToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function waitForServer(child) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok || res.status === 503) return;
    } catch {}
    if (child.exitCode !== null) throw new Error('server exited early during startup, code ' + child.exitCode);
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not become ready in time');
}

function startServer(extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      DATABASE_URL, PORT: String(PORT), API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: 'test-legacy-tenant', // keep this test run's "legacy" tenant isolated from any real one
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', d => { if (process.env.DEBUG_SECURITY_TEST) process.stderr.write(d); });
  return child;
}

async function seed(pg) {
  const passHash = p => bcrypt.hash(p, 10);
  // Tenant A: the main test tenant with a mix of a legacy-plaintext admin (for migration
  // testing), a pre-hashed plain employee, an attendance-approver employee (role==='employee'
  // but elevated via accessLevelId), and a couple of ZK-permission variants.
  const tenantAState = {
    schemaVersion: 1,
    accessLevels: [
      { id: 1, name: 'Super Admin', perms: {} },
      { id: 2, name: 'Basic Employee', perms: { self_view_attendance: true, leave: true, leave_apply: true, loans_apply: true } },
      { id: 3, name: 'Attendance Approver', perms: { att_edit: true } },
      // zkcommand explicitly false (not merely absent) -- the grandfather migration only backfills
      // zkcommand where it was never configured at all, so this level represents a tenant that has
      // deliberately opted a role INTO zksetup without zkcommand, post-migration.
      { id: 4, name: 'ZK Viewer', perms: { zksetup: true, zkcommand: false } },
      { id: 5, name: 'ZK Commander', perms: { zksetup: true, zkcommand: true } },
      // role==='employee' but elevated: can approve leave/attendance for people below them in the
      // immediateHeadEid hierarchy -- exactly the "manager who isn't role:admin" case the second
      // security pass is about.
      { id: 6, name: 'Manager', perms: { leave_approve: true, att_edit: true, self_view_attendance: true, leave: true, reports: true } },
      // A second, unrelated 'reports'-permission holder with no other elevated grant and no
      // relation to carol/dave -- isolates the "shared with every reports-permission holder, but
      // edit/delete stays creator-or-admin-only" behavior from the approval-chain fixture above.
      { id: 8, name: 'Report Viewer', perms: { reports: true } }
    ],
    // defaultLayers:2 so dave's chain below resolves two layers deep (carol, then admin) --
    // doesn't affect alice/bob/carol themselves since none of them have an immediateHeadEid
    // configured, so their own natural chains stay empty regardless of this number.
    approvalConfig: { maxLayers: 4, defaultLayers: 2, perEmployee: {} },
    users: [
      { id: 1, email: 'admin@a.test', pass: 'adminPlaintext1', role: 'admin', accessLevelId: 1, name: 'Admin A', eid: 'E-ADMIN', active: true },
      { id: 2, email: 'alice@a.test', pass: await passHash('alicepass1'), role: 'employee', accessLevelId: 2, name: 'Alice Employee', eid: 'E-ALICE', active: true, salaryPM: 50000, sss: '12-3456789-0', bank: 'BDO', bankAccount: '000111222' },
      { id: 3, email: 'bob@a.test', pass: 'bobPlaintext1', role: 'employee', accessLevelId: 3, name: 'Bob Approver', eid: 'E-BOB', active: true, salaryPM: 60000, sss: '99-8887776-0' },
      { id: 4, email: 'zkview@a.test', pass: await passHash('zkviewpass1'), role: 'employee', accessLevelId: 4, name: 'ZK Viewer', eid: 'E-ZKVIEW', active: true },
      { id: 5, email: 'zkcmd@a.test', pass: await passHash('zkcmdpass1'), role: 'employee', accessLevelId: 5, name: 'ZK Commander', eid: 'E-ZKCMD', active: true },
      // Approval-chain fixture: dave reports to carol, who reports to admin. Both carol and dave
      // are role:'employee' -- carol's authority comes entirely from accessLevelId 6 (Manager).
      { id: 6, email: 'carol@a.test', pass: await passHash('carolpass1'), role: 'employee', accessLevelId: 6, name: 'Carol Manager', eid: 'E-CAROL', immediateHeadEid: 'E-ADMIN', active: true },
      { id: 7, email: 'dave@a.test', pass: await passHash('davepass1'), role: 'employee', accessLevelId: 2, name: 'Dave Report', eid: 'E-DAVE', immediateHeadEid: 'E-CAROL', active: true },
      { id: 8, email: 'erin@a.test', pass: await passHash('erinpass1'), role: 'employee', accessLevelId: 8, name: 'Erin Viewer', eid: 'E-ERIN', active: true }
    ],
    attendance: [
      { id: 1, eid: 2, date: '2026-08-01', status: 'present' },
      { id: 2, eid: 3, date: '2026-08-01', status: 'late' },
      { id: 3, eid: 7, date: '2026-08-03', status: 'late', approvalStatus: 'pending', approvalLayer: 1 },
      { id: 4, eid: 1, date: '2026-08-03', status: 'late', approvalStatus: 'pending', approvalLayer: 1 },
      // Dedicated, never-decided-on-by-any-other-test fixture for the force-approve test (Issue 4
      // now restricts force-approve to pending records only) -- eid 5 (zkcmd) isn't touched by any
      // other attendance assertion, so this record's approvalStatus is guaranteed still 'pending'
      // whenever that test runs, regardless of test ordering elsewhere in this file.
      { id: 5, eid: 5, date: '2026-08-04', status: 'late', approvalStatus: 'pending', approvalLayer: 1 }
    ],
    leaves: [
      { id: 1, eid: 2, type: 'VL', status: 'pending' },
      { id: 2, eid: 7, type: 'VL', status: 'pending', approvalLayer: 1, days: 1 },
      { id: 3, eid: 1, type: 'VL', status: 'pending', approvalLayer: 1, days: 1 }
    ],
    loans: [],
    payrolls: [{ id: 1, from: '2026-08-01', to: '2026-08-15', status: 'released', items: [{ eid: 2, net: 45000 }, { eid: 3, net: 40000 }] }],
    company: { name: 'Tenant A Co', leaveTypes: [{ id: 1, name: 'VL', paid: true, active: true }, { id: 2, name: 'SL', paid: true, active: true }, { id: 3, name: 'Unpaid Leave', paid: false, active: true }] },
    org: [], lookups: {}, changeRequests: [], onboarding: [], candidates: [], performance: [],
    securityAudit: [{ id: 1, note: 'should never reach an employee session' }],
    platformClients: [{ id: 1, name: 'Should never leak', adminEmail: 'leak@example.com' }]
  };
  const tenantBState = {
    schemaVersion: 1,
    accessLevels: [{ id: 1, name: 'Super Admin', perms: {} }, { id: 2, name: 'Basic Employee', perms: {} }],
    users: [
      { id: 1, email: 'admin@b.test', pass: await passHash('adminBpass1'), role: 'admin', accessLevelId: 1, name: 'Admin B', active: true },
      { id: 2, email: 'carol@b.test', pass: await passHash('carolpass1'), role: 'employee', accessLevelId: 2, name: 'Carol B', active: true }
    ],
    attendance: [{ id: 1, eid: 2, date: '2026-08-01', status: 'present' }],
    leaves: [], loans: [], payrolls: [], company: { name: 'Tenant B Co' }, org: [], lookups: {}
  };
  await pg.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3)', ['test-tenant-a', tenantAState, 'seed']);
  await pg.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3)', ['test-tenant-b', tenantBState, 'seed']);
  await pg.query(
    `INSERT INTO platform_clients (tenant_key, name, admin_email, admin_pass) VALUES ($1, $2, $3, $4)`,
    ['test-tenant-a', 'Tenant A Co', 'compadmin@a.test', await passHash('compadminpass1')]
  );
}

async function main() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  await pg.query('DROP TABLE IF EXISTS app_state, app_state_audit, zk_devices, platform_clients, platform_admin_credential, zk_device_registry, security_audit_log CASCADE');

  console.log('--- starting server (first boot: creates schema) ---');
  let server = startServer();
  await waitForServer(server);
  server.kill();
  await new Promise(r => setTimeout(r, 300));

  await seed(pg);

  console.log('--- starting server for tests ---');
  server = startServer();
  await waitForServer(server);

  try {
    // ── 1. Regular employee can authenticate ──────────────────────────────────────────────
    let r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alice@a.test', password: 'alicepass1' }) });
    assertEqual(r.status, 200, '1. employee can log in with a pre-hashed password');
    const aliceToken = r.body.token;
    assert(!!aliceToken, '1b. login returns a token');

    // ── 13/14/15/29-32. Legacy plaintext password migration ────────────────────────────────
    // admin@a.test was seeded with a plaintext password (adminPlaintext1) specifically to test
    // migration -- but bulkMigrateLegacyPasswords() now runs on every boot (Issue 5 of the
    // second security pass), so by the time this test server is even accepting requests, that
    // plaintext has ALREADY been hashed. This is exactly the intended behavior (see 29-32
    // below for the dedicated bulk-migration test), so 15b here confirms that instead of the
    // old "still plaintext after a failed attempt" check, which no longer applies once bulk
    // migration exists.
    let row = await pg.query("SELECT state->'users' AS users FROM app_state WHERE tenant_key='test-tenant-a'");
    let adminRow = row.rows[0].users.find(u => u.id === 1);
    assert(/^\$2[aby]\$/.test(adminRow.pass), '15b-pre. bulk migration already hashed admin\'s plaintext password before any login attempt');
    const adminHashAfterBoot = adminRow.pass;

    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@a.test', password: 'wrong-password' }) });
    assertEqual(r.status, 401, '15. wrong password is rejected');
    row = await pg.query("SELECT state->'users' AS users FROM app_state WHERE tenant_key='test-tenant-a'");
    adminRow = row.rows[0].users.find(u => u.id === 1);
    assertEqual(adminRow.pass, adminHashAfterBoot, '15b. a failed login never touches the stored hash');

    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@a.test', password: 'adminPlaintext1' }) });
    assertEqual(r.status, 200, '14. correct password on a (now bulk-hashed) account still logs in');
    const adminToken = r.body.token;
    row = await pg.query("SELECT state->'users' AS users FROM app_state WHERE tenant_key='test-tenant-a'");
    adminRow = row.rows[0].users.find(u => u.id === 1);
    assert(/^\$2[aby]\$/.test(adminRow.pass), '13. a successful login against a legacy-plaintext password migrates it to a bcrypt hash');
    assert(adminRow.pass !== 'adminPlaintext1', '13b. the stored value is no longer the plaintext');

    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@a.test', password: 'adminPlaintext1' }) });
    assertEqual(r.status, 200, '13c. logging in again after migration (now hash-backed) still works');

    // ── 17. Password hashes never appear in API responses ─────────────────────────────────
    const loginBodyStr = JSON.stringify(r.body);
    assert(!/\$2[aby]\$/.test(loginBodyStr), '17. login response never contains a bcrypt hash');
    assert(!loginBodyStr.includes('adminPlaintext1'), '17b. login response never contains a plaintext password');

    // ── 3. Regular employee cannot GET full administrative tenant state ───────────────────
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + aliceToken } });
    assertEqual(r.status, 200, '3a. employee GET /api/state succeeds (scoped)');
    const aliceState = r.body.state;
    assert(Array.isArray(aliceState.users), '3b. scoped state still has a users array');
    const bobInAliceView = aliceState.users.find(u => u.email === 'bob@a.test');
    assert(!!bobInAliceView, '3c. other employees are still listed (directory)');
    assert(bobInAliceView.salaryPM === undefined, '2. Employee A cannot see Employee B\'s compensation');
    assert(bobInAliceView.sss === undefined, '2b. Employee A cannot see Employee B\'s government IDs');
    assert(bobInAliceView.pass === undefined, '4. no user record (self or other) ever includes a pass field');
    const aliceInOwnView = aliceState.users.find(u => u.email === 'alice@a.test');
    assert(aliceInOwnView.salaryPM === 50000, '3d. Alice can see her OWN compensation');
    assert(aliceInOwnView.pass === undefined, '4b. Alice\'s own record also never includes pass');
    assertEqual(aliceState.attendance.length, 1, '3e. employee only receives her own attendance records');
    assertEqual(aliceState.attendance[0].eid, 2, '3f. the one attendance record returned is hers');
    assertEqual(aliceState.leaves.length, 1, '3g. employee only receives her own leave records');
    assertEqual(aliceState.payrolls[0].items.length, 1, '3h. employee\'s payroll run is trimmed to her own item only');
    assertEqual(aliceState.payrolls[0].items[0].eid, 2, '3i. the one payroll item returned is hers');
    assertEqual(aliceState.securityAudit.length, 0, '3j. employee never receives the security audit trail');
    assertEqual(aliceState.platformClients.length, 0, '3k. employee never receives the platform client directory');
    assert(Array.isArray(aliceState.accessLevels) && aliceState.accessLevels.length > 0, '3l. accessLevels schema is still present (needed for client-side canAccess())');

    // Bob (att_edit) should see ALL attendance, not just his own.
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'bob@a.test', password: 'bobPlaintext1' }) });
    const bobToken = r.body.token;
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + bobToken } });
    assertEqual(r.body.state.attendance.length, 5, '3m. an employee-role account with att_edit sees ALL attendance, not just their own');

    // ── admin still gets the full, unscoped state ──────────────────────────────────────────
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + adminToken } });
    assertEqual(r.status, 200, '9a. admin GET /api/state succeeds');
    const adminState = r.body.state;
    const bobFull = adminState.users.find(u => u.email === 'bob@a.test');
    assert(bobFull.salaryPM === 60000, '9b. admin sees full compensation for every employee');
    assertEqual(adminState.securityAudit.length, 1, '9c. admin still receives securityAudit (unchanged transition behavior)');

    // ── 4. Regular employee cannot PUT full tenant state ───────────────────────────────────
    const maliciousState = JSON.parse(JSON.stringify(adminState));
    maliciousState.users.find(u => u.email === 'bob@a.test').salaryPM = 999999999;
    maliciousState.accessLevels.find(a => a.id === 2).perms.access_manage = true; // trying to self-grant a permission
    maliciousState.attendance.push({ id: 999, eid: 3, date: '2099-01-01', status: 'present' }); // someone else's record
    maliciousState.leaves.push({ id: 999, eid: 2, type: 'SL', s: '2026-10-05', e: '2026-10-05', reason: 'Not feeling well', status: 'pending' }); // her own -- SHOULD be accepted
    let verRow = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + aliceToken }, body: JSON.stringify({ version: Number(verRow.rows[0].version), state: maliciousState }) });
    assertEqual(r.status, 200, '5a. employee PUT is accepted (200), but silently constrained server-side');
    row = await pg.query("SELECT state, version FROM app_state WHERE tenant_key='test-tenant-a'");
    const persisted = row.rows[0].state;
    assertEqual(persisted.users.find(u => u.email === 'bob@a.test').salaryPM, 60000, '5b. Bob\'s salary is untouched despite being in the submitted payload');
    assertEqual(persisted.accessLevels.find(a => a.id === 2).perms.access_manage, undefined, '6. an employee cannot grant themselves (or anyone) a new access-level permission');
    assert(!persisted.attendance.some(a => a.id === 999), '5c. a forged attendance record for a different employee is discarded');
    assert(persisted.leaves.some(l => l.id === 999 && l.eid === 2), '5d. a genuine new leave record for HERSELF is accepted and persisted');
    const currentVersionAfterAliceWrite = Number(row.rows[0].version);

    // ── 7. Regular employee cannot alter payroll (already covered above via 5b/9-style check, plus an explicit payroll-array attempt) ──
    const payrollAttempt = JSON.parse(JSON.stringify(adminState));
    payrollAttempt.payrolls[0].items[0].net = 1;
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + aliceToken }, body: JSON.stringify({ version: currentVersionAfterAliceWrite, state: payrollAttempt }) });
    row = await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'");
    assertEqual(row.rows[0].state.payrolls[0].items[0].net, 45000, '7. employee cannot alter payroll amounts');

    // ── Admin can still fully write state (existing behavior preserved) ───────────────────
    const adminEdit = JSON.parse(JSON.stringify(row.rows[0].state));
    adminEdit.company.name = 'Renamed By Admin';
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ version: Number(row.rows[0].version ?? currentVersionAfterAliceWrite), state: adminEdit }) });
    // version may have advanced from the two employee writes above; fetch current version freshly if conflict
    if (r.status === 409) {
      const cur = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
      r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ version: Number(cur.rows[0].version), state: adminEdit }) });
    }
    assertEqual(r.status, 200, '10. admin (authorized) can still fully write state');
    row = await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'");
    assertEqual(row.rows[0].state.company.name, 'Renamed By Admin', '10b. admin\'s full-state write actually took effect');

    // ── admin-driven password hashing sweep ────────────────────────────────────────────────
    const withPlainPass = JSON.parse(JSON.stringify(row.rows[0].state));
    withPlainPass.users.push({ id: 6, email: 'newhire@a.test', pass: 'freshTempPass1', role: 'employee', accessLevelId: 2, name: 'New Hire', active: true });
    const curVer = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ version: Number(curVer.rows[0].version), state: withPlainPass }) });
    assertEqual(r.status, 200, 'admin-created employee write accepted');
    row = await pg.query("SELECT state->'users' AS users FROM app_state WHERE tenant_key='test-tenant-a'");
    const newHireRow = row.rows[0].users.find(u => u.id === 6);
    assert(/^\$2[aby]\$/.test(newHireRow.pass), 'a plaintext password on a newly-created employee (Add Employee/Bulk Upload path) is hashed before being persisted');

    // ── 8/19. ZK command authorization ─────────────────────────────────────────────────────
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alice@a.test', password: 'alicepass1' }) });
    const aliceToken2 = r.body.token;
    r = await req('/api/zk/status', { headers: { Authorization: 'Bearer ' + aliceToken2 } });
    assertEqual(r.status, 403, '8a. a plain employee with no ZK permission cannot even view ZK status');
    r = await req('/api/zk/command', { method: 'POST', headers: { Authorization: 'Bearer ' + aliceToken2 }, body: JSON.stringify({ serial: 'ABC123', action: 'reboot' }) });
    assertEqual(r.status, 403, '8. a plain employee cannot send a ZK device command');

    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'zkview@a.test', password: 'zkviewpass1' }) });
    const zkViewToken = r.body.token;
    r = await req('/api/zk/status', { headers: { Authorization: 'Bearer ' + zkViewToken } });
    assertEqual(r.status, 200, '19a. zksetup alone grants ZK status viewing');
    r = await req('/api/zk/command', { method: 'POST', headers: { Authorization: 'Bearer ' + zkViewToken }, body: JSON.stringify({ serial: 'ABC123', action: 'reboot' }) });
    assertEqual(r.status, 403, '19b. zksetup alone does NOT grant sending device commands (zkcommand is separate)');

    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'zkcmd@a.test', password: 'zkcmdpass1' }) });
    const zkCmdToken = r.body.token;
    r = await req('/api/zk/command', { method: 'POST', headers: { Authorization: 'Bearer ' + zkCmdToken }, body: JSON.stringify({ serial: 'ABC123', action: 'reboot' }) });
    assertEqual(r.status, 200, '19c. an account granted zkcommand can send device commands');

    // ── notify authorization (password-changed requires emp_reset_password) ───────────────
    r = await req('/api/notify', { method: 'POST', headers: { Authorization: 'Bearer ' + aliceToken2 }, body: JSON.stringify({ type: 'password-changed', payload: { employeeEmail: 'bob@a.test' } }) });
    assertEqual(r.status, 403, 'an employee without emp_reset_password cannot trigger a "password changed" notification about a colleague');

    // ── 12. Tenant A cannot access Tenant B ────────────────────────────────────────────────
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + adminToken } });
    const stateAStr = JSON.stringify(r.body.state);
    assert(!stateAStr.includes('carol@b.test'), '12. Tenant A\'s state never contains Tenant B\'s employee data');
    assert(!stateAStr.includes('Tenant B Co'), '12b. Tenant A\'s state never contains Tenant B\'s company name');

    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'carol@b.test', password: 'carolpass1' }) });
    assertEqual(r.status, 200, 'Tenant B\'s own employee can still log in independently');
    const carolToken = r.body.token;
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + carolToken } });
    assert(!JSON.stringify(r.body.state).includes('alice@a.test'), 'Tenant B session never sees Tenant A\'s data');

    // ── 5/platform admin can't be reached with a tenant admin token ───────────────────────
    r = await req('/api/platform/clients', { headers: { Authorization: 'Bearer ' + adminToken } });
    assertEqual(r.status, 403, 'a tenant admin token cannot call platform-admin-only endpoints');

    // ── expired/invalid session ────────────────────────────────────────────────────────────
    r = await req('/api/state', { headers: { Authorization: 'Bearer garbage.notasignature' } });
    assertEqual(r.status, 401, 'an invalid/garbage token is rejected with 401');

    // ── company-admin login (platform_clients.admin_email, no USERS[] row) still works ────
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'compadmin@a.test', password: 'compadminpass1' }) });
    assertEqual(r.status, 200, 'a real client\'s own company-admin login (no USERS[] record) still works');
    assertEqual(r.body.state ? Object.keys(r.body.state).includes('users') : false, true, 'company-admin login receives full state (role==\'admin\')');

    // ── 11. Bundy guest token cannot access /api/state (or any other normal endpoint) ─────
    const bundyToken = signTestToken({ sub: 'alice@a.test', tenantKey: 'test-tenant-a', eid: 2, purpose: 'bundy-punch', exp: Date.now() + 20 * 60 * 1000 });
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + bundyToken } });
    assertEqual(r.status, 401, '11. a Web Bundy guest token cannot be used to call GET /api/state');
    r = await req('/api/zk/status', { headers: { Authorization: 'Bearer ' + bundyToken } });
    assertEqual(r.status, 401, '11b. a Web Bundy guest token cannot be used to call any other normal API either');
    r = await req('/api/bundy/today', { headers: { Authorization: 'Bearer ' + bundyToken } });
    assertEqual(r.status, 200, '11c. the same Bundy token DOES work against its own two narrow endpoints');

    // ── expired session token ──────────────────────────────────────────────────────────────
    const expiredToken = signTestToken({ sub: 'alice@a.test', role: 'employee', tenantKey: 'test-tenant-a', exp: Date.now() - 1000 });
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + expiredToken } });
    assertEqual(r.status, 401, 'an expired session token is rejected with 401');

    // ══════════════════════════════════════════════════════════════════════════════════════
    // SECOND SECURITY PASS: employee self-mutation sanitization + backend-authoritative
    // attendance/leave approval (server/state-serialization.js sanitizers, server/approval-
    // chain.js, POST /api/attendance/:id/decision, POST /api/attendance/:id/force-approve,
    // POST /api/leaves/:id/decision).
    // ══════════════════════════════════════════════════════════════════════════════════════
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'dave@a.test', password: 'davepass1' }) });
    assertEqual(r.status, 200, 'dave (subordinate, plain employee) can log in');
    const daveToken = r.body.token;
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'carol@a.test', password: 'carolpass1' }) });
    assertEqual(r.status, 200, 'carol (manager, role:employee + leave_approve/att_edit) can log in');
    const carolAToken = r.body.token;

    // ── EMPLOYEE SELF-MUTATION (via PUT /api/state, the overlay's sanitizers) ─────────────
    let verBefore = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + daveToken } });
    const daveState = r.body.state;
    const daveLeaveTampered = JSON.parse(JSON.stringify(daveState));
    const dLeave = daveLeaveTampered.leaves.find(l => l.eid === 7);
    dLeave.status = 'approved'; dLeave.reviewedBy = 'Dave Report'; dLeave.reviewedAt = new Date().toISOString();
    dLeave.approvalHistory = [{ layer: 1, decision: 'approved', by: 'Dave Report', byEid: 'E-DAVE', at: new Date().toISOString() }];
    dLeave.approvalLayer = 99;
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ version: Number(verBefore.rows[0].version), state: daveLeaveTampered }) });
    assertEqual(r.status, 200, 'PUT is accepted (sanitized server-side, not rejected outright)');
    let persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    let persisted2Leave2 = persisted2.leaves.find(l => l.id === 2);
    assertEqual(persisted2Leave2.status, 'pending', '1. employee cannot change their own pending leave to approved via /api/state');
    assertEqual(persisted2Leave2.reviewedBy, undefined, '2. employee cannot set reviewedBy');
    assertEqual(persisted2Leave2.reviewedAt, undefined, '3. employee cannot set reviewedAt');
    assert(!Array.isArray(persisted2Leave2.approvalHistory) || persisted2Leave2.approvalHistory.length === 0, '4. employee cannot inject approvalHistory');
    assertEqual(persisted2Leave2.approvalLayer, 1, '5. employee cannot skip approvalLayer');

    verBefore = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
    const daveAttTampered = JSON.parse(JSON.stringify(daveState));
    const dAtt = daveAttTampered.attendance.find(a => a.eid === 7);
    dAtt.approvalStatus = 'approved'; dAtt.otHours = 999; dAtt.late = 0;
    // Sixth-pass (paid/unpaid half-day) fields -- an employee must not be able to forge their own
    // half-day leave into looking fully paid (paidLeaveFraction:0, unpaidLeaveFraction:0 while
    // still carrying leaveFraction:0.5) or inject a nonsensical negative unpaid fraction, exactly
    // the same way they already cannot forge leaveFraction/leaveDayType/approvalStatus itself.
    dAtt.leaveFraction = 0.5; dAtt.leaveDayType = 'half_am';
    dAtt.paidLeaveFraction = 0; dAtt.unpaidLeaveFraction = 0; dAtt.absentWorkFraction = -99;
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ version: Number(verBefore.rows[0].version), state: daveAttTampered }) });
    persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    let persisted2Att2 = persisted2.attendance.find(a => a.id === 3);
    assertEqual(persisted2Att2.approvalStatus, 'pending', '6. employee cannot change pending attendance to approved via /api/state');
    assertEqual(persisted2Att2.otHours, undefined, '7. employee cannot forge OT/payroll-relevant protected values on an attendance record');
    assertEqual(persisted2Att2.leaveFraction, undefined, '7b. employee cannot forge leaveFraction onto an attendance record via /api/state');
    assertEqual(persisted2Att2.paidLeaveFraction, undefined, '7c. employee cannot forge paidLeaveFraction onto an attendance record via /api/state');
    assertEqual(persisted2Att2.unpaidLeaveFraction, undefined, '7d. employee cannot forge unpaidLeaveFraction (including a nonsensical negative value) onto an attendance record via /api/state');
    assertEqual(persisted2Att2.absentWorkFraction, undefined, '7e. employee cannot forge absentWorkFraction onto an attendance record via /api/state');

    // 8/9/10: employee CAN still create legitimate own leave/attendance-adjustment requests, and
    // the server assigns safe initial values regardless of what the client sent.
    verBefore = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
    const daveNewLeave = JSON.parse(JSON.stringify(daveState));
    daveNewLeave.leaves.push({ id: 555, eid: 7, type: 'SL', s: '2026-09-01', e: '2026-09-01', reason: 'Sick', days: 1, status: 'approved', approvalLayer: 99, reviewedBy: 'Dave Report' });
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ version: Number(verBefore.rows[0].version), state: daveNewLeave }) });
    assertEqual(r.status, 200, '8. employee can still create a legitimate own leave request');
    persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    const newLeaveRow = persisted2.leaves.find(l => l.id === 555);
    assert(!!newLeaveRow, '8b. the new leave request was actually persisted');
    assertEqual(newLeaveRow.status, 'pending', '10. server assigns safe initial pending status regardless of what the client sent');
    assertEqual(newLeaveRow.approvalLayer, 1, '10b. server assigns approvalLayer 1 regardless of what the client sent');
    assertEqual(newLeaveRow.reviewedBy, undefined, '10c. server never accepts a client-supplied reviewedBy on a new record');

    // 9: attendance has no legitimate employee-authored creation path in this product (see
    // sanitizeEmployeeAttendanceRecord's own comment) -- confirm a "new" attendance record an
    // employee tries to inject is simply dropped, not silently accepted.
    verBefore = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
    const daveNewAtt = JSON.parse(JSON.stringify(daveState));
    daveNewAtt.attendance.push({ id: 777, eid: 7, date: '2026-09-01', status: 'present', approvalStatus: 'approved' });
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ version: Number(verBefore.rows[0].version), state: daveNewAtt }) });
    persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    assert(!persisted2.attendance.some(a => a.id === 777), '9. an employee-injected new attendance record is not accepted (no legitimate direct-creation path exists)');

    // ── MANAGER / LEAVE APPROVAL (backend-authoritative decision endpoints) ────────────────
    // 22/self-approval: dave cannot approve his own leave, even though carol later legitimately can.
    r = await req('/api/leaves/2/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 403, '22. employee cannot approve their own leave');

    // 21: a non-designated manager (bob, who has att_edit/leave permissions but is not dave's
    // chain approver) cannot approve dave's leave.
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'bob@a.test', password: 'bobPlaintext1' }) });
    const bobToken2 = r.body.token;
    r = await req('/api/leaves/2/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + bobToken2 }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 403, '21. a non-designated manager (no leave_approve, not the chain approver) cannot approve it');

    // 11/12/13/14/15/20/23: carol (the correct Layer-1 approver) approves -- persists, correct
    // reviewer/timestamp recorded server-side, and since dave's chain has 2 layers (carol, then
    // admin), this should advance to Layer 2 rather than finalize.
    r = await req('/api/attendance/3/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + carolAToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 200, '11. employee-role manager with correct permission can approve a subordinate\'s pending attendance');
    assertEqual(r.body.final, false, '15. multi-layer: Layer 1 approval does not finalize a 2-layer chain');
    assertEqual(r.body.record.approvalLayer, 2, '15b. approval layer advances to 2');
    persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    persisted2Att2 = persisted2.attendance.find(a => a.id === 3);
    assertEqual(persisted2Att2.approvalStatus, 'pending', '12. approval at a non-final layer persists as still-pending overall');
    // reviewedBy/reviewedAt on the record itself are only set on a FINAL decision (approved or
    // rejected) -- exact port of the original client behavior, where an intermediate layer
    // advance only appends to approvalHistory. Check the correct place for a non-final layer:
    // the approvalHistory entry this decision just added.
    assertEqual(persisted2Att2.approvalHistory[0].by, 'Carol Manager', '13. correct reviewer identity (carol) is recorded server-side (approvalHistory)');
    assert(!!persisted2Att2.approvalHistory[0].at, '14. a timestamp is recorded server-side (approvalHistory)');
    assertEqual(persisted2Att2.approvalHistory[0].byEid, 'E-CAROL', '13b. approvalHistory records the correct actor eid');

    // 24: final approval only changes overall status at the FINAL layer -- admin (Layer 2) now
    // finalizes it.
    r = await req('/api/attendance/3/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 200, 'admin (Layer 2 in this chain) can approve the final layer');
    assertEqual(r.body.final, true, '24. final approval only flips status at the final layer');
    persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    assertEqual(persisted2.attendance.find(a => a.id === 3).approvalStatus, 'approved', '24b. status is now approved after the final layer');

    // Leave: same chain, exercised end to end (20/23/24 for leave specifically).
    r = await req('/api/leaves/2/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + carolAToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 200, '20. correct manager (carol) can approve subordinate leave');
    assertEqual(r.body.final, false, '23. multi-layer leave approval advances correctly (not final at layer 1)');
    r = await req('/api/leaves/2/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 200, 'admin approves the final layer');
    assertEqual(r.body.final, true, '23b. final layer approval finalizes leave status');
    persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    assertEqual(persisted2.leaves.find(l => l.id === 2).status, 'approved', '20b. leave status is approved after the final layer');

    // 16/18/19: unauthorized approver blocked; force-approve is admin-only; admin can force-approve.
    r = await req('/api/attendance/4/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ decision: 'approved' }) });
    assert(r.status === 403, '16. an unauthorized caller (no att_edit, not the chain approver) cannot approve');
    r = await req('/api/attendance/4/force-approve', { method: 'POST', headers: { Authorization: 'Bearer ' + carolAToken }, body: JSON.stringify({}) });
    assertEqual(r.status, 403, '18. force-approve requires admin privileges (carol, a manager but not admin, is refused)');
    // record #4 belongs to admin (eid:1) -- confirm admin cannot force-approve (or normally
    // approve) their OWN record either, then use a fresh admin-owned-by-nobody-else record
    // implicitly covered by the earlier self-approval tests; here just confirm the self-block:
    r = await req('/api/attendance/4/force-approve', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({}) });
    assertEqual(r.status, 403, '17/self-approval: admin cannot force-approve their own record either, no policy exempts it');
    r = await req('/api/leaves/3/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 403, '17b. admin cannot approve their own leave via the normal decision endpoint either');

    // 19: authorized admin CAN force-approve someone else's still-pending record (id 5, eid 5 --
    // untouched by any earlier test, guaranteed still 'pending').
    r = await req('/api/attendance/5/force-approve', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({}) });
    assertEqual(r.status, 200, '19. an authorized admin can force-approve someone else\'s record');
    assert(/\(forced\)/.test(r.body.record.reviewedBy), '19b. reviewedBy is suffixed to show it was forced');

    // AS1: force-approving that SAME record again (now already 'approved') is refused with 409 --
    // Issue 4 restricts force-approve to pending records only, an explicit override workflow would
    // be needed to touch an already-decided record again, not a second silent overwrite through
    // the same endpoint.
    r = await req('/api/attendance/5/force-approve', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({}) });
    assertEqual(r.status, 409, 'AS1. force-approving an already-finalized attendance record is refused with 409, not silently re-applied');

    // AS2/AS3: the normal decision endpoint likewise refuses to re-decide an already-finalized
    // record -- record 3 (attendance) and leave id 2 were both finalized as 'approved' earlier in
    // this test run.
    r = await req('/api/attendance/3/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 409, 'AS2. an already-approved attendance record cannot be approved again through the normal decision endpoint');
    r = await req('/api/attendance/3/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ decision: 'rejected' }) });
    assertEqual(r.status, 409, 'AS3. an already-approved attendance record cannot be rejected through the normal decision endpoint either');
    r = await req('/api/leaves/2/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ decision: 'approved' }) });
    assertEqual(r.status, 409, 'AS4. an already-approved leave cannot be approved again through the normal decision endpoint');
    r = await req('/api/leaves/2/decision', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ decision: 'rejected' }) });
    assertEqual(r.status, 409, 'AS5. an already-approved leave cannot be rejected through the normal decision endpoint either');

    // ── Saved Reports: persisted, attributed, permission-gated, shared ──────────────────────
    let erinToken;
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'erin@a.test', password: 'erinpass1' }) });
    erinToken = r.body.token;

    // Dave (Basic Employee, no 'reports' permission) can't even create one.
    r = await req('/api/reports', { method: 'POST', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ name: 'Dave attempt', type: 'employees', columns: ['name'], filters: {} }) });
    assertEqual(r.status, 403, 'R1. an account without the reports permission cannot create a saved report');

    // Carol (Manager, holds 'reports') creates one -- server records who and when.
    r = await req('/api/reports', { method: 'POST', headers: { Authorization: 'Bearer ' + carolAToken }, body: JSON.stringify({ name: 'Headcount by Dept', type: 'employees', columns: ['name', 'dept'], filters: { dept: '' } }) });
    assertEqual(r.status, 200, 'R2. a user with the reports permission can save a report');
    const reportId = r.body.report.id;
    assertEqual(r.body.report.createdBy, 'Carol Manager', 'R3. the report records who saved it (name)');
    assertEqual(r.body.report.createdByEid, 'E-CAROL', 'R3b. the report records who saved it (eid)');
    assert(!!r.body.report.createdAt, 'R3c. the report records when it was saved');

    // Dave still can't see it at all -- GET /api/state omits savedReports entirely without the permission.
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + daveToken } });
    assertEqual((r.body.state.savedReports || []).length, 0, 'R4. an account without the reports permission sees no saved reports, even ones that exist');

    // Admin (full access) and Erin (a totally unrelated 'reports' holder) both see it -- proves
    // this is shared with every authorized user, not private to its creator.
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + adminToken } });
    assert((r.body.state.savedReports || []).some(x => x.id === reportId), 'R5. an admin sees a report saved by someone else');
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + erinToken } });
    assert((r.body.state.savedReports || []).some(x => x.id === reportId), 'R6. a different, unrelated reports-permission holder also sees it (shared, not private)');

    // Erin holds 'reports' but didn't create this one and isn't admin -- can view/load it (R6
    // above) but cannot edit or delete it.
    r = await req('/api/reports/' + reportId, { method: 'PUT', headers: { Authorization: 'Bearer ' + erinToken }, body: JSON.stringify({ name: 'Hijacked', type: 'employees', columns: ['name'], filters: {} }) });
    assertEqual(r.status, 403, 'R7. a reports-permission holder who did not create it cannot edit someone else\'s report');
    r = await req('/api/reports/' + reportId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + erinToken } });
    assertEqual(r.status, 403, 'R8. a reports-permission holder who did not create it cannot delete someone else\'s report');

    // The creator herself can edit it.
    r = await req('/api/reports/' + reportId, { method: 'PUT', headers: { Authorization: 'Bearer ' + carolAToken }, body: JSON.stringify({ name: 'Headcount by Dept (v2)', type: 'employees', columns: ['name', 'dept', 'pos'], filters: { dept: '' } }) });
    assertEqual(r.status, 200, 'R9. the creator can edit her own saved report');
    assertEqual(r.body.report.name, 'Headcount by Dept (v2)', 'R9b. the edit actually took effect');
    assertEqual(r.body.report.updatedBy, 'Carol Manager', 'R9c. an edit records who last updated it');

    // An admin (not the creator) can also edit or delete any report -- administrative override.
    r = await req('/api/reports/' + reportId, { method: 'PUT', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ name: 'Headcount by Dept (admin-renamed)', type: 'employees', columns: ['name'], filters: {} }) });
    assertEqual(r.status, 200, 'R10. an admin can edit a report they did not create');

    // Validation: an empty name and an unrecognized type are both rejected.
    r = await req('/api/reports', { method: 'POST', headers: { Authorization: 'Bearer ' + carolAToken }, body: JSON.stringify({ name: '', type: 'employees', columns: [], filters: {} }) });
    assertEqual(r.status, 400, 'R11. an empty report name is rejected');
    r = await req('/api/reports', { method: 'POST', headers: { Authorization: 'Bearer ' + carolAToken }, body: JSON.stringify({ name: 'Bad type', type: 'not-a-real-type', columns: [], filters: {} }) });
    assertEqual(r.status, 400, 'R12. an unrecognized report type is rejected');

    // A forged savedReports array smuggled into a non-admin's full PUT /api/state must never take
    // effect -- the employee-write overlay doesn't touch this array at all (server/state-serialization.js).
    let stateRow = await pg.query("SELECT version FROM app_state WHERE tenant_key='test-tenant-a'");
    r = await req('/api/state', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + daveToken },
      body: JSON.stringify({ version: Number(stateRow.rows[0].version), state: { savedReports: [{ id: 999, name: 'Forged by Dave', type: 'employees', columns: [], filters: {}, createdBy: 'Dave Report' }] } })
    });
    const afterForgeAttempt = await pg.query("SELECT state->'savedReports' AS sr FROM app_state WHERE tenant_key='test-tenant-a'");
    assert(!afterForgeAttempt.rows[0].sr.some(x => x.id === 999), 'R13. a forged savedReports entry smuggled into an employee\'s PUT /api/state never persists');

    // The creator deletes her own report; it disappears for everyone afterward.
    r = await req('/api/reports/' + reportId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + carolAToken } });
    assertEqual(r.status, 200, 'R14. the creator can delete her own saved report');
    r = await req('/api/state', { headers: { Authorization: 'Bearer ' + adminToken } });
    assert(!(r.body.state.savedReports || []).some(x => x.id === reportId), 'R15. a deleted report is gone for everyone, not just the deleter');

  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 200));
    await pg.end();
  }
}

// ── 18. Missing/default production secrets must fail fast ───────────────────────────────────
// Spawns server.js with NODE_ENV=production and no API_SESSION_SECRET set at all, and confirms
// it refuses to come up (exits non-zero quickly) instead of silently serving traffic signed with
// the well-known development default.
async function testProductionSecretFailFast() {
  const env = { ...process.env };
  delete env.API_SESSION_SECRET;
  delete env.GOD_ADMIN_PASSWORD;
  delete env.BOOTSTRAP_ADMIN_PASSWORD;
  env.NODE_ENV = 'production';
  env.PORT = String(Number(PORT) + 1);
  delete env.DATABASE_URL; // don't need a real DB connection for this -- it should never get that far
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => { resolve(null); }, 3000); // still running after 3s = it did NOT fail fast
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  if (exitCode === null) { try { child.kill(); } catch {} }
  assert(exitCode !== null && exitCode !== 0, '18. server refuses to start in production with no API_SESSION_SECRET configured');
}

// ── 1-8 (third security pass): DB-aware production credential checks, now including bcrypt-hash-
// of-known-default detection ─────────────────────────────────────────────────────────────────
// Reuses whatever the shared test DB looks like after main() has already run: main()'s own first
// schema-creating boot already created the bootstrap tenant row for APP_TENANT_KEY=
// 'test-legacy-tenant' in platform_clients, which is exactly the "already initialized" state
// test #8 needs (after this function overwrites its admin_pass with a safe hash -- see below).
// #5/#6/#7 use brand-new, never-before-seen tenant_keys instead, so there's nothing in the DB yet
// to exempt the bootstrap check.
// Boots server.js as a child with the given env and reports whether it exits (bad) or reaches
// /api/health (good) within a short deadline. Used throughout this function since production
// startup failures are the thing under test.
async function bootAttempt(env, port, timeoutMs) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  let ready = false, exitCode = null;
  child.on('exit', c => { exitCode = c; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !ready && exitCode === null) {
    try { const res = await fetch(`http://localhost:${port}/api/health`); if (res.ok) ready = true; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) { try { child.kill(); } catch {} await new Promise(r => setTimeout(r, 150)); }
  else { try { child.kill(); } catch {} await new Promise(r => setTimeout(r, 150)); }
  return { ready, exitCode, stderr };
}

async function testDbAwareProductionSecrets() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();

  // 25 (repeat, cheap to reconfirm here too): still fails with no API_SESSION_SECRET at all.
  {
    const env = { ...process.env, NODE_ENV: 'production', PORT: String(Number(PORT) + 2) };
    delete env.API_SESSION_SECRET; delete env.DATABASE_URL;
    const { ready, exitCode } = await bootAttempt(env, Number(PORT) + 2, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, '25. production + missing API_SESSION_SECRET fails');
  }

  // The shared test DB's legacy tenant (test-legacy-tenant) was bootstrapped by main()'s own
  // first, non-production boot with NO BOOTSTRAP_ADMIN_PASSWORD set -- so its platform_clients
  // .admin_pass is itself a bcrypt hash of the known default (admin123), by construction of this
  // test harness, not a real deployment's mistake. Overwrite it with a safe value up front so every
  // sub-test below that reuses this tenant to isolate the God Admin check (by relying on the
  // bootstrap check auto-passing) isn't accidentally ALSO failing on an unrelated unsafe bootstrap
  // credential this harness itself created.
  const safeBootstrapHash = await bcrypt.hash('a-real-non-default-bootstrap-password-' + Date.now(), 10);
  await pg.query('UPDATE platform_clients SET admin_pass = $1 WHERE tenant_key = $2', [safeBootstrapHash, 'test-legacy-tenant']);

  // 1/2/3/4: God Admin credential checks. platform_admin_credential is a single global row (id=1),
  // reset before each scenario. 'test-legacy-tenant' is reused throughout so the (now-safe)
  // bootstrap check never interferes -- these four scenarios isolate the God Admin check alone.
  const resetGodRow = async () => { await pg.query('DELETE FROM platform_admin_credential WHERE id = 1'); };
  const godEnv = extra => ({
    ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
    APP_TENANT_KEY: 'test-legacy-tenant', ...extra
  });
  {
    await resetGodRow();
    const env = godEnv({}); delete env.GOD_ADMIN_PASSWORD;
    const port = Number(PORT) + 10;
    const { ready, exitCode } = await bootAttempt({ ...env, PORT: String(port) }, port, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC1. production + no DB God credential + missing GOD_ADMIN_PASSWORD fails startup');
  }
  {
    await resetGodRow();
    const port = Number(PORT) + 11;
    const { ready, exitCode } = await bootAttempt({ ...godEnv({ GOD_ADMIN_PASSWORD: 'godmode2026' }), PORT: String(port) }, port, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC2. production + GOD_ADMIN_PASSWORD=godmode2026 fails');
  }
  {
    await resetGodRow();
    const hashOfDefault = await bcrypt.hash('godmode2026', 10);
    await pg.query('INSERT INTO platform_admin_credential (id, password, updated_by) VALUES (1, $1, $2)', [hashOfDefault, 'seed']);
    const port = Number(PORT) + 12;
    const env = godEnv({}); delete env.GOD_ADMIN_PASSWORD;
    const { ready, exitCode } = await bootAttempt({ ...env, PORT: String(port) }, port, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC3. production + DB God credential hashed from godmode2026 fails');
  }
  {
    // PC3b: the recovery path -- an unsafe STORED credential with no way to fix it through the
    // (unreachable, because the server won't boot) Settings UI must be rotatable via env var
    // instead of leaving the operator needing raw database access. When a safe GOD_ADMIN_PASSWORD
    // IS supplied alongside the unsafe stored hash, the server rotates the stored credential to
    // match it and boots successfully -- proven here by confirming the DB row actually changed to
    // a hash of the new value, not just that the server came up.
    await resetGodRow();
    const hashOfDefault = await bcrypt.hash('godmode2026', 10);
    await pg.query('INSERT INTO platform_admin_credential (id, password, updated_by) VALUES (1, $1, $2)', [hashOfDefault, 'seed']);
    const newSafePassword = 'recovered-god-admin-password-' + Date.now();
    const port = Number(PORT) + 17;
    const { ready, exitCode, stderr } = await bootAttempt({ ...godEnv({ GOD_ADMIN_PASSWORD: newSafePassword }), PORT: String(port) }, port, 20000);
    assert(ready, `PC3b. an unsafe stored God Admin credential is auto-rotated (not just blocked) when a safe GOD_ADMIN_PASSWORD is supplied, and the server boots (exitCode=${exitCode}, stderr=${stderr.slice(0, 800)})`);
    const rotatedRow = await pg.query('SELECT password FROM platform_admin_credential WHERE id = 1');
    assertEqual(rotatedRow.rows[0].password === hashOfDefault, false, 'PC3c. the stored hash actually changed (no longer the old unsafe one)');
    assert((await bcrypt.compare(newSafePassword, rotatedRow.rows[0].password)), 'PC3d. the stored hash now verifies against the new safe password supplied via env var');
  }
  {
    await resetGodRow();
    const hashOfSafe = await bcrypt.hash('a-real-god-admin-password-' + Date.now(), 10);
    await pg.query('INSERT INTO platform_admin_credential (id, password, updated_by) VALUES (1, $1, $2)', [hashOfSafe, 'seed']);
    const port = Number(PORT) + 13;
    const env = godEnv({}); delete env.GOD_ADMIN_PASSWORD;
    const { ready, exitCode, stderr } = await bootAttempt({ ...env, PORT: String(port) }, port, 20000);
    assert(ready, `PC4. production + safe DB God credential boots without env password (exitCode=${exitCode}, stderr=${stderr.slice(0, 800)})`);
  }
  await resetGodRow(); // leave global state clean for tests after this one

  // 5/6: fresh, never-before-seen tenant + missing/default BOOTSTRAP_ADMIN_PASSWORD. A safe
  // GOD_ADMIN_PASSWORD is supplied throughout so only the bootstrap check can be the cause of failure.
  {
    const freshTenantKey = 'test-fresh-prod-' + Date.now();
    const port = Number(PORT) + 14;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: freshTenantKey, GOD_ADMIN_PASSWORD: 'a-real-non-default-god-admin-password-xyz',
      PORT: String(port)
    };
    delete env.BOOTSTRAP_ADMIN_PASSWORD;
    const { ready, exitCode } = await bootAttempt(env, port, 4000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC5. fresh production tenant + missing BOOTSTRAP_ADMIN_PASSWORD fails startup');
  }
  {
    const freshTenantKey = 'test-fresh-prod-' + Date.now() + '-b';
    const port = Number(PORT) + 15;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: freshTenantKey, GOD_ADMIN_PASSWORD: 'a-real-non-default-god-admin-password-xyz',
      BOOTSTRAP_ADMIN_PASSWORD: 'admin123', PORT: String(port)
    };
    const { ready, exitCode } = await bootAttempt(env, port, 4000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC6. fresh production tenant + BOOTSTRAP_ADMIN_PASSWORD=admin123 fails');
  }

  // 7: an existing tenant whose platform_clients.admin_pass is itself a bcrypt hash of admin123
  // must be detected as unsafe even though the row already exists (tenantRowExists alone used to
  // be sufficient to skip this check entirely).
  {
    const unsafeTenantKey = 'test-unsafe-bootstrap-' + Date.now();
    const hashOfDefault = await bcrypt.hash('admin123', 10);
    await pg.query(
      `INSERT INTO platform_clients (tenant_key, name, admin_email, admin_pass) VALUES ($1, $2, $3, $4)`,
      [unsafeTenantKey, 'Unsafe Bootstrap Co', 'unsafe-bootstrap-' + Date.now() + '@ph.com', hashOfDefault]
    );
    const port = Number(PORT) + 16;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: unsafeTenantKey, GOD_ADMIN_PASSWORD: 'a-real-non-default-god-admin-password-xyz',
      PORT: String(port)
    };
    const { ready, exitCode } = await bootAttempt(env, port, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC7. an existing bootstrap admin hash matching admin123 is detected as unsafe');
  }

  // PC7b: same recovery path as PC3b, for the bootstrap admin credential -- a safe
  // BOOTSTRAP_ADMIN_PASSWORD supplied alongside an unsafe stored admin_pass rotates it and boots,
  // instead of leaving the operator stuck needing direct database access.
  {
    const unsafeTenantKey2 = 'test-unsafe-bootstrap-recover-' + Date.now();
    const hashOfDefault = await bcrypt.hash('admin123', 10);
    await pg.query(
      `INSERT INTO platform_clients (tenant_key, name, admin_email, admin_pass) VALUES ($1, $2, $3, $4)`,
      [unsafeTenantKey2, 'Unsafe Bootstrap Recover Co', 'unsafe-bootstrap-recover-' + Date.now() + '@ph.com', hashOfDefault]
    );
    const newSafePassword = 'recovered-bootstrap-password-' + Date.now();
    const port = Number(PORT) + 18;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: unsafeTenantKey2, GOD_ADMIN_PASSWORD: 'a-real-non-default-god-admin-password-xyz',
      BOOTSTRAP_ADMIN_PASSWORD: newSafePassword, PORT: String(port)
    };
    const { ready, exitCode, stderr } = await bootAttempt(env, port, 20000);
    assert(ready, `PC7b. an unsafe stored bootstrap admin credential is auto-rotated (not just blocked) when a safe BOOTSTRAP_ADMIN_PASSWORD is supplied, and the server boots (exitCode=${exitCode}, stderr=${stderr.slice(0, 800)})`);
    const rotatedRow = await pg.query('SELECT admin_pass FROM platform_clients WHERE tenant_key = $1', [unsafeTenantKey2]);
    assertEqual(rotatedRow.rows[0].admin_pass === hashOfDefault, false, 'PC7c. the stored hash actually changed (no longer the old unsafe one)');
    assert((await bcrypt.compare(newSafePassword, rotatedRow.rows[0].admin_pass)), 'PC7d. the stored hash now verifies against the new safe password supplied via env var');
  }

  // 8: an already-initialized deployment (test-legacy-tenant, now holding a safe admin_pass hash
  // per the fix-up at the top of this function) boots fine without BOOTSTRAP_ADMIN_PASSWORD.
  {
    const port = Number(PORT) + 4;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: 'test-legacy-tenant', GOD_ADMIN_PASSWORD: 'a-real-non-default-god-admin-password-123',
      PORT: String(port)
    };
    delete env.BOOTSTRAP_ADMIN_PASSWORD;
    const { ready, exitCode, stderr } = await bootAttempt(env, port, 20000);
    assert(ready, `PC8. an already-initialized deployment boots fine without BOOTSTRAP_ADMIN_PASSWORD once its tenant row already exists (and its stored credential is safe) (exitCode=${exitCode}, stderr=${stderr.slice(0, 800)})`);
  }

  // 9/10/11: the shared MIN_PASSWORD_LENGTH=6 floor (isSafeReplacementCredential) actually gates
  // GOD_ADMIN_PASSWORD/BOOTSTRAP_ADMIN_PASSWORD independently of the known-default check -- a
  // too-short but otherwise non-default value must still fail, and exactly 6 characters must pass.
  {
    await resetGodRow();
    const port = Number(PORT) + 19;
    const { ready, exitCode } = await bootAttempt({ ...godEnv({ GOD_ADMIN_PASSWORD: 'x' }), PORT: String(port) }, port, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC9. production + no DB God credential + GOD_ADMIN_PASSWORD shorter than 6 chars fails startup');
  }
  {
    const freshTenantKey = 'test-fresh-prod-' + Date.now() + '-short';
    const port = Number(PORT) + 20;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: freshTenantKey, GOD_ADMIN_PASSWORD: 'a-real-non-default-god-admin-password-xyz',
      BOOTSTRAP_ADMIN_PASSWORD: '12345', PORT: String(port)
    };
    const { ready, exitCode } = await bootAttempt(env, port, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC10. fresh production tenant + BOOTSTRAP_ADMIN_PASSWORD shorter than 6 chars (12345) fails startup');
  }
  {
    // PC11: exactly 6 characters, not a known default -- the floor, not one character below it --
    // is accepted for both credentials (fresh tenant + no existing God row, so both checks run).
    await resetGodRow();
    const freshTenantKey = 'test-fresh-prod-' + Date.now() + '-six';
    const port = Number(PORT) + 22;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: freshTenantKey, GOD_ADMIN_PASSWORD: 'abcdef', BOOTSTRAP_ADMIN_PASSWORD: 'ghijkl',
      BOOTSTRAP_ADMIN_EMAIL: 'six-char-pc11-' + Date.now() + '@ph.com', PORT: String(port)
    };
    const { ready, exitCode, stderr } = await bootAttempt(env, port, 20000);
    assert(ready, `PC11. production + GOD_ADMIN_PASSWORD/BOOTSTRAP_ADMIN_PASSWORD of exactly 6 characters (not a known default) boots successfully (exitCode=${exitCode}, stderr=${stderr.slice(0, 800)})`);
  }
  await resetGodRow();

  // PC12: a known default is still rejected even though it happens to be >=6 characters long --
  // the length floor is an ADDITIONAL requirement, never a substitute for the default check.
  {
    const port = Number(PORT) + 23;
    const { ready, exitCode } = await bootAttempt({ ...godEnv({ GOD_ADMIN_PASSWORD: 'godmode2026' }), PORT: String(port) }, port, 3000);
    assert(!ready && exitCode !== null && exitCode !== 0, 'PC12. production + GOD_ADMIN_PASSWORD=godmode2026 (11 chars, still the known default) fails despite being long enough');
  }
  await resetGodRow();

  // PC13: a safe, already-stored DB credential (God Admin row + tenant row both pre-existing and
  // safe) boots without EITHER env var set at all -- confirms the length floor only governs the
  // "about to become the real credential" branch, not deployments that already have a real one.
  {
    const hashOfSafe = await bcrypt.hash('an-existing-safe-god-admin-credential-' + Date.now(), 10);
    await pg.query('INSERT INTO platform_admin_credential (id, password, updated_by) VALUES (1, $1, $2)', [hashOfSafe, 'seed']);
    const port = Number(PORT) + 24;
    const env = {
      ...process.env, NODE_ENV: 'production', DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET,
      APP_TENANT_KEY: 'test-legacy-tenant', PORT: String(port)
    };
    delete env.GOD_ADMIN_PASSWORD; delete env.BOOTSTRAP_ADMIN_PASSWORD;
    const { ready, exitCode, stderr } = await bootAttempt(env, port, 20000);
    assert(ready, `PC13. safe existing DB God Admin + bootstrap credentials allow boot with neither GOD_ADMIN_PASSWORD nor BOOTSTRAP_ADMIN_PASSWORD set (exitCode=${exitCode}, stderr=${stderr.slice(0, 800)})`);
  }
  await resetGodRow();

  await pg.end();
}

// ── 29/30/31/32: bulk legacy-password migration on boot ─────────────────────────────────────
async function testBulkPasswordMigration() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  const migTenant = 'test-migration-tenant';
  const existingHash = await bcrypt.hash('alreadyHashedPass1', 10);
  await pg.query('DELETE FROM app_state WHERE tenant_key = $1', [migTenant]);
  await pg.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3)', [
    migTenant,
    {
      schemaVersion: 1, accessLevels: [{ id: 1, name: 'Super Admin', perms: {} }],
      users: [
        { id: 1, email: 'plain1@mig.test', pass: 'plaintextpass1', role: 'admin', accessLevelId: 1, active: true },
        { id: 2, email: 'plain2@mig.test', pass: 'plaintextpass2', role: 'employee', accessLevelId: 1, active: true },
        { id: 3, email: 'already@mig.test', pass: existingHash, role: 'employee', accessLevelId: 1, active: true }
      ],
      attendance: [], leaves: [], loans: [], payrolls: [], company: {}, org: [], lookups: {}
    },
    'seed'
  ]);
  await pg.query('DELETE FROM platform_clients WHERE tenant_key = $1', [migTenant]);
  await pg.query(
    'INSERT INTO platform_clients (tenant_key, name, admin_email, admin_pass) VALUES ($1, $2, $3, $4)',
    [migTenant, 'Migration Test Co', 'plainadmin@mig.test', 'plainClientPass1']
  );
  await pg.query('DELETE FROM platform_admin_credential WHERE id = 1');
  await pg.query('INSERT INTO platform_admin_credential (id, password, updated_by) VALUES (1, $1, $2)', ['plainGodPass1', 'seed']);

  const migPort = Number(PORT) + 5;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET, PORT: String(migPort), APP_TENANT_KEY: 'test-legacy-tenant' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { const res = await fetch(`http://localhost:${migPort}/api/health`); if (res.ok) ready = true; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 250));
  }
  await new Promise(r => setTimeout(r, 500)); // bulkMigrateLegacyPasswords is awaited inside initializeDatabase, but give it a beat regardless

  const usersRow = await pg.query("SELECT state->'users' AS users FROM app_state WHERE tenant_key = $1", [migTenant]);
  const users = usersRow.rows[0].users;
  assert(/^\$2[aby]\$/.test(users.find(u => u.email === 'plain1@mig.test').pass), '29. plaintext user credentials are bulk-migrated (user 1)');
  assert(/^\$2[aby]\$/.test(users.find(u => u.email === 'plain2@mig.test').pass), '29b. plaintext user credentials are bulk-migrated (user 2)');
  assertEqual(users.find(u => u.email === 'already@mig.test').pass, existingHash, '30. an existing bcrypt hash is not changed by the bulk migration');

  const clientRow = await pg.query('SELECT admin_pass FROM platform_clients WHERE tenant_key = $1', [migTenant]);
  assert(/^\$2[aby]\$/.test(clientRow.rows[0].admin_pass), '31. plaintext platform-client admin password is migrated');

  const godRow = await pg.query('SELECT password FROM platform_admin_credential WHERE id = 1');
  assert(/^\$2[aby]\$/.test(godRow.rows[0].password), '32. plaintext DB God Admin password is migrated');

  try { child.kill(); } catch {}
  await new Promise(r => setTimeout(r, 200));
  await pg.end();
}

// ── LV/TX: server-side leave calculation/validation, and transactional finalization side effects ──
// A dedicated tenant/seed rather than reusing tenant A's -- this needs a leave type with an actual
// balance, a pay group + a CLOSED pay period (for the late-approval payroll-credit path), and an
// empty approval chain (no immediateHeadEid) so admin's floor 'leave_approve' permission is what
// authorizes the decision, keeping each scenario isolated and easy to reason about.
async function testLeaveIntegrityAndFinalization() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  const tenantKey = 'test-leave-finalize-tenant';
  const passHash = p => bcrypt.hash(p, 10);
  const state = {
    schemaVersion: 1,
    accessLevels: [
      { id: 1, name: 'Super Admin', perms: {} },
      { id: 2, name: 'Employee', perms: { leave: true, leave_apply: true } },
      { id: 3, name: 'Manager', perms: { leave: true, leave_apply: true, leave_approve: true } },
      // Issue 21 (attendance-response privacy): two more "can see full attendance" holders besides
      // admin -- att_edit and payroll each independently grant it, leave_approve alone (Manager,
      // above) must not.
      { id: 4, name: 'Att Edit Manager', perms: { leave: true, leave_apply: true, leave_approve: true, att_edit: true } },
      { id: 5, name: 'Payroll Manager', perms: { leave: true, leave_apply: true, leave_approve: true, payroll: true } }
    ],
    approvalConfig: { maxLayers: 4, defaultLayers: 1, perEmployee: {} },
    users: [
      { id: 1, email: 'admin@lv.test', pass: await passHash('adminlvpass1'), role: 'admin', accessLevelId: 1, name: 'Admin LV', eid: 'E-LVADMIN', active: true },
      // No immediateHeadEid -- chain resolves empty, so admin's floor permission (or leave_approve)
      // is what authorizes acting on empEmp's leaves, isolating the tests from chain-resolution
      // behavior already covered elsewhere.
      { id: 2, email: 'emp@lv.test', pass: await passHash('emplvpass1'), role: 'employee', accessLevelId: 2, name: 'Emp LV', eid: 'E-LVEMP', active: true,
        salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      { id: 3, email: 'mgr@lv.test', pass: await passHash('mgrlvpass1'), role: 'employee', accessLevelId: 3, name: 'Mgr LV', eid: 'E-LVMGR', active: true },
      // Reports to mgr -- used for the "manager approval produces the same side effects as admin"
      // test (29), so a non-admin approver actually has to be the one whose actorName lands on
      // reviewedBy/the balance-adjustment record.
      // Carries every confidential field the privacy-scoped leave-decision response (Issue 1/11)
      // must never leak to a leave_approve-only manager -- compensation, government IDs, and bank
      // details, mirroring the real fields buildAssistantContext()/the employee record actually use.
      { id: 4, email: 'rep@lv.test', pass: await passHash('replvpass1'), role: 'employee', accessLevelId: 2, name: 'Rep LV', eid: 'E-LVREP', immediateHeadEid: 'E-LVMGR', active: true,
        salaryPM: 22000, rate: 1000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } },
        sss: '34-1234567-8', ph: '12-345678901-2', pi: '1234-5678-9012', tin: '123-456-789-000',
        bank: 'BDO', bankAccount: '0012345678901' },
      // Assigned to the Mon-Fri shift below (id 1) -- Sat/Sun are real, configured rest days for
      // this employee specifically, unlike every other user in this fixture (no shiftId = every
      // calendar day counts, which is fine for the tests above but can't exercise rest-day
      // exclusion at all).
      { id: 5, email: 'shiftemp@lv.test', pass: await passHash('shiftemplvpass1'), role: 'employee', accessLevelId: 2, name: 'Shift Emp LV', eid: 'E-LVSHIFT', active: true,
        shiftId: 1, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      // Dedicated to the concurrent/pending-balance revalidation scenario -- starts at a clean,
      // known balance of 5, untouched by any other test in this fixture.
      { id: 6, email: 'balanceemp@lv.test', pass: await passHash('balanceemplvpass1'), role: 'employee', accessLevelId: 2, name: 'Balance Emp LV', eid: 'E-LVBALANCE', active: true,
        salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 5, adjustments: [] } } },
      // Half-day scenarios (issues 16-18) -- assigned to the same Mon-Fri shift as shiftemp, so
      // Sat/Sun rest-day rejection and AM/PM segment derivation both apply. Two dedicated
      // employees so the "other half worked" and "other half not worked" paths never interfere
      // with each other's attendance/payroll state.
      { id: 7, email: 'halfworked@lv.test', pass: await passHash('halfworkedlvpass1'), role: 'employee', accessLevelId: 2, name: 'Half Worked LV', eid: 'E-LVHALFW', active: true,
        shiftId: 1, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      { id: 8, email: 'halfnotworked@lv.test', pass: await passHash('halfnotworkedlvpass1'), role: 'employee', accessLevelId: 2, name: 'Half Not Worked LV', eid: 'E-LVHALFNW', active: true,
        shiftId: 1, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      // Issue 19/20 (fractional/duplicate payroll-adjustment amounts) -- no shift assigned (every
      // calendar day counts), balance reset via direct SQL between sub-scenarios exactly like the
      // existing CB-partial pattern above.
      { id: 9, email: 'fractest@lv.test', pass: await passHash('fractestlvpass1'), role: 'employee', accessLevelId: 2, name: 'Frac Test LV', eid: 'E-LVFRAC', active: true,
        salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 0.5, adjustments: [] } } },
      // Issue 21 (attendance-response privacy) -- carries the same confidential fields as rep,
      // but with no immediateHeadEid so the existing empty-chain/leave_approve-floor authorization
      // pattern lets any of mgr/attmgr/payrollmgr/admin act on it independently, isolating each
      // sub-scenario's approver.
      { id: 10, email: 'privsubj@lv.test', pass: await passHash('privsubjlvpass1'), role: 'employee', accessLevelId: 2, name: 'Priv Subj LV', eid: 'E-LVPRIV', active: true,
        // Assigned to shift 1 (Mon-Fri 9-6) so a half-day request for this employee has a
        // resolvable schedule to split (issue 17/30) -- the privacy-scoping test below needs the
        // half-day filing itself to succeed, only the RESPONSE's field-scoping is under test here.
        shiftId: 1,
        salaryPM: 22000, rate: 1000, payGroupId: 1,
        sss: '11-2233445-6', ph: '22-334455667-8', pi: '2233-4455-6677', tin: '223-344-556-000',
        bank: 'Metrobank', bankAccount: '9988776655', leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      { id: 11, email: 'attmgr@lv.test', pass: await passHash('attmgrlvpass1'), role: 'employee', accessLevelId: 4, name: 'Att Edit Mgr LV', eid: 'E-LVATTMGR', active: true },
      { id: 12, email: 'payrollmgr@lv.test', pass: await passHash('payrollmgrlvpass1'), role: 'employee', accessLevelId: 5, name: 'Payroll Mgr LV', eid: 'E-LVPAYMGR', active: true },
      // Issue 22 (schedule snapshot) -- its own dedicated shift (id 2, identical Mon-Fri/Sat-Sun
      // shape to shift 1) so mutating its schedule mid-test can never affect shiftemp/halfworked/
      // halfnotworked, all pinned to shift 1.
      { id: 13, email: 'schedsnap@lv.test', pass: await passHash('schedsnaplvpass1'), role: 'employee', accessLevelId: 2, name: 'Sched Snap LV', eid: 'E-LVSCHEDSNAP', active: true,
        shiftId: 2, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      // Issue 23 (impossible calendar dates) -- no shift, isolated from every other balance/date test.
      { id: 14, email: 'datecheck@lv.test', pass: await passHash('datechecklvpass1'), role: 'employee', accessLevelId: 2, name: 'Date Check LV', eid: 'E-LVDATECHECK', active: true,
        salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      // Sixth-pass issue 28: NO shiftId at all -- Saturday/Sunday rest days come entirely from
      // this employee's own personalSchedule, proving half-day rest-day validation
      // (TimekeepingCore.isRestDay) is never gated behind employee.shiftId being present.
      { id: 15, email: 'personalsched@lv.test', pass: await passHash('personalschedlvpass1'), role: 'employee', accessLevelId: 2, name: 'Personal Sched LV', eid: 'E-LVPERSONAL', active: true,
        personalSchedule: {
          mon: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          tue: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          wed: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          thu: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          fri: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          sat: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' },
          sun: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' }
        },
        salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } },
      // Sixth-pass issue 29: assigned to shift 1 (Mon-Fri workdays, Sat/Sun rest), with two
      // approved schedule adjustments that each flip one date's normal designation -- 2026-12-14
      // (a normal Monday workday) becomes a rest day, and 2026-12-19 (a normal Saturday rest day)
      // becomes a work day.
      { id: 16, email: 'schedadjhalf@lv.test', pass: await passHash('schedadjhalflvpass1'), role: 'employee', accessLevelId: 2, name: 'Sched Adj Half LV', eid: 'E-LVSCHEDADJHALF', active: true,
        shiftId: 1, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } },
        scheduleAdjustments: [
          { id: 100, status: 'approved', from: '2026-12-14', to: '2026-12-14', days: [{ date: '2026-12-14', isRestDay: true }] },
          { id: 101, status: 'approved', from: '2026-12-19', to: '2026-12-19', days: [{ date: '2026-12-19', isRestDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' }] }
        ] },
      // Follow-up pass (paid/unpaid half-day) fixtures -- shift 1, dailyRate = 22000/22 = ₱1,000.
      // Issue 24: balance stays 0.25 throughout filing and approval -- a straightforward partial
      // paid/unpaid split with no balance change to revalidate.
      { id: 17, email: 'partialbalhalf@lv.test', pass: await passHash('partialbalhalflvpass1'), role: 'employee', accessLevelId: 2, name: 'Partial Bal Half LV', eid: 'E-LVPARTIALBAL', active: true,
        shiftId: 1, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 0.25, adjustments: [] } } },
      // Issue 25: balance starts at 0.5 (enough to fully cover the half-day request as filed), but
      // is drained to 0 (via direct SQL, mirroring the existing CB-* concurrent-balance pattern)
      // before approval -- final approval must revalidate to paidDays:0/unpaidDays:0.5, not the
      // stale filing-time paidDays:0.5.
      { id: 18, email: 'zerobalhalf@lv.test', pass: await passHash('zerobalhalflvpass1'), role: 'employee', accessLevelId: 2, name: 'Zero Bal Half LV', eid: 'E-LVZEROBAL', active: true,
        shiftId: 1, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 0.5, adjustments: [] } } },
      // Issue 26: plenty of balance -- dedicated purely to the stale status:'absent' normalization
      // test (a pre-existing attendance record marked 'absent' despite carrying genuinely valid
      // PM punches, predating the half-day leave filed for the same date).
      { id: 19, email: 'statusnorm@lv.test', pass: await passHash('statusnormlvpass1'), role: 'employee', accessLevelId: 2, name: 'Status Norm LV', eid: 'E-LVSTATUSNORM', active: true,
        shiftId: 1, salaryPM: 22000, payGroupId: 1, leaveBalances: { 1: { balance: 10, adjustments: [] } } }
    ],
    attendance: [], leaves: [], loans: [], payrolls: [],
    payPeriods: [
      // Covers the closed-period leave date (2026-09-05) -- payrollAlreadyClosedFor() should find
      // this and trigger a late-approval credit. Also covers the Fri-Mon eligible-date range
      // (2026-09-04 to 2026-09-07) used by the rest-day tests below.
      { id: 1, groupId: 1, from: '2026-09-01', to: '2026-09-15', attendanceFrom: '2026-09-01', attendanceTo: '2026-09-15', status: 'closed' },
      // Covers the open-period leave date (2026-10-05) -- no credit should be created for this one.
      { id: 2, groupId: 1, from: '2026-10-01', to: '2026-10-15', attendanceFrom: '2026-10-01', attendanceTo: '2026-10-15', status: 'open' }
    ],
    company: {
      name: 'Leave Finalize Co', dailyDivisor: 22,
      leaveTypes: [{ id: 1, name: 'VL', paid: true, active: true }, { id: 2, name: 'Unpaid Leave', paid: false, active: true }],
      // Mon-Fri, 9-6, with Saturday and Sunday as real configured rest days -- shiftemp (id 5) is
      // assigned here. 2026-09-04 is a Friday, 2026-09-05/06 are Sat/Sun, 2026-09-07 is a Monday.
      shifts: [{
        id: 1, name: 'Mon-Fri 9-6',
        schedule: {
          mon: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          tue: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          wed: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          thu: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          fri: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          sat: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' },
          sun: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' }
        }
      },
      // Issue 22's own dedicated shift -- identical Mon-Fri 9-6/Sat-Sun-rest shape to shift 1 at
      // seed time, mutated mid-test to make Saturday a workday, without touching shift 1 (which
      // shiftemp/halfworked/halfnotworked all still rely on elsewhere in this fixture).
      {
        id: 2, name: 'Mon-Fri 9-6 (schedule-snapshot copy)',
        schedule: {
          mon: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          tue: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          wed: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          thu: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          fri: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
          sat: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' },
          sun: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' }
        }
      }]
    },
    org: [], lookups: {}, changeRequests: [], onboarding: [], candidates: [], performance: []
  };
  await pg.query('DELETE FROM app_state WHERE tenant_key = $1', [tenantKey]);
  await pg.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3)', [tenantKey, state, 'seed']);
  await pg.query('DELETE FROM platform_clients WHERE tenant_key = $1', [tenantKey]);
  await pg.query('INSERT INTO platform_clients (tenant_key, name, admin_email, admin_pass) VALUES ($1, $2, $3, $4)', [tenantKey, 'Leave Finalize Co', 'lvcompadmin@test.local', await passHash('x')]);

  const lvPort = Number(PORT) + 21;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET, PORT: String(lvPort), APP_TENANT_KEY: tenantKey, TEST_ALLOW_LEAVE_FINALIZATION_FAULT_INJECTION: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = `http://localhost:${lvPort}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { const res = await fetch(base + '/api/health'); if (res.ok) ready = true; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 250));
  }
  const call = async (path, opts, token) => {
    const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts && opts.headers) } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const login = async (email, password) => (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).body.token;

  // Seals a real, immutable locked-payroll-run snapshot for `empId` covering `periodFrom..periodTo`
  // (period `periodId`, run `runId`, both created on first use and reused thereafter), computed
  // from WHATEVER real attendance already exists for that employee in that range at the moment
  // this is called (a virtual full-day-absence record is injected for any of `virtualAbsentDates`
  // that has no real record yet, mirroring the real app's own unapprovedCoverageDates/
  // approvedAttendanceSummary behavior for a scheduled workday nobody explained) -- exactly what a
  // real payroll run would have computed for that date BEFORE the leave being tested existed. Lets
  // every pre-existing closed-period leave-decision test in this fixture exercise the real
  // locked-payroll-delta reconciliation (issues 1-44) instead of silently degrading to
  // manual_review_required, while reproducing the exact same dollar figures those tests already
  // asserted (hand-verified: a full-day virtual-absence baseline, or a real pre-existing punch
  // pair interpreted the old non-half-day-aware way, both telescope to exactly the same numbers
  // the pre-this-pass dailyRate×fraction guess happened to produce for these specific scenarios).
  const sealHistoricalPayrollItem = async (runId, periodId, empId, periodFrom, periodTo, virtualAbsentDates) => {
    const row = await pg.query('SELECT state FROM app_state WHERE tenant_key = $1', [tenantKey]);
    const st = row.rows[0].state;
    st.payPeriods = st.payPeriods || [];
    let period = st.payPeriods.find(p => p.id === periodId);
    if (!period) { period = { id: periodId, groupId: 1, status: 'closed', runId, attendanceFrom: periodFrom, attendanceTo: periodTo }; st.payPeriods.push(period); }
    else { period.runId = runId; period.status = 'closed'; }
    st.payrolls = st.payrolls || [];
    let run = st.payrolls.find(x => x.id === runId);
    if (!run) { run = { id: runId, status: 'locked', items: [], ruleSnapshot: [] }; st.payrolls.push(run); }
    if (run.items.find(i => i.empId === empId)) { return; } // already sealed for this employee
    const emp = st.users.find(u => u.id === empId);
    const shifts = (st.company && st.company.shifts) || [];
    st.attendance = st.attendance || [];
    const covered = new Set(st.attendance.filter(a => a.eid === empId && a.date >= periodFrom && a.date <= periodTo).map(a => a.date));
    // Virtual absence dates are written into REAL state.attendance (not just used locally to build
    // the sealed snapshot) -- otherwise the corrected side's full-period recompute (issue 17) would
    // find NO record at all for an untouched date and treat it as zero absence, fabricating a
    // phantom variance for a date the leave being tested never touches. A later leave approval for
    // one of these dates correctly overwrites this placeholder via TimekeepingCore.upsert (see
    // markAttendanceForApprovedLeave), so only the actually-approved date's interpretation changes.
    let nextAttId = st.attendance.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
    (virtualAbsentDates || []).filter(d => !covered.has(d)).forEach(d => {
      st.attendance.push({ id: nextAttId++, eid: empId, date: d, status: 'absent', tin: '', tout: '', ot: 0, approvalStatus: 'approved' });
    });
    const existing = st.attendance.filter(a => a.eid === empId && a.date >= periodFrom && a.date <= periodTo);
    const summary = TimekeepingCore.periodSummary(existing, emp, periodFrom, periodTo, shifts, [], 'mon');
    const dailyDivisor = 22;
    const salaryPM = Number(emp.salaryPM) || 22000;
    const daily = salaryPM / dailyDivisor, hourly = daily / 8, minute = hourly / 60;
    run.items.push({ empId, baseBasic: salaryPM, attendanceFrom: periodFrom, attendanceTo: periodTo, rates: { daily, dailyDivisor, hourly, minute, annualWorkdays: 264 }, attendanceSummary: summary });
    await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
  };

  try {
    const adminToken = await login('admin@lv.test', 'adminlvpass1');
    const empToken = await login('emp@lv.test', 'emplvpass1');
    const mgrToken = await login('mgr@lv.test', 'mgrlvpass1');
    const repToken = await login('rep@lv.test', 'replvpass1');
    const shiftEmpToken = await login('shiftemp@lv.test', 'shiftemplvpass1');
    const halfWorkedToken = await login('halfworked@lv.test', 'halfworkedlvpass1');
    const halfNotWorkedToken = await login('halfnotworked@lv.test', 'halfnotworkedlvpass1');
    const fracTestToken = await login('fractest@lv.test', 'fractestlvpass1');
    const privSubjToken = await login('privsubj@lv.test', 'privsubjlvpass1');
    const attMgrToken = await login('attmgr@lv.test', 'attmgrlvpass1');
    const payrollMgrToken = await login('payrollmgr@lv.test', 'payrollmgrlvpass1');
    const schedSnapToken = await login('schedsnap@lv.test', 'schedsnaplvpass1');
    const dateCheckToken = await login('datecheck@lv.test', 'datechecklvpass1');
    const personalSchedToken = await login('personalsched@lv.test', 'personalschedlvpass1');
    const schedAdjHalfToken = await login('schedadjhalf@lv.test', 'schedadjhalflvpass1');
    const partialBalHalfToken = await login('partialbalhalf@lv.test', 'partialbalhalflvpass1');
    const zeroBalHalfToken = await login('zerobalhalf@lv.test', 'zerobalhalflvpass1');
    const statusNormToken = await login('statusnorm@lv.test', 'statusnormlvpass1');

    // ── Leave Integrity (server-side calculation/validation) ──────────────────────────────────
    let r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-05', endDate: '2026-09-05', reason: 'test', dayType: 'whole', days: -10, paidDays: -10, unpaidDays: -10 }) }, empToken);
    assertEqual(r.status, 200, 'LV9-setup. a request with forged negative day counts is still accepted (the forged numbers themselves are simply ignored)');
    assertEqual(r.body.record.days, 1, 'LV9. employee cannot supply days=-10 -- the server-derived value (1 working day) is used instead');
    assertEqual(r.body.record.paidDays, 1, 'LV10. employee cannot supply paidDays=999 (or any other value) -- server derives it from the actual balance');
    assertEqual(r.body.record.unpaidDays, 0, 'LV11. employee cannot supply unpaidDays=-500 -- server derives it (0, well within balance)');
    assertEqual(r.body.record.status, 'pending', 'LV13. backend creates the request as pending regardless of client payload');
    assertEqual(r.body.record.approvalLayer, 1, 'LV13b. backend assigns approvalLayer 1 regardless of client payload');
    assert(r.body.record.reviewedBy === undefined && r.body.record.approvalHistory === undefined, 'LV14. backend ignores any client-supplied reviewer/approval-history fields on filing');
    const forgedLeaveId = r.body.record.id;

    // LV12: a normal, well-formed request derives the correct day count from real calendar math
    // (this employee has no shiftId, so every calendar day counts -- 5 calendar days from a Mon to
    // a Fri inclusive).
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-11-02', endDate: '2026-11-06', reason: 'vacation', dayType: 'whole' }) }, empToken);
    assertEqual(r.status, 200, 'LV12-setup. a well-formed multi-day request is accepted');
    assertEqual(r.body.record.days, 5, 'LV12. backend derives the correct working-day count from the date range');
    const multiDayLeaveId = r.body.record.id;

    // Extra input validation beyond the enumerated list -- invalid type, backwards date range,
    // missing reason are all rejected outright (400), never silently coerced into something valid.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'Not A Real Type', startDate: '2026-09-05', endDate: '2026-09-05', reason: 'x', dayType: 'whole' }) }, empToken);
    assertEqual(r.status, 400, 'LV-extra1. an unrecognized leave type is rejected');
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-10', endDate: '2026-09-05', reason: 'x', dayType: 'whole' }) }, empToken);
    assertEqual(r.status, 400, 'LV-extra2. end date before start date is rejected');
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-05', endDate: '2026-09-05', reason: '', dayType: 'whole' }) }, empToken);
    assertEqual(r.status, 400, 'LV-extra3. a missing reason is rejected');

    // Clean up the exploratory filings above so they don't interfere with the finalization
    // scenarios below (which need a clean, known leave balance to check exact arithmetic against).
    let cur = await pg.query("SELECT state, version FROM app_state WHERE tenant_key = $1", [tenantKey]);
    let cleanState = cur.rows[0].state;
    cleanState.leaves = cleanState.leaves.filter(l => l.id !== forgedLeaveId && l.id !== multiDayLeaveId);
    await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [cleanState, tenantKey]);

    // ── Transactional Leave Side Effects ───────────────────────────────────────────────────────
    // File the real scenario leave directly via SQL (server-side calc already proven above) --
    // 1 paid day, 2026-09-05, inside the CLOSED pay period.
    const seedLeave = async (id, eid, s, e, days) => {
      const row = await pg.query("SELECT state, version FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      st.leaves.push({ id, eid, type: 'VL', s, e, reason: 'scenario', status: 'pending', filed: s, days, paidDays: days, unpaidDays: 0, dayType: 'whole', approvalLayer: 1 });
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    };
    // Seals a real locked payroll run (id 900) for period 1 (Sept 1-15, already closed in the
    // fixture) covering emp's two closed-period leave dates below -- issues 1-44's exact
    // locked-payroll-delta reconciliation now has a genuine historical snapshot to compare against,
    // instead of degrading to manual_review_required.
    await sealHistoricalPayrollItem(900, 1, 2, '2026-09-01', '2026-09-15', ['2026-09-05', '2026-09-06']);
    await seedLeave(100, 2, '2026-09-05', '2026-09-05', 1); // emp's leave, closed period

    r = await call('/api/leaves/100/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, 'TX-setup. admin approves the scenario leave');
    assertEqual(r.body.final, true, 'TX-setup2. single-layer chain finalizes immediately');

    let after = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
    let empAfter = after.rows[0].state.users.find(u => u.id === 2);
    assertEqual(empAfter.leaveBalances['1'].balance, 9, '23. final leave approval updates the leave balance (10 -> 9, 1 paid day deducted)');
    assert(empAfter.leaveBalances['1'].adjustments.length === 1, '23b. exactly one balance adjustment record was created, not applied twice');

    const attForDate = after.rows[0].state.attendance.find(a => a.eid === 2 && a.date === '2026-09-05');
    assert(!!attForDate && attForDate.status === 'leave' && attForDate.approvalStatus === 'approved' && attForDate.source === 'leave-approval', '24. final leave approval creates the correct attendance record for the approved date');

    const adjForDate = after.rows[0].state.payrollAdjustments.find(a => a.empId === 2 && a.sourceLeaveId === 100);
    assert(!!adjForDate && adjForDate.amount === 1000 && adjForDate.payItemCode === 'LEAVE_RETRO_EARNING', '25. final leave approval creates the expected locked-payroll-delta retro adjustment for a date whose pay period already closed (full-day absence deduction reversed: ₱22000/22 = ₱1000)');

    assert(r.body.employeePatch && r.body.employeePatch.leaveBalances && r.body.employeePatch.pass === undefined, '26. the decision response hands back the authoritative employeePatch/attendance/payroll results together (and never a password hash)');
    assertEqual(Object.keys(r.body.employeePatch).sort().join(','), 'id,leaveBalances', '26d. employeePatch is minimal -- only id and leaveBalances, not the full employee record');
    assert(Array.isArray(r.body.attendanceRecords) && r.body.attendanceRecords.length === 1, '26b. the same response includes the attendance record it created');
    assert(Array.isArray(r.body.payrollAdjustments) && r.body.payrollAdjustments.length === 1, '26c. the same response includes the payroll adjustment it created (admin caller, has payroll visibility)');

    // 27/28: an injected failure during finalization rolls back the ENTIRE transaction -- the
    // decision itself included. Uses a second, otherwise-identical leave so the already-approved
    // scenario above is untouched.
    await seedLeave(101, 2, '2026-09-06', '2026-09-06', 1);
    const beforeFault = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
    const empBalanceBeforeFault = beforeFault.rows[0].state.users.find(u => u.id === 2).leaveBalances['1'].balance;
    // 2026-09-06 already carries a sealed, pre-existing 'absent' baseline record (from
    // sealHistoricalPayrollItem above, needed so leave 101's own later successful approval at 28b
    // has a real locked-payroll snapshot to reconcile against) -- the rollback assertion below must
    // therefore check that this pre-existing record is UNCHANGED by the failed attempt, not that no
    // record exists at all for the date.
    const sixthAttBefore = beforeFault.rows[0].state.attendance.find(a => a.eid === 2 && a.date === '2026-09-06');
    r = await call('/api/leaves/101/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved', __testForceFinalizationFailure: true }) }, adminToken);
    assertEqual(r.status, 500, '27. an artificial failure during side-effect processing surfaces as an error, not a silent partial success');
    const afterFault = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
    const leaveAfterFault = afterFault.rows[0].state.leaves.find(l => l.id === 101);
    assertEqual(leaveAfterFault.status, 'pending', '28. a failed finalization leaves the leave request in its original (pending) status -- the decision itself rolled back too');
    assertEqual(afterFault.rows[0].state.users.find(u => u.id === 2).leaveBalances['1'].balance, empBalanceBeforeFault, '27b. the leave balance is completely unaffected by the rolled-back transaction (no partial deduction survived)');
    const sixthAttAfter = afterFault.rows[0].state.attendance.find(a => a.eid === 2 && a.date === '2026-09-06');
    assertEqual(sixthAttAfter && sixthAttAfter.status, sixthAttBefore && sixthAttBefore.status, '27c. the rolled-back transaction leaves 2026-09-06\'s attendance record exactly as it was (still the sealed absence baseline, never flipped to leave)');

    // A genuinely retried approval of the SAME leave (without the fault flag) still works normally
    // afterward -- the rollback didn't corrupt the record for a real retry.
    r = await call('/api/leaves/101/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '28b. after a rolled-back attempt, the same leave can still be approved normally on retry');

    // 29: an employee-role MANAGER's approval produces the exact same complete side effects as
    // admin's did above -- mgr approves rep's leave (rep reports to mgr, single-layer chain).
    await sealHistoricalPayrollItem(900, 1, 4, '2026-09-01', '2026-09-15', ['2026-09-07', '2026-09-08']);
    await seedLeave(102, 4, '2026-09-07', '2026-09-07', 1);
    r = await call('/api/leaves/102/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, mgrToken);
    assertEqual(r.status, 200, '29-setup. the designated (non-admin) manager can approve');
    assertEqual(r.body.final, true, '29-setup2. finalizes immediately (single layer)');
    after = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
    const repAfter = after.rows[0].state.users.find(u => u.id === 4);
    assertEqual(repAfter.leaveBalances['1'].balance, 9, '29. an employee-role manager\'s approval deducts the leave balance exactly like admin\'s does');
    const repAtt = after.rows[0].state.attendance.find(a => a.eid === 4 && a.date === '2026-09-07');
    assert(!!repAtt && repAtt.status === 'leave' && repAtt.approvalStatus === 'approved', '29b. and creates the attendance record exactly like admin\'s approval does');
    const repAdj = after.rows[0].state.payrollAdjustments.find(a => a.empId === 4 && a.sourceType === 'leave_retro_reconciliation' && a.sourceLeaveId === 102);
    assert(!!repAdj && repAdj.amount === 1000, '29c. and creates the locked-payroll retro adjustment exactly like admin\'s approval does (the sealed run had deducted a full-day absence for 09-07; now fully reversed)');
    assert(repAtt.reviewedBy === 'Mgr LV', '29d. the attendance record correctly attributes the manager as reviewer, not admin');

    // ── Issue 1/11: response authorization -- mgr (leave_approve only, no payroll permission)
    // finalized rep's leave above (r is still that decision response). The response must carry
    // rep's leaveBalances patch but never her compensation, government IDs, bank details, or the
    // raw payroll adjustment amount -- scan both the structured fields AND the serialized body so a
    // future regression that smuggles a field in elsewhere is still caught.
    const mgrDecisionBody = JSON.stringify(r.body);
    assert(r.body.employeePatch && r.body.employeePatch.leaveBalances && r.body.employeePatch.leaveBalances['1'] && r.body.employeePatch.leaveBalances['1'].balance === 9,
      '29e. the leave_approve-only manager still receives the subordinate\'s leaveBalances patch');
    assertEqual(Object.keys(r.body.employeePatch).sort().join(','), 'id,leaveBalances', '29f. employeePatch given to a leave-only manager is still exactly {id, leaveBalances}');
    assert(r.body.employeePatch.salaryPM === undefined && r.body.employeePatch.rate === undefined, '29g. employeePatch never carries salary/rate');
    assert(!mgrDecisionBody.includes('22000') && !mgrDecisionBody.includes('"rate":1000'), '29h. the raw response body never contains rep\'s monthly salary or daily rate values');
    assert(!mgrDecisionBody.includes('34-1234567-8') && !mgrDecisionBody.includes('12-345678901-2') && !mgrDecisionBody.includes('1234-5678-9012') && !mgrDecisionBody.includes('123-456-789-000'),
      '29i. the raw response body never contains rep\'s SSS/PhilHealth/Pag-IBIG/TIN');
    assert(!mgrDecisionBody.includes('BDO') && !mgrDecisionBody.includes('0012345678901'), '29j. the raw response body never contains rep\'s bank name or account number');
    assert(!mgrDecisionBody.includes('replvpass1') && !mgrDecisionBody.toLowerCase().includes('$2b$'), '29k. the raw response body never contains rep\'s password or password hash');
    assertEqual(r.body.payrollAdjustmentCreated, true, '29l. the leave-only manager still learns a payroll adjustment was created (boolean flag)');
    assertEqual(r.body.payrollAdjustmentCount, 1, '29m. and the count');
    assert(r.body.payrollAdjustments === undefined, '29n. but NOT the full payrollAdjustments array (no amount/daily-rate/period detail) -- mgr lacks the payroll permission');

    // Same finalization, but the caller (admin) DOES have payroll visibility -- full adjustment
    // detail (amount, period, everything) is included. Uses a fresh leave so it's an independent
    // finalization from 29's, still on rep, still under mgr's own decision permission path but this
    // time decided by admin to exercise the "payroll-authorized caller" branch specifically.
    await seedLeave(104, 4, '2026-09-08', '2026-09-08', 1);
    r = await call('/api/leaves/104/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '29o-setup. admin (payroll-authorized) approves another of rep\'s leaves');
    assertEqual(r.body.payrollAdjustmentCreated, true, '29o. admin caller also gets the created flag');
    assert(Array.isArray(r.body.payrollAdjustments) && r.body.payrollAdjustments.length === 1 && typeof r.body.payrollAdjustments[0].amount === 'number',
      '29p. an admin/payroll-authorized caller DOES receive full adjustment detail including amount');

    // No adjustment for an OPEN period: a leave whose date falls in the still-open October period
    // gets balance + attendance effects, but no payroll adjustment (the normal run will pick it up).
    await seedLeave(103, 2, '2026-10-05', '2026-10-05', 1);
    r = await call('/api/leaves/103/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, 'TX-open-setup. approval on an open-period date succeeds');
    assertEqual((r.body.payrollAdjustments || []).length, 0, 'TX-open. no late-approval payroll adjustment is created for a date whose pay period is still open');

    // ── Eligible-date tests: shiftemp (Mon-Fri shift, real Sat/Sun rest days) files Friday
    // (2026-09-04) through Monday (2026-09-07) ─────────────────────────────────────────────────
    const LeaveService = require('../server/leave-service.js');
    // Seals a real locked payroll run for shiftemp covering the same Sept period, with virtual
    // absence baselines on both dates this Fri-Mon request will touch -- so the retro reconciliation
    // (issues 1-44) has a genuine historical snapshot to compare against instead of degrading to
    // manual_review_required.
    await sealHistoricalPayrollItem(900, 1, 5, '2026-09-01', '2026-09-15', ['2026-09-04', '2026-09-07']);
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-04', endDate: '2026-09-07', reason: 'long weekend', dayType: 'whole' }) }, shiftEmpToken);
    assertEqual(r.status, 200, 'ED-setup. Friday-to-Monday request is accepted');
    assertEqual(r.body.record.days, 2, '10. server calculates 2 leave days for a Fri-Mon request when Sat/Sun are configured rest days');
    const shiftLeaveId = r.body.record.id;

    // 11/12/13: the exact eligible-date list, checked directly against the canonical helper --
    // Friday and Monday only, Saturday and Sunday excluded.
    const shiftEmpRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    const shiftEmployee = shiftEmpRow.users.find(u => u.id === 5);
    const eligible = LeaveService.eligibleLeaveDates(shiftEmpRow, shiftEmployee, '2026-09-04', '2026-09-07');
    assertEqual(eligible.join(','), '2026-09-04,2026-09-07', '11. eligible dates are exactly Friday and Monday');
    assert(!eligible.includes('2026-09-05'), '12. Saturday is excluded from the eligible date list');
    assert(!eligible.includes('2026-09-06'), '13. Sunday is excluded from the eligible date list');

    r = await call('/api/leaves/' + shiftLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, 'ED-approve. admin approves the Fri-Mon request');
    assertEqual(r.body.final, true, 'ED-approve2. single-layer chain finalizes immediately');

    const afterEd = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    const fridayAtt = afterEd.attendance.find(a => a.eid === 5 && a.date === '2026-09-04');
    const mondayAtt = afterEd.attendance.find(a => a.eid === 5 && a.date === '2026-09-07');
    const satAtt = afterEd.attendance.find(a => a.eid === 5 && a.date === '2026-09-05');
    const sunAtt = afterEd.attendance.find(a => a.eid === 5 && a.date === '2026-09-06');
    assert(!!fridayAtt && fridayAtt.status === 'leave', '14. attendance exists for Friday');
    assert(!!mondayAtt && mondayAtt.status === 'leave', '15. attendance exists for Monday');
    assert(!satAtt, '16. no leave attendance is created for Saturday');
    assert(!sunAtt, '17. no leave attendance is created for Sunday');

    // Issue 9: both dates (Friday + Monday) fall in the SAME locked payroll run, so they reconcile
    // together into exactly ONE retro adjustment -- never one guessed per-date credit each.
    const shiftEmpRunAdjs = afterEd.payrollAdjustments.filter(a => a.empId === 5 && a.sourceType === 'leave_retro_reconciliation' && a.sourcePayrollRunId === 900);
    assertEqual(shiftEmpRunAdjs.length, 1, '18. exactly one locked-payroll retro adjustment is created for both Friday and Monday together (same run), never one per date');
    assertEqual(shiftEmpRunAdjs[0].payItemCode, 'LEAVE_RETRO_EARNING', '18b. the adjustment is a positive earning (the sealed run had virtually deducted both dates as full-day absences)');
    assertEqual(shiftEmpRunAdjs[0].amount, 2000, '19. the adjustment is exactly the full delta -- both sealed absence deductions (₱1000 each) fully reversed since both dates are now fully paid leave, not a hardcoded per-date guess');

    // ── Concurrent/pending balance tests: balanceemp (id 6) starts at 5 ───────────────────────
    // Leave A and Leave B both filed (via direct seed, mirroring what the server itself would
    // have computed) while the balance was still 5 -- both recorded as 5 paid / 0 unpaid, exactly
    // what calculateLeaveRequest would have produced for either one filed alone at that balance.
    const seedBalanceLeave = async (id, s, e, days, paidDays, unpaidDays) => {
      const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      st.leaves.push({ id, eid: 6, type: 'VL', s, e, reason: 'concurrent-balance scenario', status: 'pending', filed: s, days, paidDays, unpaidDays, dayType: 'whole', approvalLayer: 1 });
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    };
    await seedBalanceLeave(200, '2026-11-02', '2026-11-06', 5, 5, 0); // Leave A
    await seedBalanceLeave(201, '2026-11-09', '2026-11-13', 5, 5, 0); // Leave B, same balance snapshot

    r = await call('/api/leaves/200/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, 'CB-A. Leave A approves successfully');
    let balanceRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    assertEqual(balanceRow.users.find(u => u.id === 6).leaveBalances['1'].balance, 0, '22. balance is 0 after Leave A consumes all 5 days');

    r = await call('/api/leaves/201/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, 'CB-B. Leave B still approves successfully (not blocked outright)');
    balanceRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    const balanceEmpAfterB = balanceRow.users.find(u => u.id === 6);
    assert(balanceEmpAfterB.leaveBalances['1'].balance >= 0, '23. balance never becomes negative even though Leave B was originally filed as 5 paid days against an already-exhausted balance');
    assertEqual(balanceEmpAfterB.leaveBalances['1'].balance, 0, '23b. balance is exactly 0, not negative');
    const leaveBAfter = balanceRow.leaves.find(l => l.id === 201);
    assertEqual(leaveBAfter.paidDays, 0, '24. Leave B\'s final paidDays is recalculated to 0 at approval time (current balance was already 0)');
    assertEqual(leaveBAfter.unpaidDays, 5, '25. Leave B\'s final unpaidDays is recalculated to 5');
    const leaveBAttDates = balanceRow.attendance.filter(a => a.eid === 6 && a.date >= '2026-11-09' && a.date <= '2026-11-13');
    assertEqual(leaveBAttDates.length, 5, '26. Leave B\'s attendance still reflects all 5 approved leave dates even though none of them are paid');
    const leaveBAdjustments = balanceRow.payrollAdjustments.filter(a => a.sourceType === 'leave' && a.sourceLeaveId === 201);
    assertEqual(leaveBAdjustments.length, 0, '27. no paid-leave payroll adjustment is generated for Leave B (fully unpaid after recalculation)');
    assert(!!leaveBAfter.balanceRecalculation && leaveBAfter.balanceRecalculation.originallyFiledPaidDays === 5 && leaveBAfter.balanceRecalculation.finalPaidDays === 0, '28. the leave record itself carries an auditable trace of the paid/unpaid split change');
    const auditRows28 = await pg.query("SELECT meta FROM security_audit_log WHERE tenant_key = $1 AND action = 'leave_balance_recalculated_at_approval' ORDER BY id DESC LIMIT 1", [tenantKey]);
    assert(auditRows28.rowCount === 1 && auditRows28.rows[0].meta.finalPaidDays === 0, '28b. audit log also records the paid/unpaid split change');

    // Partial-balance variant: a later top-up brings the balance to 2 (simulating some other,
    // already-applied adjustment), then a fresh 5-day request finalizes as 2 paid + 3 unpaid,
    // landing on exactly 0, never negative.
    let topUpRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    topUpRow.users.find(u => u.id === 6).leaveBalances['1'].balance = 2;
    await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [topUpRow, tenantKey]);
    await seedBalanceLeave(202, '2026-11-16', '2026-11-20', 5, 5, 0);
    r = await call('/api/leaves/202/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, 'CB-partial. the partial-balance leave approves successfully');
    const partialRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    const leave202 = partialRow.leaves.find(l => l.id === 202);
    assertEqual(leave202.paidDays, 2, 'CB-partial2. a 5-day request against a balance of 2 finalizes as 2 paid days');
    assertEqual(leave202.unpaidDays, 3, 'CB-partial3. and 3 unpaid days');
    assertEqual(partialRow.users.find(u => u.id === 6).leaveBalances['1'].balance, 0, 'CB-partial4. balance lands on exactly 0, not -3');

    // ── Duplicate payroll adjustment tests: creditLateApprovalDay tested directly, per-unit ────
    // No server/DB round trip needed -- this exercises the pure function against an in-memory
    // state, exactly as Issue 14 explicitly allows ("test the helper directly or through final
    // approval").
    {
      const unitState = { payPeriods: [{ id: 1, groupId: 1, from: '2026-09-01', to: '2026-09-15', attendanceFrom: '2026-09-01', attendanceTo: '2026-09-15', status: 'closed' }], payrollAdjustments: [] };
      const unitEmployee = { id: 999, payGroupId: 1, salaryPM: 22000 };
      const leaveA = { id: 501 }, leaveB = { id: 502 };
      let ur = LeaveService.creditLateApprovalDay(unitState, unitEmployee, leaveA, '2026-09-05', 'LEAVE_PAY', 'Test', 'Tester');
      assert(ur.created === true, '29. one eligible closed-period leave date creates one adjustment');
      ur = LeaveService.creditLateApprovalDay(unitState, unitEmployee, leaveA, '2026-09-05', 'LEAVE_PAY', 'Test', 'Tester');
      assert(ur.created === false && ur.duplicate === true, '30. attempting the same sourceLeaveId/sourceDate again does not create another adjustment');
      assertEqual(unitState.payrollAdjustments.length, 1, '30b. still only one adjustment exists after the duplicate attempt');
      ur = LeaveService.creditLateApprovalDay(unitState, unitEmployee, leaveB, '2026-09-05', 'LEAVE_PAY', 'Test', 'Tester');
      assert(ur.created === true, '31. a different leave request ID can create its own valid adjustment for the same date');
      ur = LeaveService.creditLateApprovalDay(unitState, unitEmployee, leaveA, '2026-09-06', 'LEAVE_PAY', 'Test', 'Tester');
      assert(ur.created === true, '32. a different effective date can create its own adjustment');
      assertEqual(unitState.payrollAdjustments.length, 3, '32b. three distinct adjustments now exist (A/05, B/05, A/06)');

      // ── Issues 16/17/18/19: debitClosedPeriodUnpaidLeave tested directly, per-unit -- the
      // deduction-side mirror of creditLateApprovalDay above, for a half-day date whose other half
      // WAS validly worked but carries a genuine unpaidLeaveFraction, once its pay period has
      // already closed.
      const leaveC = { id: 503 };
      let dr = LeaveService.debitClosedPeriodUnpaidLeave(unitState, unitEmployee, leaveC, '2026-09-07', 'Tester', 0.5);
      assert(dr.created === true, '32c. a closed-period unpaid-leave date creates a deduction adjustment');
      assertEqual(dr.adjustment.amount, -500, '32d. the deduction is exactly -₱500 (0.5 day × ₱1,000 daily rate), a NEGATIVE amount');
      assertEqual(dr.adjustment.payItemCode, 'UNPAID_LEAVE', '32e. the adjustment carries its own distinct payItemCode, never LEAVE_PAY');
      dr = LeaveService.debitClosedPeriodUnpaidLeave(unitState, unitEmployee, leaveC, '2026-09-07', 'Tester', 0.5);
      assert(dr.created === false && dr.duplicate === true, '32f. a retried debit for the same leave/date does not create a second deduction (idempotent)');
      assertEqual(unitState.payrollAdjustments.filter(a => a.payItemCode === 'UNPAID_LEAVE').length, 1, '32g. still only one UNPAID_LEAVE adjustment exists after the duplicate attempt');
      // An open-period date must produce no adjustment at all here -- the live payroll run
      // already deducts it from attendance.unpaidLeaveDays directly.
      const openPeriodUnitState = { payPeriods: [{ id: 2, groupId: 1, from: '2026-10-01', to: '2026-10-15', attendanceFrom: '2026-10-01', attendanceTo: '2026-10-15', status: 'open' }], payrollAdjustments: [] };
      dr = LeaveService.debitClosedPeriodUnpaidLeave(openPeriodUnitState, unitEmployee, leaveC, '2026-10-05', 'Tester', 0.5);
      assert(dr.created === false && dr.duplicate === false, '32h. an open-period date creates no adjustment at all (the live payroll run already handles it)');
      assertEqual(openPeriodUnitState.payrollAdjustments.length, 0, '32i. no adjustment was added for the open period');
    }

    // ── dayType tests ───────────────────────────────────────────────────────────────────────
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-07', endDate: '2026-12-07', reason: 'whole day test', dayType: 'whole' }) }, empToken);
    assertEqual(r.status, 200, '33. dayType: whole works');
    // Half-day requires a resolvable AM/PM schedule to split (issue 17/30) -- empToken (emp@lv.test)
    // deliberately has no shiftId (see its fixture comment above), so the half_am/half_pm "accepted"
    // tests below use shiftEmpToken (shiftemp@lv.test, shift 1, Mon-Fri 9-6) instead; a dedicated
    // no-schedule rejection test for empToken follows right after.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-08', reason: 'half am test', dayType: 'half_am' }) }, shiftEmpToken);
    assertEqual(r.status, 200, '34-setup. dayType: half_am is accepted');
    assertEqual(r.body.record.days, 0.5, '34. dayType: half_am creates a 0.5 day request');
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-09', reason: 'half pm test', dayType: 'half_pm' }) }, shiftEmpToken);
    assertEqual(r.status, 200, '35-setup. dayType: half_pm is accepted');
    assertEqual(r.body.record.days, 0.5, '35. dayType: half_pm creates a 0.5 day request');
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-10', endDate: '2026-12-10', reason: 'invalid daytype test', dayType: 'xyz' }) }, empToken);
    assertEqual(r.status, 400, '36. invalid dayType: xyz returns 400');
    const afterInvalidDayType = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    assert(!afterInvalidDayType.leaves.some(l => l.reason === 'invalid daytype test'), '37. invalid dayType does not create a leave record');

    // ── Issue 17/30: half-day leave requires a resolvable work schedule ───────────────────────
    // empToken (emp@lv.test) has no shiftId, no personalSchedule, and no schedule adjustment for
    // this date -- there is nothing to split into AM/PM halves, so this must be rejected outright
    // rather than silently assuming a split (never gated behind employee.shiftId being *present*
    // either -- this is the "absent entirely" case, distinct from the rest-day case above).
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-11', reason: 'half am, no schedule at all', dayType: 'half_am' }) }, empToken);
    assertEqual(r.status, 400, '37b. half-day leave for an employee with no resolvable schedule is rejected with 400');
    assert(/work schedule/i.test(r.body.error || ''), '37c. the rejection message explains a work schedule is required');
    const afterNoScheduleHalfDay = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    assert(!afterNoScheduleHalfDay.leaves.some(l => l.reason === 'half am, no schedule at all'), '37d. no leave record was created for the rejected no-schedule half-day request');

    // ── Issue 28: half-day rest-day validation must work from a personalSchedule alone, with no
    // employee.shiftId at all -- proves the rest-day check is never gated behind shiftId being
    // present. 2026-12-12 is a Saturday, a real configured rest day on personalsched's own
    // personalSchedule (no assigned shift whatsoever).
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-12', reason: 'half am on personal-schedule rest day', dayType: 'half_am' }) }, personalSchedToken);
    assertEqual(r.status, 400, '37e. half_am leave on a personalSchedule-only rest day is rejected with 400');
    assert(/rest day/i.test(r.body.error || ''), '37f. the rejection message explains it is a rest day, not a missing-schedule error');
    // A normal (non-rest) weekday on the same personalSchedule-only employee is accepted --
    // proves the earlier rejection was genuinely about the rest day, not about shiftId's absence.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-14', reason: 'half am on personal-schedule work day', dayType: 'half_am' }) }, personalSchedToken);
    assertEqual(r.status, 200, '37g. half_am leave on a personalSchedule-only WORK day is accepted');

    // ── Issue 29: an approved schedule adjustment overrides the normal designation in BOTH
    // directions -- turning a normal workday into a rest day, and a normal rest day into a work
    // day -- and half-day filing must respect whichever direction currently applies.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-14', reason: 'half pm, adjustment makes normal Monday a rest day', dayType: 'half_pm' }) }, schedAdjHalfToken);
    assertEqual(r.status, 400, '37h. half_pm leave is rejected on a normally-working Monday that an approved schedule adjustment turned into a rest day');
    assert(/rest day/i.test(r.body.error || ''), '37i. the rejection message explains it is a rest day');
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-19', reason: 'half am, adjustment makes normal Saturday a work day', dayType: 'half_am' }) }, schedAdjHalfToken);
    assertEqual(r.status, 200, '37j. half_am leave is accepted on a normally-rest Saturday that an approved schedule adjustment turned into a work day');

    // ── Issue 16: half-day leave cannot be filed on a scheduled rest day ──────────────────────
    // 2026-09-12/13 are a Saturday/Sunday, real rest days under shift 1 (halfworked's shift).
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-12', reason: 'half am on saturday', dayType: 'half_am' }) }, halfWorkedToken);
    assertEqual(r.status, 400, '38. half_am leave on a Saturday (rest day) is rejected with 400');
    assert(/rest day/i.test(r.body.error || ''), '38b. the rejection message explains it is a rest day');
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-13', reason: 'half pm on sunday', dayType: 'half_pm' }) }, halfWorkedToken);
    assertEqual(r.status, 400, '39. half_pm leave on a Sunday (rest day) is rejected with 400');
    const afterRestDayHalfDay = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    assert(!afterRestDayHalfDay.leaves.some(l => l.eid === 7 && (l.s === '2026-09-12' || l.s === '2026-09-13')), '40. no leave record was created for either rejected rest-day half-day request');

    // ── Issue 17: half-day paid leave + valid other-half work = full payable day, but only 0.5
    // leave credit is consumed -- never converted into a full-day leave ────────────────────────
    // Seed the PM punches BEFORE filing, mirroring the real order of events: the employee actually
    // worked the afternoon, then files for the morning off.
    {
      const row = await pg.query("SELECT state, version FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      st.attendance.push({ id: 900, eid: 7, date: '2026-09-08', tin: '13:05', tout: '18:00', status: 'present', ot: 0, nd: 0, notes: '', punches: [], active: true });
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    }
    // Seals a locked payroll run from the REAL PM-only punches just seeded above (no leave has been
    // approved yet, so the sealed snapshot reproduces the exact pre-existing bug this whole pass
    // fixes: the punches get misread against the FULL shift, not the eventual half-day segment,
    // producing a large bogus LATE deduction) -- an empty virtualAbsentDates array since real
    // attendance already covers the date.
    await sealHistoricalPayrollItem(900, 1, 7, '2026-09-01', '2026-09-15', []);
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-08', reason: 'half am, worked pm', dayType: 'half_am' }) }, halfWorkedToken);
    assertEqual(r.status, 200, '41-setup. half_am leave with pre-existing PM punches is accepted');
    assertEqual(r.body.record.days, 0.5, '41. half-day leave.days is 0.5, never converted to a full day');
    const halfWorkedLeaveId = r.body.record.id;
    r = await call('/api/leaves/' + halfWorkedLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '42-setup. admin approves the half_am (worked PM) request');
    assertEqual(r.body.final, true, '42-setup2. single-layer chain finalizes immediately');
    let afterHW = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    let hwAtt = afterHW.attendance.find(a => a.eid === 7 && a.date === '2026-09-08');
    assertEqual(hwAtt.tin, '13:05', '42. the real PM Time In is preserved, never erased');
    assertEqual(hwAtt.tout, '18:00', '43. the real PM Time Out is preserved, never erased');
    assert(hwAtt.status !== 'absent', '44. attendance status is never forced to absent when the other half was genuinely worked');
    assertEqual(hwAtt.leaveFraction, 0.5, '45. attendance carries leaveFraction:0.5, not a full day');
    assertEqual(hwAtt.leaveDayType, 'half_am', '46. attendance carries the half-day type');
    let hwEmp = afterHW.users.find(u => u.id === 7);
    assertEqual(hwEmp.leaveBalances['1'].balance, 9.5, '47. exactly 0.5 leave credit is deducted, not a full day');
    let hwAdj = afterHW.payrollAdjustments.find(a => a.sourceType === 'leave_retro_reconciliation' && a.sourceLeaveId === halfWorkedLeaveId);
    assert(!!hwAdj, '48. a locked-payroll retro adjustment is created for the leave (period already closed)');
    assertEqual(hwAdj.payItemCode, 'LEAVE_RETRO_EARNING', '48b. the adjustment is a positive earning');
    assertEqual(hwAdj.amount, 500, '49. the adjustment is exactly the real delta -- the sealed run had misread the PM punches against the full shift (large bogus late deduction); the corrected recompute reads them against the half-day PM segment instead, recovering exactly the omitted AM half\'s worth of pay (₱500), never a full ₱1000 and never a naive dailyRate×fraction guess');

    // ── Issue 18: half-day paid leave WITHOUT valid other-half work -- only 0.5 is paid, no
    // automatic extra 0.5, whether the pay period is closed OR still open ─────────────────────────
    await sealHistoricalPayrollItem(900, 1, 8, '2026-09-01', '2026-09-15', ['2026-09-09']);
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-09', reason: 'half am, no pm work', dayType: 'half_am' }) }, halfNotWorkedToken);
    assertEqual(r.status, 200, '50-setup. half_am leave with no PM attendance at all is accepted');
    const halfNotWorkedLeaveId = r.body.record.id;
    r = await call('/api/leaves/' + halfNotWorkedLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '51-setup. admin approves the half_am (no PM work) request -- closed period');
    let afterHNW = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    let hnwAtt = afterHNW.attendance.find(a => a.eid === 8 && a.date === '2026-09-09');
    assertEqual(hnwAtt.status, 'absent', '51. with no valid other-half work, the date is marked absent -- the existing (unmodified) absence-deduction rules apply, no new paid concept is invented');
    assertEqual(hnwAtt.leaveFraction, 0.5, '52. attendance still records the legitimate 0.5 leave via metadata');
    let hnwEmp = afterHNW.users.find(u => u.id === 8);
    assertEqual(hnwEmp.leaveBalances['1'].balance, 9.5, '53. exactly 0.5 leave credit is deducted, matching the leave portion actually granted');
    let hnwAdj = afterHNW.payrollAdjustments.find(a => a.sourceType === 'leave_retro_reconciliation' && a.sourceLeaveId === halfNotWorkedLeaveId);
    assert(!!hnwAdj, '54. the 0.5 leave portion is still credited via the locked-payroll retro adjustment (closed period)');
    assertEqual(hnwAdj.amount, 500, '55. only ₱500 (0.5 day) is credited, never a full ₱1000 -- the sealed run had deducted a full-day absence (₱1000); the corrected recompute still deducts the uncovered PM half (absentWorkFraction 0.5, ₱500), so the exact delta recovered is ₱500, never the other half automatically paid');

    // Same shape, on a date whose pay period is still OPEN -- without a positive credit here, the
    // open period's own future run would deduct the WHOLE day (status:'absent') for what was
    // actually a half-approved leave; crediting the 0.5 leave portion regardless of period status
    // is what nets out to the correct "0.5 paid + 0.5 absent/unpaid" via the existing, unmodified
    // absence-deduction formula.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-10-06', reason: 'half pm, no am work, open period', dayType: 'half_pm' }) }, halfNotWorkedToken);
    assertEqual(r.status, 200, '56-setup. half_pm leave with no AM attendance, open-period date, is accepted');
    const halfNotWorkedOpenLeaveId = r.body.record.id;
    r = await call('/api/leaves/' + halfNotWorkedOpenLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '56. admin approves the half_pm (no AM work) request -- open period');
    let afterHNWOpen = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    let hnwOpenAtt = afterHNWOpen.attendance.find(a => a.eid === 8 && a.date === '2026-10-06');
    assertEqual(hnwOpenAtt.status, 'absent', '57. still marked absent for the uncovered half even though the period is open');
    let hnwOpenAdj = afterHNWOpen.payrollAdjustments.find(a => a.sourceType === 'leave' && a.sourceLeaveId === halfNotWorkedOpenLeaveId && a.sourceDate === '2026-10-06');
    assert(!!hnwOpenAdj, '58. the 0.5 leave portion is credited even though the pay period is still open');
    assertEqual(hnwOpenAdj.amount, 500, '59. still exactly ₱500, never a full ₱1000');

    // ── Issue 19/20: fractional and duplicate/legacy-mismatch payroll-adjustment handling ────────
    {
      const seedFracLeave = async (id, s, e, days) => {
        const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
        const st = row.rows[0].state;
        // Deliberately no leaveAllocation -- exercises the legacy-derivation path (issue 14) at
        // the same time as the fractional-payroll fix (issues 1/9/19).
        st.leaves.push({ id, eid: 9, type: 'VL', s, e, reason: 'fraction test', status: 'pending', filed: s, days, paidDays: days, unpaidDays: 0, dayType: 'whole', approvalLayer: 1 });
        await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
      };
      const setFracBalance = async balance => {
        const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
        const st = row.rows[0].state;
        st.users.find(u => u.id === 9).leaveBalances['1'].balance = balance;
        await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
      };

      // Seals ONE locked payroll run covering every date this block's leaves will touch (including
      // 09-12, used further below for the idempotency check) -- issue 9/10: multiple leaves against
      // the SAME run must each reconcile against the SAME frozen original snapshot, netting out
      // whatever a PRIOR leave already corrected (priorAppliedVarianceForRun), never re-deriving the
      // full delta from scratch a second time.
      await sealHistoricalPayrollItem(900, 1, 9, '2026-09-01', '2026-09-15', ['2026-09-05', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-14', '2026-09-15']);

      // 0.5 paid day (balance-limited) -> exactly ₱500, not ₱1000.
      await setFracBalance(0.5);
      await seedFracLeave(600, '2026-09-05', '2026-09-05', 1);
      r = await call('/api/leaves/600/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
      assertEqual(r.status, 200, '60-setup. 0.5-paid-day leave (balance-limited) approves successfully');
      let afterFrac = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
      let fracAdjs = afterFrac.payrollAdjustments.filter(a => a.sourceLeaveId === 600 && a.sourceType === 'leave_retro_reconciliation');
      assertEqual(fracAdjs.length, 1, '60. exactly one locked-payroll retro adjustment is created for a single 0.5-day date');
      assertEqual(fracAdjs[0].amount, 500, '61. a 0.5 paid day recovers exactly ₱500 of the sealed run\'s full-day absence deduction, not a full ₱1000 -- the exact delta, not a hardcoded fraction guess');
      const leave600 = afterFrac.leaves.find(l => l.id === 600);
      assertEqual(leave600.allocationDerivedAtApproval, true, '61b. the legacy record (no leaveAllocation at filing) had one derived and persisted at approval');

      // 1.5 paid days across 2 eligible dates, SAME locked run as leave 600 above -- issue 9: both
      // dates reconcile together into ONE adjustment (never one per date), and issue 21's
      // priorAppliedVarianceForRun nets out leave 600's already-applied +₱500 so this adjustment is
      // exactly the REMAINING delta (+₱1500), not the full period-wide correction re-derived from
      // scratch a second time.
      await setFracBalance(1.5);
      await seedFracLeave(601, '2026-09-10', '2026-09-11', 2);
      r = await call('/api/leaves/601/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
      assertEqual(r.status, 200, '62-setup. 1.5-paid-day leave across 2 dates approves successfully');
      afterFrac = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
      fracAdjs = afterFrac.payrollAdjustments.filter(a => a.sourceLeaveId === 601 && a.sourceType === 'leave_retro_reconciliation');
      assertEqual(fracAdjs.length, 1, '62. exactly one adjustment covers BOTH dates together (same locked run), never one per date');
      assertEqual(fracAdjs[0].amount, 1500, '63. the adjustment is exactly ₱1500 -- day 1\'s full ₱1000 plus day 2\'s remaining ₱500 credited, not a naive per-date guess, and not double-counting leave 600\'s already-applied correction against the same run');

      // 2 full paid days -- whole-number behavior unchanged -- SAME run again, remaining delta.
      await setFracBalance(2);
      await seedFracLeave(602, '2026-09-14', '2026-09-15', 2);
      r = await call('/api/leaves/602/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
      assertEqual(r.status, 200, '66-setup. 2 full paid days across 2 dates approves successfully');
      afterFrac = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
      fracAdjs = afterFrac.payrollAdjustments.filter(a => a.sourceLeaveId === 602 && a.sourceType === 'leave_retro_reconciliation');
      assertEqual(fracAdjs.length, 1, '66-setup2. exactly one adjustment covers both remaining dates together');
      assertEqual(fracAdjs[0].amount, 2000, '66. 2 full paid days still recover exactly ₱2000 of sealed absence deduction -- whole-day behavior is unchanged, and this is still the exact remaining delta against the same run (₱6000 sealed total − ₱500 − ₱1500 already applied = ₱2000 left owed)');

      // ── Issue 21/38: idempotency -- reconciling the SAME leave against the SAME locked run twice
      // must create at most one reconciliation record and one adjustment; the second call returns
      // the existing result untouched, never a duplicate. Exercised directly against the module
      // (mirroring the existing direct creditLateApprovalDay/debitClosedPeriodUnpaidLeave unit tests
      // above) using the SAME sealed run/state this block already built, on the still-untouched
      // 2026-09-12 date -- this replaces the old, now architecturally obsolete "stale sourceType:
      // 'leave' adjustment mismatch" test, since idempotency now lives in state.leaveRetroReconciliations
      // keyed by (sourceType, sourceLeaveId, sourcePayrollRunId, empId), not the old payrollAdjustments
      // sourceType:'leave' shape.
      const LeavePayrollReconciliation = require('../server/leave-payroll-reconciliation.js');
      await setFracBalance(10);
      {
        const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
        const st = row.rows[0].state;
        const emp9 = st.users.find(u => u.id === 9);
        const leaveRecord = { id: 603, type: 'VL' };
        // Mirrors what the real finalizeLeaveApproval flow does BEFORE ever calling the
        // reconciliation module: markAttendanceForApprovedLeave already stamped this leave's final
        // approved metadata onto state.attendance for 09-12 (fully paid whole day) -- reconciliation
        // itself never touches attendance, only reads it, so this unit test stamps the exact same
        // shape by hand rather than re-running the whole approval pipeline.
        const virt912 = st.attendance.find(a => a.eid === 9 && a.date === '2026-09-12');
        Object.assign(virt912, { status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
        const first = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp9, leaveRecord, ['2026-09-12'], 'Tester');
        assertEqual(first.reconciliations.length, 1, '67-setup. one reconciliation is produced for the one closed date');
        assertEqual(first.reconciliations[0].status, 'adjustment_created', '67. a real adjustment is created (09-12 is still sealed as a full-day absence, no leave has touched it before)');
        const adjCountAfterFirst = st.payrollAdjustments.filter(a => a.sourceLeaveId === 603).length;
        assertEqual(adjCountAfterFirst, 1, '67b. exactly one payroll adjustment now exists for leave 603');
        const second = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp9, leaveRecord, ['2026-09-12'], 'Tester');
        assertEqual(second.reconciliations.length, 1, '68. a second reconciliation attempt for the exact same leave/run/employee returns the existing result, not a new one');
        assert(second.reconciliations[0].duplicate === true, '68b. the second result is explicitly flagged as a duplicate');
        assertEqual(second.reconciliations[0].id, first.reconciliations[0].id, '68c. it is the SAME reconciliation record (by id), not a freshly recomputed one');
        assertEqual(st.payrollAdjustments.filter(a => a.sourceLeaveId === 603).length, 1, '69. still only one payroll adjustment exists after the duplicate attempt -- never silently doubled');
      }
    }

    // ── Issue 21: attendance-response privacy scoping ─────────────────────────────────────────
    // Explicit ids well clear of the auto-increment range (which by now has already passed 600s
    // from the fractional-payroll block above, and keeps climbing with every real POST /api/leaves
    // filed in this same block) -- avoids a duplicate-id collision between a manually seeded
    // record and one the server auto-assigns.
    const seedPrivLeave = async (id, s, e) => {
      const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      st.leaves.push({ id, eid: 10, type: 'VL', s, e, reason: 'privacy test', status: 'pending', filed: s, days: 1, paidDays: 1, unpaidDays: 0, dayType: 'whole', approvalLayer: 1 });
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    };
    // leave_approve only (mgr) -- must NOT receive raw attendance detail.
    await seedPrivLeave(7700, '2026-09-08', '2026-09-08');
    r = await call('/api/leaves/7700/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, mgrToken);
    assertEqual(r.status, 200, "70-setup. mgr (leave_approve only) approves privsubj's leave");
    assert(r.body.attendanceRecords === undefined, '70. leave_approve-only manager does NOT receive full attendanceRecords');
    assertEqual(r.body.attendanceUpdated, true, '71. attendanceUpdated flag is still true');
    assert(Array.isArray(r.body.attendanceDates) && r.body.attendanceDates.includes('2026-09-08'), '72. attendanceDates still tells the approver which date(s) were touched');
    assert(Array.isArray(r.body.attendancePatches) && r.body.attendancePatches.length === 1, '73. attendancePatches carries the safe per-record projection');
    // This is a whole-day leave, so leaveFraction/leaveDayType/paidLeaveFraction/
    // unpaidLeaveFraction/absentWorkFraction are all undefined and JSON.stringify drops them
    // entirely over the wire -- the allowed-fields check still holds (every key present is one of
    // the safe nine), just with the half-day-only ones naturally absent here.
    const allowedPatchKeys = new Set(['id', 'eid', 'date', 'status', 'leaveFraction', 'leaveDayType', 'paidLeaveFraction', 'unpaidLeaveFraction', 'absentWorkFraction']);
    assert(Object.keys(r.body.attendancePatches[0]).every(k => allowedPatchKeys.has(k)), '74. the safe patch only ever contains keys from the allowed set -- no more');
    const privRaw = JSON.stringify(r.body);
    assert(!privRaw.includes('"tin"') && !privRaw.includes('"tout"') && !privRaw.includes('"punches"') && !/"ot":/.test(privRaw) && !/"nd":/.test(privRaw) && !privRaw.includes('undertimeMinutes') && !privRaw.includes('"edits"'),
      '75. the raw response body never contains tin/tout/punches/ot/nd/undertimeMinutes/edits');

    // att_edit (no admin, no payroll) -- DOES receive full attendance detail.
    await seedPrivLeave(7701, '2026-09-09', '2026-09-09');
    r = await call('/api/leaves/7701/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, attMgrToken);
    assertEqual(r.status, 200, "76-setup. attmgr (att_edit) approves privsubj's leave");
    assert(Array.isArray(r.body.attendanceRecords) && r.body.attendanceRecords.length === 1, '76. a caller with att_edit DOES receive full attendanceRecords');
    assert('tin' in r.body.attendanceRecords[0] && 'tout' in r.body.attendanceRecords[0], '77. the full record includes tin/tout fields');

    // payroll (no admin, no att_edit) -- ALSO receives full attendance detail.
    await seedPrivLeave(7702, '2026-09-10', '2026-09-10');
    r = await call('/api/leaves/7702/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, payrollMgrToken);
    assertEqual(r.status, 200, "78-setup. payrollmgr (payroll) approves privsubj's leave");
    assert(Array.isArray(r.body.attendanceRecords) && r.body.attendanceRecords.length === 1, '78. a caller with payroll permission also receives full attendanceRecords');

    // admin -- unchanged.
    await seedPrivLeave(7703, '2026-09-11', '2026-09-11');
    r = await call('/api/leaves/7703/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, "79-setup. admin approves privsubj's leave");
    assert(Array.isArray(r.body.attendanceRecords), '79. admin still receives full attendanceRecords');

    // Half-day leave for the same privacy-scoped subject, filed and auto-assigned an id by the
    // real endpoint (safe now that every manually-seeded 77xx id above already exists, so the
    // server's own next-id counter can never collide with one of them) -- leaveFraction/
    // leaveDayType ARE present this time (privsubj has shift 1 but no PM punches on file, so the
    // "other half" is correctly evaluated as not worked, but the metadata itself is still
    // populated), still never with tin/tout/punches.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-16', reason: 'half day privacy check', dayType: 'half_am' }) }, privSubjToken);
    assertEqual(r.status, 200, "79b-setup. privsubj files a half_am request");
    const privHalfLeaveId = r.body.record.id;
    r = await call('/api/leaves/' + privHalfLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, mgrToken);
    assertEqual(r.status, 200, "79b-setup2. mgr approves the half-day request");
    assertEqual(r.body.attendancePatches[0].leaveFraction, 0.5, '79b. the safe patch DOES include leaveFraction for a half-day record');
    assertEqual(r.body.attendancePatches[0].leaveDayType, 'half_am', '79c. and leaveDayType, without ever including tin/tout/punches');
    // Issue 28: paidLeaveFraction/unpaidLeaveFraction/absentWorkFraction are leave-workflow
    // metadata (how much of the leave itself is paid vs. unpaid), safe for the same leave_approve-
    // only audience as leaveFraction/leaveDayType already were -- but the response must still never
    // carry an actual PESO amount, salary, or daily rate.
    assertEqual(r.body.attendancePatches[0].paidLeaveFraction, 0.5, '79d. the safe patch includes paidLeaveFraction (privsubj is fully paid, no PM work -- 0.5 paid)');
    assertEqual(r.body.attendancePatches[0].unpaidLeaveFraction, 0, '79e. and unpaidLeaveFraction (0, since this leave is fully paid)');
    assertEqual(r.body.attendancePatches[0].absentWorkFraction, 0.5, '79f. and absentWorkFraction (0.5 -- the PM work half, not the leave half, is what is absent)');
    const privHalfPatchKeys = new Set(['id', 'eid', 'date', 'status', 'leaveFraction', 'leaveDayType', 'paidLeaveFraction', 'unpaidLeaveFraction', 'absentWorkFraction']);
    assert(Object.keys(r.body.attendancePatches[0]).every(k => privHalfPatchKeys.has(k)), '79g. the half-day safe patch still only ever contains keys from the allowed set');
    const privHalfRaw = JSON.stringify(r.body);
    assert(!/"salaryPM"|"dailyRate"|"rate":\s*\d/.test(privHalfRaw) && !privHalfRaw.includes('payrollAdjustments'), '79h. the raw response body never contains salary, daily rate, or payroll-adjustment amounts');

    // ── Issue 22: leave date allocation is frozen at filing, immune to a later schedule change ──
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-09-04', endDate: '2026-09-07', reason: 'schedule snapshot test', dayType: 'whole' }) }, schedSnapToken);
    assertEqual(r.status, 200, '80-setup. schedsnap files a Friday-Monday whole-day request under shift 2 (Sat/Sun rest)');
    assertEqual(r.body.record.days, 2, '80. 2 days computed at filing time (Sat/Sun excluded)');
    assertEqual((r.body.record.leaveAllocation || []).map(a => a.date).join(','), '2026-09-04,2026-09-07', '81. the filed allocation is frozen to exactly Friday and Monday');
    const schedSnapLeaveId = r.body.record.id;
    // Change shift 2's schedule so Saturday becomes a normal workday -- simulates HR editing the
    // shift template AFTER this request was filed but BEFORE it's approved.
    {
      const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      const shift2 = st.company.shifts.find(s => s.id === 2);
      shift2.schedule.sat = { restDay: false, start: '09:00', end: '13:00', breakStart: '', breakEnd: '' };
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    }
    r = await call('/api/leaves/' + schedSnapLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '82-setup. admin approves after the schedule changed');
    const afterSchedSnap = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    const schedSnapAttDates = afterSchedSnap.attendance.filter(a => a.eid === 13).map(a => a.date).sort();
    assertEqual(schedSnapAttDates.join(','), '2026-09-04,2026-09-07', '82. finalization still only touches Friday and Monday -- Saturday (now a workday) was never silently added');
    const schedSnapEmp = afterSchedSnap.users.find(u => u.id === 13);
    assertEqual(schedSnapEmp.leaveBalances['1'].balance, 8, '83. balance deduction remains consistent with the originally-filed 2-day request (10 -> 8), not 3');
    const auditDrift = await pg.query("SELECT meta FROM security_audit_log WHERE tenant_key = $1 AND action = 'schedule_changed_after_leave_filing' AND target = $2 ORDER BY id DESC LIMIT 1", [tenantKey, String(schedSnapLeaveId)]);
    assertEqual(auditDrift.rowCount, 1, '84. a schedule-changed-since-filing audit event was recorded for visibility (the frozen allocation is still what was actually used)');

    // ── Issue 23: impossible calendar dates are rejected, not just regex-shaped ones ──────────
    const badDates = ['2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10'];
    for (const bad of badDates) {
      r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: bad, endDate: bad, reason: 'bad date test', dayType: 'whole' }) }, dateCheckToken);
      assertEqual(r.status, 400, `85. impossible calendar date ${bad} is rejected with 400`);
    }
    const afterBadDates = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    assert(!afterBadDates.leaves.some(l => l.eid === 14), '86. none of the impossible-date requests created a leave record');
    const auditBadDate = await pg.query("SELECT COUNT(*)::int AS c FROM security_audit_log WHERE tenant_key = $1 AND action = 'invalid_calendar_date_rejected'", [tenantKey]);
    assert(auditBadDate.rows[0].c >= badDates.length, '87. each impossible-date rejection is audited');
    // A genuinely valid leap-year date is still accepted.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2028-02-29', endDate: '2028-02-29', reason: 'valid leap date', dayType: 'whole', acknowledgeShortfall: true }) }, dateCheckToken);
    assertEqual(r.status, 200, '88. a genuinely valid leap-year date (2028-02-29) is accepted');

    // ── Issue 24: real approval-flow integration -- partial paid/unpaid half-day, no balance
    // change between filing and approval, end to end through the actual /api/leaves and
    // /api/leaves/:id/decision endpoints, with the resulting payroll figure computed the same way
    // the real payroll preview does (TimekeepingCore.periodSummary() -> PayrollRuleEngine.calculate()).
    {
      const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      st.attendance.push({ id: 950, eid: 17, date: '2026-12-21', tin: '13:00', tout: '18:00', status: 'present', ot: 0, nd: 0, notes: '', punches: [], active: true });
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    }
    // 2026-12-21 is a Monday, a genuine scheduled workday.
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-21', reason: 'partial balance half am', dayType: 'half_am' }) }, partialBalHalfToken);
    assertEqual(r.status, 409, '89-setup. filing 0.5 against a 0.25 balance needs shortfall acknowledgment');
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-21', reason: 'partial balance half am', dayType: 'half_am', acknowledgeShortfall: true }) }, partialBalHalfToken);
    assertEqual(r.status, 200, '89. partial-balance half_am filing is accepted with acknowledgeShortfall');
    assertEqual(r.body.record.paidDays, 0.25, '89b. filed paidDays is 0.25 (the full 0.25 balance)');
    assertEqual(r.body.record.unpaidDays, 0.25, '89c. filed unpaidDays is the remaining 0.25');
    const partialBalLeaveId = r.body.record.id;
    r = await call('/api/leaves/' + partialBalLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '90. admin approves the partial-balance half_am request');
    let pbRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    const pbLeave = pbRow.leaves.find(l => l.id === partialBalLeaveId);
    assertEqual(pbLeave.paidDays, 0.25, '91. final paidDays remains 0.25 (balance never changed)');
    assertEqual(pbLeave.unpaidDays, 0.25, '92. final unpaidDays remains 0.25');
    let pbAtt = pbRow.attendance.find(a => a.eid === 17 && a.date === '2026-12-21');
    assertEqual(pbAtt.leaveFraction, 0.5, '93. attendance leaveFraction is 0.5');
    assertEqual(pbAtt.paidLeaveFraction, 0.25, '94. attendance paidLeaveFraction is 0.25, from the FINAL approval split');
    assertEqual(pbAtt.unpaidLeaveFraction, 0.25, '95. attendance unpaidLeaveFraction is 0.25');
    assertEqual(pbAtt.absentWorkFraction, 0, '96. absentWorkFraction is 0 -- the PM half was genuinely worked');
    assertEqual(pbAtt.tin, '13:00', '97. actual Time In is untouched');
    assertEqual(pbAtt.tout, '18:00', '98. actual Time Out is untouched');
    const pbEmp = pbRow.users.find(u => u.id === 17);
    const pbSummary = TimekeepingCore.periodSummary(pbRow.attendance, pbEmp, '2026-12-21', '2026-12-21', pbRow.company.shifts, [], 'mon');
    assertEqual(pbSummary.unpaidLeaveDays, 0.25, '99. periodSummary reports unpaidLeaveDays 0.25');
    assertEqual(pbSummary.lateMinutes, 0, '100. periodSummary reports zero late minutes');
    assertEqual(pbSummary.undertimeMinutes, 0, '101. periodSummary reports zero undertime minutes');
    assertEqual(pbSummary.absentDays, 0, '102. periodSummary reports zero absent days');
    const pbPayroll = PayrollRuleEngine.calculate({
      employee: pbEmp, group: { code: 'MNTH', freq: 'monthly', taxMethod: 'monthly', statutoryTiming: 'every-cutoff' },
      period: { from: '2026-12-01', to: '2026-12-31', cutoff1: true, cutoff2: true }, rules: [], baseBasic: 22000, defaultDivisor: 22,
      attendance: pbSummary, adjustments: [], loans: [], statutory: () => ({ sssEE: 0, sssER: 0, phEE: 0, phER: 0, piEE: 0, piER: 0 }), tax: () => 0
    });
    assertEqual(pbPayroll.attendanceDeduction, 250, '103. payroll preview produces exactly ₱250 unpaid-leave deduction on a ₱1,000 daily rate');
    assert(!pbPayroll.lines.some(l => l.code === 'ABSENT'), '104. no full absence deduction');
    assert(!pbPayroll.lines.some(l => l.code === 'LATE' || l.code === 'UNDERTIME'), '105. no late/undertime deduction');

    // ── Issue 25: zero-balance-at-approval integration -- balance drops to 0 between filing and
    // approval; the leave half must convert entirely to unpaid, and payroll must deduct the full
    // 0.5-day unpaid-leave amount, NOT zero.
    {
      const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      st.attendance.push({ id: 951, eid: 18, date: '2026-12-22', tin: '13:00', tout: '18:00', status: 'present', ot: 0, nd: 0, notes: '', punches: [], active: true });
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    }
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-22', reason: 'zero balance half am', dayType: 'half_am' }) }, zeroBalHalfToken);
    assertEqual(r.status, 200, '106. zero-balance-employee half_am filing is accepted while balance still covers it (0.5 available)');
    assertEqual(r.body.record.paidDays, 0.5, '106b. filed paidDays is 0.5 (full balance covers it at filing time)');
    const zeroBalLeaveId = r.body.record.id;
    // Drain the balance to 0 between filing and approval (mirrors the existing CB-* pattern).
    let drainRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    drainRow.users.find(u => u.id === 18).leaveBalances['1'].balance = 0;
    await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [drainRow, tenantKey]);
    r = await call('/api/leaves/' + zeroBalLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '107. admin approves the now-zero-balance half_am request');
    let zbRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    const zbLeave = zbRow.leaves.find(l => l.id === zeroBalLeaveId);
    assertEqual(zbLeave.paidDays, 0, '108. final paidDays is revalidated to 0 (balance dropped to 0 before approval)');
    assertEqual(zbLeave.unpaidDays, 0.5, '109. final unpaidDays is revalidated to the full 0.5');
    let zbAtt = zbRow.attendance.find(a => a.eid === 18 && a.date === '2026-12-22');
    assertEqual(zbAtt.paidLeaveFraction, 0, '110. attendance paidLeaveFraction is 0, not the stale filing-time 0.5');
    assertEqual(zbAtt.unpaidLeaveFraction, 0.5, '111. attendance unpaidLeaveFraction is the full 0.5');
    assertEqual(zbAtt.absentWorkFraction, 0, '112. absentWorkFraction is 0 -- the PM half was genuinely worked');
    const zbEmp = zbRow.users.find(u => u.id === 18);
    const zbSummary = TimekeepingCore.periodSummary(zbRow.attendance, zbEmp, '2026-12-22', '2026-12-22', zbRow.company.shifts, [], 'mon');
    assertEqual(zbSummary.unpaidLeaveDays, 0.5, '113. periodSummary reports unpaidLeaveDays 0.5');
    const zbPayroll = PayrollRuleEngine.calculate({
      employee: zbEmp, group: { code: 'MNTH', freq: 'monthly', taxMethod: 'monthly', statutoryTiming: 'every-cutoff' },
      period: { from: '2026-12-01', to: '2026-12-31', cutoff1: true, cutoff2: true }, rules: [], baseBasic: 22000, defaultDivisor: 22,
      attendance: zbSummary, adjustments: [], loans: [], statutory: () => ({ sssEE: 0, sssER: 0, phEE: 0, phER: 0, piEE: 0, piER: 0 }), tax: () => 0
    });
    assertEqual(zbPayroll.attendanceDeduction, 500, '114. payroll deducts the full ₱500 unpaid-leave amount, NOT zero');

    // ── Issue 26: attendance-status normalization -- a pre-existing record already marked
    // 'absent' (e.g. from an earlier missed-punch sweep) despite carrying genuinely valid PM
    // punches, predating a half-day leave later filed and approved for the same date. The final
    // record must no longer act as a full-day absence.
    {
      const row = await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey]);
      const st = row.rows[0].state;
      st.attendance.push({ id: 952, eid: 19, date: '2026-12-23', tin: '13:00', tout: '18:00', status: 'absent', ot: 0, nd: 0, notes: 'Missed AM punch sweep', punches: [], active: true });
      await pg.query('UPDATE app_state SET state = $1, version = version + 1 WHERE tenant_key = $2', [st, tenantKey]);
    }
    r = await call('/api/leaves', { method: 'POST', body: JSON.stringify({ type: 'VL', startDate: '2026-12-23', reason: 'status normalization', dayType: 'half_am' }) }, statusNormToken);
    assertEqual(r.status, 200, '115. half_am filing over a stale-absent record with valid PM punches is accepted');
    const statusNormLeaveId = r.body.record.id;
    r = await call('/api/leaves/' + statusNormLeaveId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, adminToken);
    assertEqual(r.status, 200, '116. admin approves the status-normalization request');
    let snRow = (await pg.query("SELECT state FROM app_state WHERE tenant_key = $1", [tenantKey])).rows[0].state;
    let snAtt = snRow.attendance.find(a => a.eid === 19 && a.date === '2026-12-23');
    assertEqual(snAtt.status, 'present', "117. the stale 'absent' status is normalized to 'present' now that the PM half is confirmed validly worked");
    assertEqual(snAtt.absentWorkFraction, 0, '118. absentWorkFraction is 0');
    assert(Array.isArray(snAtt.edits) && snAtt.edits.some(e => e.changes && e.changes.status), '119. the status change itself is captured in the record\'s own audit/edit trail');
    const snEmp = snRow.users.find(u => u.id === 19);
    const snSummary = TimekeepingCore.periodSummary(snRow.attendance, snEmp, '2026-12-23', '2026-12-23', snRow.company.shifts, [], 'mon');
    assertEqual(snSummary.absentDays, 0, '120. periodSummary no longer counts this date as a full-day absence');

  } finally {
    try { child.kill(); } catch {}
    await new Promise(r => setTimeout(r, 200));
    await pg.end();
  }
}

// ── 30/31/32/33: bulk migration under REAL (non-bypassing) Row Level Security ───────────────
// Everything above this point connects as `auratest`, which is a Postgres superuser -- and
// ── Final Leave/Payroll reconciliation pass: precise, deterministic coverage of the exact
// mandatory scenarios the locked-payroll-delta module must get right (retro = corrected payroll
// result MINUS original locked payroll result, never a guessed dailyRate×fraction). Exercised
// directly against LeavePayrollReconciliation as a pure function over hand-built state objects --
// no server/DB round trip needed (the module reads/writes nothing but the state object it's
// given), which lets every scenario assert an EXACT delta with no ambiguity about which real-world
// attendance edge case produced it. The end-to-end HTTP/DB-backed equivalents of most of these
// (real locked payroll runs, real approval flow, real audit events) are already covered by
// testLeaveIntegrityAndFinalization's retrofitted TX-setup/ED-approve/halfworked/halfnotworked/
// fractest scenarios above -- this function fills in the specific numeric/structural scenarios
// (issues 26-38) that module wasn't built to exercise cleanly, plus the security/privacy
// projection (issue 39).
async function testLeaveRetroReconciliation() {
  const LeavePayrollReconciliation = require('../server/leave-payroll-reconciliation.js');
  const TimekeepingCoreLocal = require('../public/timekeeping-core.js');

  // A locked run/item/period triple with a HAND-SPECIFIED original attendanceSummary (full control
  // over absentDays/unpaidLeaveDays/lateMinutes/undertimeMinutes -- exactly what "the locked
  // payroll already had" without needing to reverse-engineer real punch data for every scenario)
  // and real rates (daily 1000, matching the rest of this fixture's ₱22,000/22 convention).
  let nextRunId = 9000, nextPeriodId = 9000;
  function sealSynthetic(state, empId, originalSummary, periodFrom, periodTo) {
    const periodId = nextPeriodId++, runId = nextRunId++;
    const period = { id: periodId, groupId: 1, status: 'closed', runId, attendanceFrom: periodFrom, attendanceTo: periodTo };
    const item = {
      empId, baseBasic: 22000, attendanceFrom: periodFrom, attendanceTo: periodTo,
      rates: { daily: 1000, dailyDivisor: 22, hourly: 125, minute: 125 / 60, annualWorkdays: 264 },
      attendanceSummary: Object.assign({ records: [], presentDays: 0, lateMinutes: 0, undertimeMinutes: 0, absentDays: 0, unpaidLeaveDays: 0, otHours: 0, ndHours: 0, restDayHolidayHours: 0, restDayHolidayHoursByCode: {} }, originalSummary)
    };
    const run = { id: runId, status: 'locked', items: [item], ruleSnapshot: [] };
    state.payPeriods = (state.payPeriods || []).concat(period);
    state.payrolls = (state.payrolls || []).concat(run);
    return { period, run, item };
  }
  function freshState() {
    return { users: [{ id: 1, payGroupId: 1 }], attendance: [], payrollAdjustments: [], leaveRetroReconciliations: [], company: { shifts: [] } };
  }
  const emp = { id: 1, payGroupId: 1 };
  const leave = id => ({ id, type: 'VL' });

  // 26: original ₱500 (half-day-unaware misread of a PM-worked date), later Half AM UNPAID leave
  // -> corrected is ALSO exactly ₱500 (0.5 unpaid × ₱1000) -> retro delta ₱0, no adjustment at all
  // (issue 13's explicit "do not fabricate a ₱0 adjustment").
  {
    const st = freshState();
    const ctx = sealSynthetic(st, 1, { absentDays: 0.5 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'present', tin: '13:00', tout: '18:00', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am', paidLeaveFraction: 0, unpaidLeaveFraction: 0.5, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(2600), ['2026-01-05'], 'Tester');
    assertEqual(out.reconciliations.length, 1, '26-setup. one reconciliation is produced');
    assertEqual(out.reconciliations[0].status, 'no_adjustment_required', '26. original ₱500 and corrected ₱500 -> zero delta -> no_adjustment_required, never a fabricated ₱0 adjustment');
    assertEqual(out.reconciliations[0].varianceNet, 0, '26b. the computed variance is exactly 0');
    assertEqual(st.payrollAdjustments.length, 0, '26c. no payrollAdjustments entry was created for a zero-delta reconciliation');
    const auditEvt = st.leaveRetroReconciliations.find(r => r.sourceLeaveId === 2600);
    assert(!!auditEvt && auditEvt.status === 'no_adjustment_required', '26d. the reconciliation record itself is the auditable proof of "no adjustment needed", not silence');
  }

  // 27: original ₱250, corrected (Half AM fully UNPAID) ₱500 -> retro = -₱250, NOT -₱500 (a naive
  // dailyRate×fraction guess would fabricate -₱500 here).
  {
    const st = freshState();
    sealSynthetic(st, 1, { absentDays: 0.25 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'present', tin: '13:00', tout: '18:00', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am', paidLeaveFraction: 0, unpaidLeaveFraction: 0.5, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(2700), ['2026-01-05'], 'Tester');
    assertEqual(out.reconciliations[0].status, 'adjustment_created', '27-setup. a real adjustment is created');
    assertEqual(out.reconciliations[0].varianceNet, -250, '27. retro is exactly -₱250 (₱500 corrected minus ₱250 original), never the naive -₱500 dailyRate×0.5 guess');
    const adj = st.payrollAdjustments.find(a => a.sourceLeaveId === 2700);
    assertEqual(adj.payItemCode, 'LEAVE_RETRO_DEDUCTION', '27b. a negative variance is booked as a deduction pay item');
    assertEqual(adj.amount, -250, '27c. the adjustment amount matches the variance exactly');
  }

  // 28: original ₱750, corrected (Half PM PAID, AM validly worked) ₱0 -> retro = +₱750, NOT the
  // naive +₱500 a flat dailyRate×0.5 credit would produce.
  {
    const st = freshState();
    sealSynthetic(st, 1, { absentDays: 0.75 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'present', tin: '09:00', tout: '13:00', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_pm', paidLeaveFraction: 0.5, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(2800), ['2026-01-05'], 'Tester');
    assertEqual(out.reconciliations[0].varianceNet, 750, '28. retro is exactly +₱750 (₱0 corrected minus ₱750 original), never the naive +₱500 dailyRate×0.5 guess');
    assertEqual(out.reconciliations[0].correctedAttendanceDeduction, 0, '28b. the corrected side has zero attendance deduction -- AM was validly worked and PM is fully paid leave');
  }

  // 29: original full-day-absence ₱1000, later Half AM PAID leave with NO PM work -> corrected
  // final deduction ₱500 (the uncovered PM half only) -> retro = +₱500.
  {
    const st = freshState();
    sealSynthetic(st, 1, { absentDays: 1 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'absent', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am', paidLeaveFraction: 0.5, unpaidLeaveFraction: 0, absentWorkFraction: 0.5 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(2900), ['2026-01-05'], 'Tester');
    assertEqual(out.reconciliations[0].varianceNet, 500, '29. full-day-absence baseline corrected to a half-paid/half-still-absent day -> retro is exactly +₱500');
  }

  // 30: original payroll had NO leave approval at all (a normal, fully-present, zero-deduction
  // date) -- final approval is 0.25 paid / 0.25 unpaid / 0.5 genuinely worked (0.75 total day
  // entitlement). Asserts retro equals the module's own reported correctedNet-originalNet
  // difference, not a value hardcoded independent of that arithmetic.
  {
    const st = freshState();
    sealSynthetic(st, 1, { absentDays: 0, unpaidLeaveDays: 0 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'present', tin: '13:00', tout: '18:00', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am', paidLeaveFraction: 0.25, unpaidLeaveFraction: 0.25, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3000), ['2026-01-05'], 'Tester');
    const rec = out.reconciliations[0];
    assertEqual(rec.varianceNet, +(rec.correctedNet - rec.originalNet).toFixed(2), '30. retro is exactly correctedNet-originalNet as reported, never a value independent of that arithmetic');
    assertEqual(rec.varianceNet, -250, '30b. for this specific 0.25 unpaid portion (never accounted for in the original run at all), that arithmetic works out to exactly -₱250');
  }

  // 31: Half AM paid, actual PM punch-in at 13:30 (30 min late against the PM segment) -- the
  // corrected recompute must RETAIN that late deduction, not zero it out just because the leave
  // itself is paid. Needs a real shift/schedule for periodSummary's own late-minutes computation
  // to run, unlike the hand-specified scenarios above.
  {
    const shift = { id: 1, name: 'Mon-Fri', schedule: {
      mon: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      tue: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      wed: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      thu: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      fri: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      sat: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' },
      sun: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' }
    } };
    const st = freshState();
    st.company.shifts = [shift];
    const shiftEmp = { id: 1, payGroupId: 1, shiftId: 1 };
    st.users = [shiftEmp];
    sealSynthetic(st, 1, { absentDays: 1 }, '2026-01-01', '2026-01-31'); // baseline: no leave existed yet
    // 2026-01-05 is a Monday -- a real workday under the shift above.
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'present', tin: '13:30', tout: '18:00', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am', paidLeaveFraction: 0.5, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, shiftEmp, leave(3100), ['2026-01-05'], 'Tester');
    const rec = out.reconciliations[0];
    assert(rec.correctedAttendanceDeduction > 0, '31. the corrected side still carries a nonzero deduction -- the genuine 30-minute PM lateness is NOT wiped out just because the AM half is paid leave');
    assertEqual(rec.correctedAttendanceDeduction, 62.5, '31b. the retained late deduction is exactly 30 minutes × the minute rate (₱62.50), not the full ₱1000 absence and not zero');
  }

  // 32: Half AM, actual PM 13:00-17:00 (60 min undertime against the PM segment) -- same pattern,
  // for undertime instead of late.
  {
    const shift = { id: 1, name: 'Mon-Fri', schedule: {
      mon: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      tue: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      wed: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      thu: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      fri: { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' },
      sat: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' },
      sun: { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' }
    } };
    const st = freshState();
    st.company.shifts = [shift];
    const shiftEmp = { id: 1, payGroupId: 1, shiftId: 1 };
    st.users = [shiftEmp];
    sealSynthetic(st, 1, { absentDays: 1 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'present', tin: '13:00', tout: '17:00', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am', paidLeaveFraction: 0.5, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, shiftEmp, leave(3200), ['2026-01-05'], 'Tester');
    const rec = out.reconciliations[0];
    assertEqual(rec.correctedAttendanceDeduction, 125, '32. the retained undertime deduction is exactly 60 minutes × the minute rate (₱125), the corrected half_am+undertime result, not a flat guess');
  }

  // 33: two newly-approved leave dates in the SAME locked run -> ONE reconciliation, ONE
  // adjustment, never two independent per-date entries.
  {
    const st = freshState();
    sealSynthetic(st, 1, { absentDays: 2 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    st.attendance.push({ id: 2, eid: 1, date: '2026-01-06', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3300), ['2026-01-05', '2026-01-06'], 'Tester');
    assertEqual(out.reconciliations.length, 1, '33. both dates (same locked run) reconcile together into exactly ONE reconciliation record');
    assertEqual(st.payrollAdjustments.filter(a => a.sourceLeaveId === 3300).length, 1, '33b. and exactly ONE payroll adjustment, never one per date');
    assertEqual(out.reconciliations[0].varianceNet, 2000, '33c. the single adjustment covers the full combined delta for both dates (₱1000 each)');
  }

  // 34: one leave spans TWO different locked pay periods -> two INDEPENDENT reconciliations, each
  // against its own run snapshot.
  {
    const st = freshState();
    sealSynthetic(st, 1, { absentDays: 1 }, '2026-01-01', '2026-01-31'); // run A, January
    sealSynthetic(st, 1, { absentDays: 1 }, '2026-02-01', '2026-02-28'); // run B, February
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-30', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    st.attendance.push({ id: 2, eid: 1, date: '2026-02-02', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3400), ['2026-01-30', '2026-02-02'], 'Tester');
    assertEqual(out.reconciliations.length, 2, '34. two dates in two different locked periods produce two independent reconciliations');
    const runIds = out.reconciliations.map(r => r.sourcePayrollRunId).sort((a, b) => a - b);
    assert(runIds[0] !== runIds[1], '34b. each reconciliation is keyed to its OWN payroll run, never merged into one');
    assert(out.reconciliations.every(r => r.varianceNet === 1000), '34c. each period\'s adjustment is computed independently against its own ₱1000 sealed baseline');
  }

  // 35: original locked item carries manualOverride:true -> manual_review_required, never an
  // automatic adjustment that could silently discard a human's deliberate correction.
  {
    const st = freshState();
    const ctx = sealSynthetic(st, 1, { absentDays: 1 }, '2026-01-01', '2026-01-31');
    ctx.item.manualOverride = true;
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3500), ['2026-01-05'], 'Tester');
    assertEqual(out.reconciliations[0].status, 'manual_review_required', '35. a manually-overridden locked payroll item routes to manual review, never an automatic guess');
    assert(/manual override/i.test(out.reconciliations[0].reason || ''), '35b. the reason explains it is because of the manual override');
    assertEqual(st.payrollAdjustments.length, 0, '35c. no adjustment was created');
  }

  // 36: period status:'closed' but runId missing entirely -> manual_review_required. Must NOT
  // create a dailyRate×fraction adjustment (the exact defect this whole pass exists to remove).
  {
    const st = freshState();
    st.payPeriods = [{ id: 1, groupId: 1, status: 'closed', attendanceFrom: '2026-01-01', attendanceTo: '2026-01-31' }];
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3600), ['2026-01-05'], 'Tester');
    assertEqual(out.reconciliations[0].status, 'manual_review_required', '36. a closed period with no linked payroll run at all routes to manual review');
    assert(/no linked payroll run/i.test(out.reconciliations[0].reason || ''), '36b. the reason explains the period has no linked run');
    assertEqual(st.payrollAdjustments.length, 0, '36c. critically, NO dailyRate×fraction adjustment was fabricated for this date');
  }

  // 37: the linked locked run exists, but this employee's own payroll item is missing from it ->
  // manual_review_required.
  {
    const st = freshState();
    const periodId = nextPeriodId++, runId = nextRunId++;
    st.payPeriods = [{ id: periodId, groupId: 1, status: 'closed', runId, attendanceFrom: '2026-01-01', attendanceTo: '2026-01-31' }];
    st.payrolls = [{ id: runId, status: 'locked', items: [], ruleSnapshot: [] }]; // no item for empId 1
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3700), ['2026-01-05'], 'Tester');
    assertEqual(out.reconciliations[0].status, 'manual_review_required', '37. a locked run missing this employee\'s own payroll item routes to manual review');
    assert(/item not found/i.test(out.reconciliations[0].reason || ''), '37b. the reason explains the employee item is missing from the run');
  }

  // 43/44: pending_approval/returned/superseded/voided runs are all equally NOT eligible -- never
  // just "locked" runs treated as valid.
  {
    for (const status of ['pending_approval', 'returned', 'superseded', 'voided']) {
      const st = freshState();
      const periodId = nextPeriodId++, runId = nextRunId++;
      st.payPeriods = [{ id: periodId, groupId: 1, status: 'closed', runId, attendanceFrom: '2026-01-01', attendanceTo: '2026-01-31' }];
      st.payrolls = [{ id: runId, status, items: [{ empId: 1, baseBasic: 22000, attendanceFrom: '2026-01-01', attendanceTo: '2026-01-31', rates: { daily: 1000, dailyDivisor: 22 }, attendanceSummary: { absentDays: 1 } }], ruleSnapshot: [] }];
      st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'leave', tin: '', tout: '', approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'whole', paidLeaveFraction: 1, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
      const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3800), ['2026-01-05'], 'Tester');
      assertEqual(out.reconciliations[0].status, 'manual_review_required', `43/44. a run with status '${status}' is never treated as a valid locked source -- manual review`);
    }
  }

  // 39: response privacy -- the safe projection for a caller WITHOUT payroll visibility must NEVER
  // leak originalNet/correctedNet/variance/amount/rate/tax/salary/govt-id detail, only the status.
  {
    const st = freshState();
    sealSynthetic(st, 1, { absentDays: 0.75 }, '2026-01-01', '2026-01-31');
    st.attendance.push({ id: 1, eid: 1, date: '2026-01-05', status: 'present', tin: '09:00', tout: '13:00', approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_pm', paidLeaveFraction: 0.5, unpaidLeaveFraction: 0, absentWorkFraction: 0 });
    const out = LeavePayrollReconciliation.reconcileLeaveAgainstLockedPayroll(st, emp, leave(3900), ['2026-01-05'], 'Tester');
    const projected = LeavePayrollReconciliation.projectReconciliationForSession(out.reconciliations[0]);
    assertEqual(Object.keys(projected).sort().join(','), 'retroReconciliationStatus,sourceLeaveId', '39. the privacy-safe projection contains ONLY sourceLeaveId and retroReconciliationStatus');
    assertEqual(projected.retroReconciliationStatus, 'adjustment_created', '39b. the status itself is still visible (a leave-only approver DOES learn whether something happened)');
    const raw = JSON.stringify(projected);
    assert(!/750|originalNet|correctedNet|varianceNet|amount|22000|1000|salaryPM|sss|philhealth|pagibig|tax/i.test(raw),
      '39c. the projected object never contains any amount, rate, salary, or statutory-detail field or value, however it was serialized');
  }

  console.log('Leave/Payroll reconciliation tests passed.');
}

// The role-of-superuser-vs-non-superuser distinction matters a great deal here: RLS PostgreSQL role
// superusers bypass RLS entirely, FORCE ROW LEVEL SECURITY included. That means every migration
// test so far proves the MIGRATION LOGIC is correct, but proves NOTHING about whether it survives
// real RLS enforcement in production, where the app's DB role should not be a superuser. This test
// creates its own throwaway role (NOSUPERUSER, NOBYPASSRLS) and its own database owned by that
// role, boots server.js against it, and proves the fix in server.js's allTenantKeys()/
// withTenantScope-per-tenant actually works when RLS can't be silently bypassed -- not just that
// it LOOKS like it works under a role that was never actually being checked.
async function testRlsSafeMigration() {
  const maintenanceUrl = DATABASE_URL.replace(/\/[^/]+$/, '/postgres');
  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();
  const rlsDbName = 'auratest_rls_test';
  const rlsRole = 'auratest_rls_role';
  const rlsPassword = 'rlsTestRolePass1';
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${rlsDbName}' AND pid <> pg_backend_pid()`).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${rlsDbName}`);
  await admin.query(`DROP ROLE IF EXISTS ${rlsRole}`);
  await admin.query(`CREATE ROLE ${rlsRole} LOGIN PASSWORD '${rlsPassword}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${rlsDbName} OWNER ${rlsRole}`);
  await admin.end();

  const rlsUrl = `postgres://${rlsRole}:${rlsPassword}@localhost:5432/${rlsDbName}`;
  const rlsPort = Number(PORT) + 20;

  try {
    // Confirm the role is genuinely not RLS-exempt before trusting anything the rest of this test
    // concludes from it -- if this ever came back true, the whole test would be worthless.
    const roleCheck = await admin2Query(maintenanceUrl, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${rlsRole}'`);
    assert(roleCheck.rows[0].rolsuper === false && roleCheck.rows[0].rolbypassrls === false, 'RLS0. the RLS test role is genuinely non-superuser and non-BYPASSRLS');

    // First boot: schema creation only (tables + FORCE RLS policies get created, OWNED BY rlsRole
    // this time -- the important difference from every other test in this file).
    let child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATABASE_URL: rlsUrl, API_SESSION_SECRET: SESSION_SECRET, PORT: String(rlsPort), APP_TENANT_KEY: 'rls-legacy' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { const res = await fetch(`http://localhost:${rlsPort}/api/health`); if (res.ok) ready = true; } catch {}
      if (!ready) await new Promise(r => setTimeout(r, 250));
    }
    assert(ready, 'RLS-boot1. server boots successfully against a DB owned by a non-superuser, RLS-enforced role');
    try { child.kill(); } catch {}
    await new Promise(r => setTimeout(r, 300));

    // Seed two tenants directly, AS the RLS-enforced role, exactly the way the app itself would
    // have to: platform_clients has no RLS (by design), so a plain insert works; app_state DOES,
    // so each insert must run inside its own tenant-scoped transaction or the RLS policy's WITH
    // CHECK clause rejects it outright.
    const rls = new Client({ connectionString: rlsUrl });
    await rls.connect();
    await rls.query(
      `INSERT INTO platform_clients (tenant_key, name, admin_email, admin_pass) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      ['rls-tenant-a', 'RLS Tenant A', 'rls-a-admin@test.local', 'placeholderhash',
       'rls-tenant-b', 'RLS Tenant B', 'rls-b-admin@test.local', 'placeholderhash']
    );
    const existingHash = await bcrypt.hash('alreadyHashedRls1', 10);
    async function seedTenantState(tenantKey, plaintextEmail, plaintextPass) {
      await rls.query('BEGIN');
      await rls.query("SELECT set_config('app.tenant_key', $1, true)", [tenantKey]);
      await rls.query(
        'INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3)',
        [tenantKey, {
          schemaVersion: 1, accessLevels: [{ id: 1, name: 'Super Admin', perms: {} }],
          users: [
            { id: 1, email: plaintextEmail, pass: plaintextPass, role: 'admin', accessLevelId: 1, active: true },
            { id: 2, email: 'already-' + tenantKey + '@test.local', pass: existingHash, role: 'employee', accessLevelId: 1, active: true }
          ],
          attendance: [], leaves: [], loans: [], payrolls: [], company: {}, org: [], lookups: {}
        }, 'seed']
      );
      await rls.query('COMMIT');
    }
    await seedTenantState('rls-tenant-a', 'plain-a@test.local', 'plaintextRlsPassA1');
    await seedTenantState('rls-tenant-b', 'plain-b@test.local', 'plaintextRlsPassB1');

    // Prove tenant scoping is actually enforced for this role BEFORE trusting the migration result
    // below -- scoped to tenant A, a query for tenant B's row must come back empty. If this ever
    // returned tenant B's row, RLS wouldn't be doing anything and the rest of this test would be
    // meaningless.
    await rls.query('BEGIN');
    await rls.query("SELECT set_config('app.tenant_key', 'rls-tenant-a', true)");
    const crossTenantAttempt = await rls.query('SELECT 1 FROM app_state WHERE tenant_key = $1', ['rls-tenant-b']);
    await rls.query('ROLLBACK');
    assertEqual(crossTenantAttempt.rowCount, 0, 'RLS32. tenant A cannot directly query tenant B\'s row under tenant scope (RLS genuinely active for this role)');
    await rls.end();

    // Second boot: the real thing under test. bulkMigrateLegacyPasswords() (and
    // grandfatherZkCommandPermission()) run again on this normal boot -- if allTenantKeys() +
    // per-tenant withTenantScope don't work under real RLS, both plaintext passwords below stay
    // plaintext with no error (RLS fails closed, not loud), which is exactly the silent-failure
    // mode this whole test exists to catch.
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATABASE_URL: rlsUrl, API_SESSION_SECRET: SESSION_SECRET, PORT: String(rlsPort), APP_TENANT_KEY: 'rls-legacy' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { const res = await fetch(`http://localhost:${rlsPort}/api/health`); if (res.ok) ready = true; } catch {}
      if (!ready) await new Promise(r => setTimeout(r, 250));
    }
    assert(ready, 'RLS-boot2. second boot (migration boot) succeeds');
    await new Promise(r => setTimeout(r, 700)); // let bulkMigrateLegacyPasswords finish

    const verify = new Client({ connectionString: rlsUrl });
    await verify.connect();
    async function readStateScoped(tenantKey) {
      await verify.query('BEGIN');
      await verify.query("SELECT set_config('app.tenant_key', $1, true)", [tenantKey]);
      const row = (await verify.query('SELECT state FROM app_state WHERE tenant_key = $1', [tenantKey])).rows[0];
      await verify.query('COMMIT');
      return row.state;
    }
    const stateA = await readStateScoped('rls-tenant-a');
    const stateB = await readStateScoped('rls-tenant-b');
    assert(/^\$2[aby]\$/.test(stateA.users.find(u => u.id === 1).pass), 'RLS30. tenant A\'s plaintext user is migrated under real FORCE RLS enforcement');
    assert(/^\$2[aby]\$/.test(stateB.users.find(u => u.id === 1).pass), 'RLS31. tenant B\'s plaintext user is migrated under real FORCE RLS enforcement (a second, different tenant)');
    assertEqual(stateA.users.find(u => u.id === 2).pass, existingHash, 'RLS33. an already-hashed password is unchanged by RLS-safe migration');
    assertEqual(stateB.users.find(u => u.id === 2).pass, existingHash, 'RLS33b. same, for tenant B');
    await verify.end();

    try { child.kill(); } catch {}
    await new Promise(r => setTimeout(r, 300));
  } finally {
    const cleanup = new Client({ connectionString: maintenanceUrl });
    await cleanup.connect();
    await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${rlsDbName}' AND pid <> pg_backend_pid()`).catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS ${rlsDbName}`).catch(() => {});
    await cleanup.query(`DROP ROLE IF EXISTS ${rlsRole}`).catch(() => {});
    await cleanup.end();
  }
}
async function admin2Query(url, sql) {
  const c = new Client({ connectionString: url });
  await c.connect();
  const res = await c.query(sql);
  await c.end();
  return res;
}

// ── 33/34/35/36: login rate limiting ─────────────────────────────────────────────────────────
async function testLoginRateLimit() {
  const rlPort = Number(PORT) + 6;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET, PORT: String(rlPort), APP_TENANT_KEY: 'test-legacy-tenant' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = `http://localhost:${rlPort}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { const res = await fetch(base + '/api/health'); if (res.ok) ready = true; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 250));
  }
  const login = async (email, password) => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // 34: a handful of failed attempts under the threshold still leave a correct login on a
  // DIFFERENT account working (this DB still has tenant A's seeded users from main()).
  const rlEmail = 'ratelimit-target@a.test'; // doesn't need to exist -- failures alone are tracked
  for (let i = 0; i < 5; i++) await login(rlEmail, 'wrongpass' + i);
  let r = await login('alice@a.test', 'alicepass1');
  assertEqual(r.status, 200, '34. a correct login still works elsewhere while another email is mid-failure-count');

  // 33: push the SAME key past the threshold (8 failures/15 min) -- must start returning 429.
  let sawBlocked = false;
  for (let i = 0; i < 8; i++) {
    const res = await login(rlEmail, 'wrongpass-more-' + i);
    if (res.status === 429) { sawBlocked = true; break; }
  }
  assert(sawBlocked, '33. repeated failed login attempts eventually return 429');
  r = await login(rlEmail, 'wrongpass-final');
  assertEqual(r.status, 429, '33b. still blocked immediately after crossing the threshold');

  // 35: isolation -- a wholly unrelated email/IP-key combination is unaffected by rlEmail's block.
  r = await login('bob@a.test', 'bobPlaintext1');
  assertEqual(r.status, 200, '35. rate-limit isolation: an unrelated email is unaffected by another email\'s block');

  // 36: a successful login resets the failure counter for that key -- carol logs in correctly,
  // then a handful of subsequent failures on HER key alone don't instantly 429 (which would only
  // happen if the earlier success hadn't cleared anything).
  r = await login('carol@a.test', 'carolpass1');
  assertEqual(r.status, 200, '36 setup: a correct login succeeds');
  let blockedEarly = false;
  for (let i = 0; i < 3; i++) {
    const res = await login('carol@a.test', 'wrongagain' + i);
    if (res.status === 429) blockedEarly = true;
  }
  assert(!blockedEarly, '36. a successful login resets the failure counter (a few subsequent failures alone don\'t trip the threshold)');

  try { child.kill(); } catch {}
  await new Promise(r => setTimeout(r, 200));
}

main()
  .then(testProductionSecretFailFast)
  .then(testDbAwareProductionSecrets)
  .then(testBulkPasswordMigration)
  .then(testLeaveIntegrityAndFinalization)
  .then(testLeaveRetroReconciliation)
  .then(testRlsSafeMigration)
  .then(testLoginRateLimit)
  .then(() => {
    console.log(`\n${failures === 0 ? 'All' : failures} security test${failures === 1 ? '' : 's'}${failures ? ' FAILED' : ' passed'}.`);
    process.exit(failures ? 1 : 0);
  }).catch(err => {
    console.error('Security test run crashed:', err);
    process.exit(1);
  });
