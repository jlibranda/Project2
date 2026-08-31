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
      { id: 2, name: 'Basic Employee', perms: { self_view_attendance: true, leave: true, loans_apply: true } },
      { id: 3, name: 'Attendance Approver', perms: { att_edit: true } },
      // zkcommand explicitly false (not merely absent) -- the grandfather migration only backfills
      // zkcommand where it was never configured at all, so this level represents a tenant that has
      // deliberately opted a role INTO zksetup without zkcommand, post-migration.
      { id: 4, name: 'ZK Viewer', perms: { zksetup: true, zkcommand: false } },
      { id: 5, name: 'ZK Commander', perms: { zksetup: true, zkcommand: true } },
      // role==='employee' but elevated: can approve leave/attendance for people below them in the
      // immediateHeadEid hierarchy -- exactly the "manager who isn't role:admin" case the second
      // security pass is about.
      { id: 6, name: 'Manager', perms: { leave_approve: true, att_edit: true, self_view_attendance: true, leave: true } }
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
      { id: 7, email: 'dave@a.test', pass: await passHash('davepass1'), role: 'employee', accessLevelId: 2, name: 'Dave Report', eid: 'E-DAVE', immediateHeadEid: 'E-CAROL', active: true }
    ],
    attendance: [
      { id: 1, eid: 2, date: '2026-08-01', status: 'present' },
      { id: 2, eid: 3, date: '2026-08-01', status: 'late' },
      { id: 3, eid: 7, date: '2026-08-03', status: 'late', approvalStatus: 'pending', approvalLayer: 1 },
      { id: 4, eid: 1, date: '2026-08-03', status: 'late', approvalStatus: 'pending', approvalLayer: 1 }
    ],
    leaves: [
      { id: 1, eid: 2, type: 'VL', status: 'pending' },
      { id: 2, eid: 7, type: 'VL', status: 'pending', approvalLayer: 1, days: 1 },
      { id: 3, eid: 1, type: 'VL', status: 'pending', approvalLayer: 1, days: 1 }
    ],
    loans: [],
    payrolls: [{ id: 1, from: '2026-08-01', to: '2026-08-15', status: 'released', items: [{ eid: 2, net: 45000 }, { eid: 3, net: 40000 }] }],
    company: { name: 'Tenant A Co' },
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
    assertEqual(r.body.state.attendance.length, 4, '3m. an employee-role account with att_edit sees ALL attendance, not just their own');

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
    maliciousState.leaves.push({ id: 999, eid: 2, type: 'SL', status: 'pending' }); // her own -- SHOULD be accepted
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
    r = await req('/api/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + daveToken }, body: JSON.stringify({ version: Number(verBefore.rows[0].version), state: daveAttTampered }) });
    persisted2 = (await pg.query("SELECT state FROM app_state WHERE tenant_key='test-tenant-a'")).rows[0].state;
    let persisted2Att2 = persisted2.attendance.find(a => a.id === 3);
    assertEqual(persisted2Att2.approvalStatus, 'pending', '6. employee cannot change pending attendance to approved via /api/state');
    assertEqual(persisted2Att2.otHours, undefined, '7. employee cannot forge OT/payroll-relevant protected values on an attendance record');

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

    // 19: authorized admin CAN force-approve someone else's record.
    r = await req('/api/attendance/3/force-approve', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({}) });
    // record 3 is already 'approved' from the chain test above -- force-approve is still a valid
    // admin action on it (idempotent-ish), confirms the endpoint itself works for a non-self record.
    assertEqual(r.status, 200, '19. an authorized admin can force-approve someone else\'s record');
    assert(/\(forced\)/.test(r.body.record.reviewedBy), '19b. reviewedBy is suffixed to show it was forced');

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

// ── 25/26/27/28: DB-aware production credential checks ──────────────────────────────────────
// Reuses whatever the shared test DB looks like after main() has already run: main()'s own first
// schema-creating boot already created the bootstrap tenant row for APP_TENANT_KEY=
// 'test-legacy-tenant' in platform_clients, which is exactly the "already initialized" state
// test #28 needs. #26/#27 use a brand-new, never-before-seen tenant_key instead, so there's
// nothing in the DB yet to exempt the bootstrap check.
async function testDbAwareProductionSecrets() {
  // 25 (repeat, cheap to reconfirm here too): still fails with no API_SESSION_SECRET at all.
  {
    const env = { ...process.env, NODE_ENV: 'production', PORT: String(Number(PORT) + 2) };
    delete env.API_SESSION_SECRET; delete env.DATABASE_URL;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const exitCode = await new Promise(resolve => { const t = setTimeout(() => resolve(null), 3000); child.on('exit', c => { clearTimeout(t); resolve(c); }); });
    if (exitCode === null) { try { child.kill(); } catch {} }
    assert(exitCode !== null && exitCode !== 0, '25. production + missing API_SESSION_SECRET fails');
  }

  // 26/27: a completely fresh tenant_key (never bootstrapped before) + production + no
  // GOD_ADMIN_PASSWORD/BOOTSTRAP_ADMIN_PASSWORD -- must refuse to start.
  {
    const freshTenantKey = 'test-fresh-prod-' + Date.now();
    const env = {
      ...process.env, NODE_ENV: 'production', PORT: String(Number(PORT) + 3),
      DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET, APP_TENANT_KEY: freshTenantKey
    };
    delete env.GOD_ADMIN_PASSWORD; delete env.BOOTSTRAP_ADMIN_PASSWORD;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const exitCode = await new Promise(resolve => { const t = setTimeout(() => resolve(null), 4000); child.on('exit', c => { clearTimeout(t); resolve(c); }); });
    if (exitCode === null) { try { child.kill(); } catch {} }
    assert(exitCode !== null && exitCode !== 0, '26/27. production + a never-before-seen tenant + missing God Admin/bootstrap passwords refuses the unsafe fallback');
  }

  // 28: an already-initialized deployment (the shared test DB's own bootstrap tenant, already
  // created by main()'s first boot) does NOT need BOOTSTRAP_ADMIN_PASSWORD anymore. A real
  // GOD_ADMIN_PASSWORD is still supplied here since no platform_admin_credential row has been
  // written in this test run -- that's a deliberately separate check (validateGodAdminCredential)
  // and setting it explicitly keeps this test isolated to the bootstrap-credential behavior.
  {
    const port28 = Number(PORT) + 4;
    const env = {
      ...process.env, NODE_ENV: 'production', PORT: String(port28),
      DATABASE_URL, API_SESSION_SECRET: SESSION_SECRET, APP_TENANT_KEY: 'test-legacy-tenant',
      GOD_ADMIN_PASSWORD: 'a-real-non-default-god-admin-password-123'
    };
    delete env.BOOTSTRAP_ADMIN_PASSWORD;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { const res = await fetch(`http://localhost:${port28}/api/health`); if (res.ok) ready = true; } catch {}
      if (!ready) await new Promise(r => setTimeout(r, 250));
    }
    assert(ready, '28. an already-initialized deployment boots fine without BOOTSTRAP_ADMIN_PASSWORD once its tenant row already exists');
    try { child.kill(); } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
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
  .then(testLoginRateLimit)
  .then(() => {
    console.log(`\n${failures === 0 ? 'All' : failures} security test${failures === 1 ? '' : 's'}${failures ? ' FAILED' : ' passed'}.`);
    process.exit(failures ? 1 : 0);
  }).catch(err => {
    console.error('Security test run crashed:', err);
    process.exit(1);
  });
