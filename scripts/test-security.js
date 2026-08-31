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
      { id: 5, name: 'ZK Commander', perms: { zksetup: true, zkcommand: true } }
    ],
    users: [
      { id: 1, email: 'admin@a.test', pass: 'adminPlaintext1', role: 'admin', accessLevelId: 1, name: 'Admin A', active: true },
      { id: 2, email: 'alice@a.test', pass: await passHash('alicepass1'), role: 'employee', accessLevelId: 2, name: 'Alice Employee', active: true, salaryPM: 50000, sss: '12-3456789-0', bank: 'BDO', bankAccount: '000111222' },
      { id: 3, email: 'bob@a.test', pass: 'bobPlaintext1', role: 'employee', accessLevelId: 3, name: 'Bob Approver', active: true, salaryPM: 60000, sss: '99-8887776-0' },
      { id: 4, email: 'zkview@a.test', pass: await passHash('zkviewpass1'), role: 'employee', accessLevelId: 4, name: 'ZK Viewer', active: true },
      { id: 5, email: 'zkcmd@a.test', pass: await passHash('zkcmdpass1'), role: 'employee', accessLevelId: 5, name: 'ZK Commander', active: true }
    ],
    attendance: [
      { id: 1, eid: 2, date: '2026-08-01', status: 'present' },
      { id: 2, eid: 3, date: '2026-08-01', status: 'late' }
    ],
    leaves: [{ id: 1, eid: 2, type: 'VL', status: 'pending' }],
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

    // ── 13/14/15. Legacy plaintext password migration ─────────────────────────────────────
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@a.test', password: 'wrong-password' }) });
    assertEqual(r.status, 401, '15. wrong password on a legacy-plaintext account is rejected');
    let row = await pg.query("SELECT state->'users' AS users FROM app_state WHERE tenant_key='test-tenant-a'");
    let adminRow = row.rows[0].users.find(u => u.id === 1);
    assertEqual(adminRow.pass, 'adminPlaintext1', '15b. a failed login never migrates/touches the stored plaintext');

    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@a.test', password: 'adminPlaintext1' }) });
    assertEqual(r.status, 200, '14. correct password on a legacy-plaintext account still logs in');
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
    assertEqual(r.body.state.attendance.length, 2, '3m. an employee-role account with att_edit sees ALL attendance, not just their own');

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

main()
  .then(testProductionSecretFailFast)
  .then(() => {
    console.log(`\n${failures === 0 ? 'All' : failures} security test${failures === 1 ? '' : 's'}${failures ? ' FAILED' : ' passed'}.`);
    process.exit(failures ? 1 : 0);
  }).catch(err => {
    console.error('Security test run crashed:', err);
    process.exit(1);
  });
