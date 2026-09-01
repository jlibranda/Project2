const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const TimekeepingCore = require('./public/timekeeping-core.js');
const { hashPassword, verifyPassword, looksLikeHash } = require('./server/passwords.js');
const { createAuthorization, hasPermission, resolveCaller, isAdminCaller } = require('./server/authorization.js');
const { canActOnRecord, applyChainDecision, applyForceApprove } = require('./server/approval-chain.js');
const { calculateLeaveRequest, finalizeLeaveApproval, projectLeaveDecisionEmployeeForSession, projectAttendancePatchForSession } = require('./server/leave-service.js');
const LeavePayrollReconciliation = require('./server/leave-payroll-reconciliation.js');
const { projectReconciliationForSession } = LeavePayrollReconciliation;
const { checkPayrollImmutability } = require('./server/payroll-immutability.js');
const { buildScopedStateForEmployee, applyEmployeeStateOverlay } = require('./server/state-serialization.js');
const { ensureAuditTable, auditLog } = require('./server/audit.js');
const { validateSessionSecret, validateGodAdminCredential, validateBootstrapCredential, KNOWN_DEFAULTS, isSafeReplacementCredential } = require('./server/secrets.js');
const { createRateLimiter } = require('./server/rate-limit.js');

const app = express();
// Deployed behind a reverse proxy (Railway) -- without this, req.ip reflects the proxy's own
// address for every request, making any per-IP rate limiting meaningless (everyone looks like
// the same caller). Trusting only the first hop (not the whole X-Forwarded-For chain) is the
// safer setting for a platform that terminates TLS and proxies directly to this process.
app.set('trust proxy', 1);
const loginEmailLimiter = createRateLimiter();
const loginIpLimiter = createRateLimiter();
const PORT = process.env.PORT || 3000;
const TENANT_KEY = process.env.APP_TENANT_KEY || 'sproutripple-ph';
const SESSION_SECRET = process.env.API_SESSION_SECRET || 'local-development-only-change-me';
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined })
  : null;

function failStartup(problems) {
  console.error('Refusing to start: insecure production configuration detected.');
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
{
  // Checked immediately, before anything else -- no DB dependency, and every token-signing
  // operation from this point on needs it to already be safe. The God Admin / bootstrap-admin
  // credential checks are DB-state-dependent (whether a fallback would ever actually be used
  // depends on whether a real credential already exists) and run inside initializeDatabase()
  // instead -- see server/secrets.js's own comment.
  const check = validateSessionSecret();
  if (!check.ok) failStartup(check.problems);
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    failStartup(['DATABASE_URL is not set. A production deployment with no database would run entirely on in-memory/demo fallbacks -- refusing to start rather than serving that silently.']);
  }
}
const allowedOrigins = new Set(
  (
    process.env.APP_ALLOWED_ORIGINS ||
    [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://project2-six-taupe.vercel.app',
      'https://sproutripple-ph.vercel.app',
      'https://sproutripple-ph-payroll.jlibranda.chatgpt.site'
    ].join(',')
  )
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin?.replace(/\/$/, '');

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type'
    );
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    );
  }

  if (req.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) {
      return res.status(403).json({
        error: 'Origin is not allowed by CORS.'
      });
    }

    return res.sendStatus(204);
  }

  next();
});

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(payload) {
  const body = encode(payload);
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, supplied] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return payload.exp > Date.now() ? payload : null;
}
function requireAuth(req, res, next) {
  try {
    const payload = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    // A signed token alone isn't enough here -- a Web Bundy guest token (see requireBundyAuth
    // below) is validly signed too, but it must never be usable for anything beyond the two
    // narrow bundy endpoints. Rejecting it explicitly here, rather than only ever issuing it
    // the "right" scope, means every endpoint using requireAuth is safe by construction even if
    // a future one forgets to think about this.
    if (!payload || payload.purpose === 'bundy-punch') return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    req.session = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid session.' });
  }
}
function requirePlatformAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== 'platform') return res.status(403).json({ error: 'Platform admin access required.' });
    next();
  });
}
function toPlatformClientJson(row) {
  return {
    id: row.id, tenantKey: row.tenant_key, name: row.name, industry: row.industry, plan: row.plan,
    status: row.status, color: row.color, initials: row.initials, contact: row.contact,
    contactTitle: row.contact_title, contactEmail: row.contact_email, contactMobile: row.contact_mobile,
    adminEmail: row.admin_email, modules: row.modules, createdAt: row.created_at, lastActiveAt: row.last_active_at,
    // Lets the frontend recognize the original real tenant's own directory row and skip it —
    // its Platform Admin card is the frontend's own richer, already-correct id-1 entry, not
    // something to merge a second copy of.
    isSelf: row.tenant_key === TENANT_KEY
  };
}
function slugifyTenantKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
}
// Fresh starter state for a brand-new real tenant, seeded at creation time so a new
// client's first login never depends on whatever happens to be sitting in a browser's
// in-memory frontend state — that was the exact risk this exists to close off.
//
// Only genuinely tenant-specific fields are set here: real business data (org chart,
// lookups/job levels, employees, ZK biometric mapping, everything a company accumulates)
// starts completely empty, and identity fields (company name/initials) come from the
// client record. Regulatory/functional templates (access roles, the DOLE OT rate table,
// statutory items, income types, attendance policy, payroll groups, field visibility) are
// deliberately OMITTED rather than approximated here — hydrate() in persistence.js only
// replaces a field when the incoming value is actually present (replaceArray no-ops on
// undefined, the object fields are behind `if (saved.x)` checks), so omitting them leaves
// the frontend's own already-correct in-memory defaults (computed from PERM_DEFS etc.) in
// place on first login, and the very next autosave persists them for that tenant from then
// on. Duplicating that computed logic here would risk drifting out of sync with the
// frontend and shipping a new tenant a Super Admin role with no actual permissions.
function defaultTenantState(client) {
  return {
    schemaVersion: 1,
    org: [], lookups: { bandLevels: [], costCenters: [], pods: [], disciplines: [], employmentTypes: [], terminationTypes: [], attritionCodes: [], payTypes: [], currencies: [], entityNames: [] },
    users: [], attendance: [], leaves: [], loans: [], payrolls: [], payrollDraft: {},
    candidates: [], performance: [], onboarding: [], changeRequests: [], bundyLogs: [], officeZones: [],
    company: {
      name: client.name, tagline: client.industry || '', initials: client.initials, version: '1.0.0',
      themeKey: 'indigo', accentHex: client.color || '#4f46e5', logo: null, wallpaper: null,
      wallpaperOpacity: 0.12, wallpaperVeil: 0.82, wallpaperMode: 'repeat', wallpaperBlend: 'normal',
      bundySelfie: true, bundyPublicAccess: true, dailyDivisor: 22, hoursPerDay: 8, salaryMultiplier: 13,
      registeredName: client.name, taxIdentificationNo: '', rdo: '', registeredAddress: '', zipCode: '',
      contactNumber: '', emailAddress: '', withholdingAgentCategory: 'private', employerType: 'main',
      authorizedAgent: '', authorizedAgentTitle: '',
      taxPolicy: { annualizationEnabled: true, autoSuggestDecember: true, requireConfirmedTaxRecord: true, taxTableVersion: 'BIR RR 11-2018 Annex E · 2023 onwards' },
      darkMode: false
    },
    employeeNumberConfig: { prefix: 'EMP', separator: '-', digits: 3, nextSeq: 1, manual: false },
    payPeriods: [], payrollAdjustments: [], finalPayList: [], payrollAudit: [], securityAudit: [],
    zk: { userMapping: {}, realtimeEnabled: false, connectionOverride: { address: '', port: '', https: false }, punchBuffer: { beforeMinutes: 120, afterMinutes: 480 } },
    enterprise: { resolutionCases: [], performanceGoals: [], jobRequisitions: [], aiHistory: [] },
    payrollGovernance: { rulebook: [], ruleAudit: [], retro: [], workflow: [] }
  };
}
async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      tenant_key TEXT PRIMARY KEY, state JSONB NOT NULL, version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state_audit (
      id BIGSERIAL PRIMARY KEY, tenant_key TEXT NOT NULL, version BIGINT NOT NULL,
      actor TEXT NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS zk_devices (
      tenant_key TEXT NOT NULL, serial TEXT NOT NULL,
      last_seen TIMESTAMPTZ, pending JSONB NOT NULL DEFAULT '[]', device_users JSONB NOT NULL DEFAULT '[]',
      commands JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_key, serial)
    );
    ALTER TABLE zk_devices ADD COLUMN IF NOT EXISTS commands JSONB NOT NULL DEFAULT '[]';
    -- Directory of every real, backend-tracked company (Platform Admin's client list).
    -- Step 1 of moving off the old design where every client past the one real tenant
    -- was pure browser-memory demo data with no actual row of its own. This table is the
    -- source of truth for which tenants exist; app_state (keyed by tenant_key) still holds
    -- each tenant's actual application data, one row per tenant_key as it already did.
    CREATE TABLE IF NOT EXISTS platform_clients (
      id SERIAL PRIMARY KEY,
      tenant_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      industry TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT 'Starter',
      status TEXT NOT NULL DEFAULT 'active',
      color TEXT NOT NULL DEFAULT '#4f46e5',
      initials TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      contact_title TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      contact_mobile TEXT NOT NULL DEFAULT '',
      admin_email TEXT NOT NULL UNIQUE,
      admin_pass TEXT NOT NULL,
      modules JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Defensive: adds the constraint if platform_clients already existed without it
    -- (e.g. from an earlier version of this migration) instead of silently staying unenforced.
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'platform_clients_admin_email_key'
      ) THEN
        ALTER TABLE platform_clients ADD CONSTRAINT platform_clients_admin_email_key UNIQUE (admin_email);
      END IF;
    END $$;
    -- Single-row table: the God Admin password, when changed from Settings. Absent (no row)
    -- means "still the GOD_ADMIN_PASSWORD env var default" -- see godAdminPassword() below.
    -- Previously that Settings field only ever changed a frontend-only variable, so a changed
    -- password silently stopped working the moment the page reloaded or a different browser was
    -- used, while every backend-authorized action (Enter Portal, Log in as user, etc.) kept
    -- requiring the original env-var password regardless of what the UI showed as "saved."
    CREATE TABLE IF NOT EXISTS platform_admin_credential (
      id INT PRIMARY KEY DEFAULT 1,
      password TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL DEFAULT 'system',
      CHECK (id = 1)
    );
    -- Claims a ZK biometric device serial for one tenant. The device itself pushes to /iclock/*
    -- with no session/credential of any kind -- it only ever sends its own serial number -- so
    -- this is the only way the server can know which tenant's data a given device's punches
    -- belong to. A serial with no row here falls back to the original TENANT_KEY (see
    -- resolveDeviceTenant below), which keeps the one already-configured device working exactly
    -- as it always has, without requiring it to be registered retroactively.
    CREATE TABLE IF NOT EXISTS zk_device_registry (
      serial TEXT PRIMARY KEY,
      tenant_key TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      registered_by TEXT NOT NULL
    );
    -- Defense-in-depth below the application-layer tenant_key filtering every query above is
    -- supposed to do: a Postgres Row-Level Security policy per table that independently blocks
    -- any row whose tenant_key doesn't match the current transaction's app.tenant_key setting
    -- (see withTenantScope/withLoginLookupScope). If a future query anywhere in this file ever
    -- forgets that WHERE clause -- the exact mistake the ZK endpoints made -- it now returns no
    -- rows instead of every tenant's, rather than relying solely on the application code being
    -- right every time. FORCE is required or the owning DB role (this app's own connection,
    -- since it's the one that just ran the CREATE TABLE above) would silently bypass its own
    -- policies. Deliberately NOT applied to zk_device_registry or platform_clients -- both have
    -- legitimate, by-design cross-tenant access patterns (device-claim conflict checks and the
    -- platform directory itself) that a per-tenant policy would break.
    ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;
    ALTER TABLE app_state FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON app_state;
    CREATE POLICY tenant_isolation ON app_state
      USING (tenant_key = current_setting('app.tenant_key', true) OR current_setting('app.login_lookup', true) = 'true')
      WITH CHECK (tenant_key = current_setting('app.tenant_key', true));

    ALTER TABLE app_state_audit ENABLE ROW LEVEL SECURITY;
    ALTER TABLE app_state_audit FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON app_state_audit;
    CREATE POLICY tenant_isolation ON app_state_audit
      USING (tenant_key = current_setting('app.tenant_key', true))
      WITH CHECK (tenant_key = current_setting('app.tenant_key', true));

    ALTER TABLE zk_devices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE zk_devices FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON zk_devices;
    CREATE POLICY tenant_isolation ON zk_devices
      USING (tenant_key = current_setting('app.tenant_key', true))
      WITH CHECK (tenant_key = current_setting('app.tenant_key', true));
  `);
  // Created before the credential checks below (not after, as it originally was) so that an
  // unsafe-credential audit event from a check that's about to failStartup() has somewhere to land.
  await ensureAuditTable(pool);
  // DB-aware production credential checks -- see server/secrets.js for why these can't run
  // synchronously at process start like validateSessionSecret does. Run after the tables above
  // exist (so the SELECTs are valid) but before the bootstrap insert below, which is exactly the
  // moment that decides whether BOOTSTRAP_ADMIN_PASSWORD is actually about to become a real
  // credential or not.
  if (process.env.NODE_ENV === 'production') {
    const godRow = await pool.query('SELECT password FROM platform_admin_credential WHERE id = 1');
    const godHasDb = godRow.rowCount > 0;
    const godIsKnownDefault = godHasDb && (await verifyPassword(KNOWN_DEFAULTS.GOD_ADMIN_PASSWORD, godRow.rows[0].password)).ok;
    // An unsafe STORED credential is a real deadlock if this just fails startup outright: the
    // only normal way to change it is logging in as God Admin and using Settings, and a server
    // that refuses to boot can never be logged into. So when the stored value is unsafe and a
    // real, non-default GOD_ADMIN_PASSWORD is now available, rotate the stored credential to it
    // automatically right here and continue booting, instead of leaving the operator stuck
    // needing direct database access to recover. Only fires when the stored value is actually
    // unsafe -- a safe existing credential is never overwritten just because an old env var
    // happens to still be set.
    if (godIsKnownDefault && isSafeReplacementCredential(process.env.GOD_ADMIN_PASSWORD, KNOWN_DEFAULTS.GOD_ADMIN_PASSWORD)) {
      await setGodAdminPassword(process.env.GOD_ADMIN_PASSWORD, 'system:unsafe-credential-auto-rotation');
      console.warn('[SECURITY] The stored God Admin password was a hash of the known public default -- rotated automatically at boot to match GOD_ADMIN_PASSWORD. Safe to unset the env var afterward if you prefer managing it via Settings.');
      await auditLog(pool, { tenantKey: null, actor: 'system', action: 'unsafe_production_credential_rotated', target: 'god_admin', meta: {} });
    } else {
      const godCheck = validateGodAdminCredential({ hasDbCredential: godHasDb, dbCredentialIsKnownDefault: godIsKnownDefault });
      if (!godCheck.ok) {
        // Audited either way -- godIsKnownDefault distinguishes "the DB already has an unsafe
        // hash and no safe env-var replacement was offered" from "no DB credential yet, and the
        // env var is missing, the known default, or shorter than the required minimum length".
        await auditLog(pool, { tenantKey: null, actor: 'system', action: godIsKnownDefault ? 'unsafe_production_credential_detected' : 'unsafe_production_credential_rejected', target: 'god_admin', meta: {} });
        failStartup(godCheck.problems);
      }
    }
    const tenantRow = await pool.query('SELECT admin_pass FROM platform_clients WHERE tenant_key = $1', [TENANT_KEY]);
    const tenantExists = tenantRow.rowCount > 0;
    const bootstrapIsKnownDefault = tenantExists && (await verifyPassword(KNOWN_DEFAULTS.BOOTSTRAP_ADMIN_PASSWORD, tenantRow.rows[0].admin_pass)).ok;
    // Same auto-rotation escape hatch as above, for the same reason: once the tenant row already
    // exists, there is no UI path to fix an unsafe stored admin_pass without the server booting
    // first.
    if (bootstrapIsKnownDefault && isSafeReplacementCredential(process.env.BOOTSTRAP_ADMIN_PASSWORD, KNOWN_DEFAULTS.BOOTSTRAP_ADMIN_PASSWORD)) {
      await pool.query('UPDATE platform_clients SET admin_pass = $1 WHERE tenant_key = $2', [await hashPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD), TENANT_KEY]);
      console.warn('[SECURITY] The stored bootstrap admin password was a hash of the known public default -- rotated automatically at boot to match BOOTSTRAP_ADMIN_PASSWORD. Safe to unset the env var afterward if you prefer managing it via Settings.');
      await auditLog(pool, { tenantKey: TENANT_KEY, actor: 'system', action: 'unsafe_production_credential_rotated', target: 'bootstrap_admin', meta: {} });
    } else {
      const bootstrapCheck = validateBootstrapCredential({ tenantRowExists: tenantExists, bootstrapCredentialIsKnownDefault: bootstrapIsKnownDefault });
      if (!bootstrapCheck.ok) {
        await auditLog(pool, { tenantKey: TENANT_KEY, actor: 'system', action: bootstrapIsKnownDefault ? 'unsafe_production_credential_detected' : 'unsafe_production_credential_rejected', target: 'bootstrap_admin', meta: {} });
        failStartup(bootstrapCheck.problems);
      }
    }
  }
  // Migrate the one existing real tenant into the directory, exactly once. Purely additive —
  // its tenant_key and app_state row are untouched, so this can never affect the live login
  // or data flow for the real company.
  await pool.query(
    `INSERT INTO platform_clients (tenant_key, name, industry, plan, status, color, initials, admin_email, admin_pass, modules)
     VALUES ($1, 'SproutRipple PH', 'HR Technology', 'Internal', 'active', '#4f46e5', 'S', $2, $3, '[]')
     ON CONFLICT (tenant_key) DO NOTHING`,
    [TENANT_KEY, process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@ph.com', await hashPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123')]
  );
  await bulkMigrateLegacyPasswords();
  await grandfatherZkCommandPermission();
}
// app_state has ENABLE + FORCE ROW LEVEL SECURITY (see initializeDatabase) -- a plain, unscoped
// `SELECT * FROM app_state` only ever appears to return every tenant's rows because the local dev
// role happens to be a Postgres superuser (superusers bypass RLS entirely, FORCE included; only a
// non-superuser table owner is actually affected by FORCE). A real production role without
// BYPASSRLS would get zero rows back from that query and no error -- silently migrating nothing,
// tenant isolation intact but the migration itself dead on arrival. platform_clients is the one
// table deliberately left outside RLS (by-design cross-tenant directory access), so it's the only
// safe source for "every tenant_key that exists" -- this enumerates from there, then does one
// withTenantScope(tenantKey, ...) per tenant so each app_state read/write actually carries the
// app.tenant_key setting its RLS policy requires, instead of relying on a bypass that only exists
// in this local dev database.
async function allTenantKeys() {
  const rows = await pool.query('SELECT tenant_key FROM platform_clients');
  const keys = new Set(rows.rows.map(r => r.tenant_key));
  keys.add(TENANT_KEY); // always included even on a boot where the bootstrap insert hasn't run yet
  return [...keys];
}
// One-time bulk migration of every remaining legacy-plaintext password to a bcrypt hash, run once
// at every boot (idempotent -- looksLikeHash skips anything already migrated, so this is a cheap
// no-op scan on every subsequent restart once a deployment is fully migrated). The lazy,
// login-triggered migration (see verifyPassword's needsMigration flag) stays in place as
// defense-in-depth for whatever this misses between boots, but it alone could leave an inactive
// or rarely-used account's password sitting in plaintext indefinitely; this closes that gap
// without waiting for that account to ever log in again.
//
// Sequential across tenants/rows rather than one big query -- simple and safe for this project's
// current size (a handful of tenants), and consistent with grandfatherZkCommandPermission's own
// same pattern just below. Never logs a credential value, only counts.
async function bulkMigrateLegacyPasswords() {
  if (!pool) return;
  let usersMigrated = 0, clientAdminsMigrated = 0, godAdminMigrated = 0;

  const tenantKeys = await allTenantKeys();
  for (const tenantKey of tenantKeys) {
    await withTenantScope(tenantKey, async client => {
      const row = (await client.query('SELECT state FROM app_state WHERE tenant_key = $1', [tenantKey])).rows[0];
      const users = row?.state?.users;
      if (!Array.isArray(users)) return;
      let changed = false;
      for (const u of users) {
        if (u && typeof u.pass === 'string' && u.pass && !looksLikeHash(u.pass)) {
          u.pass = await hashPassword(u.pass);
          changed = true;
          usersMigrated++;
        }
      }
      if (changed) {
        await client.query('UPDATE app_state SET state = $1 WHERE tenant_key = $2', [row.state, tenantKey]);
      }
    });
  }

  // platform_clients and platform_admin_credential are both deliberately outside RLS (see
  // initializeDatabase) -- a plain pool.query is already safe for these, no per-tenant scoping needed.
  const clientRows = await pool.query('SELECT id, admin_pass FROM platform_clients');
  for (const c of clientRows.rows) {
    if (c.admin_pass && !looksLikeHash(c.admin_pass)) {
      await pool.query('UPDATE platform_clients SET admin_pass = $1 WHERE id = $2', [await hashPassword(c.admin_pass), c.id]);
      clientAdminsMigrated++;
    }
  }

  const godRow = await pool.query('SELECT password FROM platform_admin_credential WHERE id = 1');
  if (godRow.rowCount && godRow.rows[0].password && !looksLikeHash(godRow.rows[0].password)) {
    await setGodAdminPassword(godRow.rows[0].password, 'system:bulk-migration');
    godAdminMigrated = 1;
  }

  if (usersMigrated || clientAdminsMigrated || godAdminMigrated) {
    console.log(`[password migration] user credentials migrated: ${usersMigrated}, client admin credentials migrated: ${clientAdminsMigrated}, God Admin credentials migrated: ${godAdminMigrated}`);
    await auditLog(pool, { tenantKey: null, actor: 'system', action: 'bulk_password_migration', target: null, meta: { usersMigrated, clientAdminsMigrated, godAdminMigrated } });
  }
}
// zkcommand (device reboot/clear-log/resync) used to be bundled into zksetup (view/register/
// configure) -- see server/authorization.js's canCommandZkDevices comment. Splitting them is the
// correct security posture (destructive device commands deserve a narrower grant than just
// seeing device status), but every tenant's access levels are already persisted with whatever
// zksetup alone used to imply, and nothing about that JSONB re-derives itself from the current
// ACCESS_PRESETS definitions in index.html on load. Without this, every existing tenant that
// already granted zksetup to some role would silently lose ZK command capability the moment this
// shipped -- a real regression, not just a stricter default. Run once at every boot (idempotent:
// a level that already has zkcommand set, true or false, is left alone) so it only ever grants
// zkcommand where zksetup was already true and zkcommand was never explicitly configured either
// way.
async function grandfatherZkCommandPermission() {
  if (!pool) return;
  // Same RLS-under-real-enforcement concern as bulkMigrateLegacyPasswords above (see
  // allTenantKeys' own comment) -- enumerate tenants via platform_clients, then read/write each
  // tenant's app_state row inside its own withTenantScope instead of one unscoped global SELECT.
  const tenantKeys = await allTenantKeys();
  for (const tenantKey of tenantKeys) {
    await withTenantScope(tenantKey, async client => {
      const row = (await client.query('SELECT state FROM app_state WHERE tenant_key = $1', [tenantKey])).rows[0];
      const levels = row?.state?.accessLevels;
      if (!Array.isArray(levels)) return;
      let changed = false;
      levels.forEach(level => {
        if (level?.perms?.zksetup === true && level.perms.zkcommand === undefined) {
          level.perms.zkcommand = true;
          changed = true;
        }
      });
      if (changed) {
        await client.query('UPDATE app_state SET state = $1 WHERE tenant_key = $2', [row.state, tenantKey]);
      }
    });
  }
}
// The currently effective God Admin password -- the DB-stored override if one has ever been
// set via Settings, otherwise the GOD_ADMIN_PASSWORD env var (or its hardcoded default). This is
// the single source of truth both /auth/login and the change-password endpoint below compare
// against, so a changed password actually takes effect for every future login, not just the
// browser tab that changed it.
async function godAdminPassword() {
  if (pool) {
    const row = await pool.query('SELECT password FROM platform_admin_credential WHERE id = 1');
    if (row.rowCount) return row.rows[0].password;
  }
  return process.env.GOD_ADMIN_PASSWORD || 'godmode2026';
}
async function setGodAdminPassword(newPassword, updatedBy) {
  const hash = await hashPassword(newPassword);
  await pool.query(
    `INSERT INTO platform_admin_credential (id, password, updated_by) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET password = $1, updated_at = NOW(), updated_by = $2`,
    [hash, updatedBy]
  );
}
// Hash-aware check against the currently effective God Admin password, with lazy migration: if
// the stored value is still legacy plaintext (an env-var default that's never been changed via
// Settings, or an old DB row from before this migration) and the supplied password matches it,
// persist a hash over it before returning so this only ever happens once per account.
async function verifyGodAdminPassword(password) {
  const stored = await godAdminPassword();
  const { ok, needsMigration } = await verifyPassword(password, stored);
  if (ok && needsMigration && pool) await setGodAdminPassword(password, 'system:migration');
  return ok;
}
// Defense-in-depth below application-layer tenant checks: app_state, app_state_audit, and
// zk_devices all carry a Postgres Row-Level Security policy (see initializeDatabase) that
// compares each row's tenant_key against this session-local GUC. A query that forgets to filter
// by tenant_key -- exactly the bug class the ZK endpoints had -- now returns no rows at all
// instead of every tenant's, even if the WHERE clause is wrong or missing entirely. Every
// pool.connect()-based call against those three tables MUST set this (via withTenantScope or,
// for the one deliberate cross-tenant exception, withLoginLookupScope) before querying them --
// a plain pool.query() against a pooled connection with no scope set will see zero rows.
async function withTenantScope(tenantKey, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_key', $1, true)", [String(tenantKey)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
// The ONE legitimate cross-tenant read: /api/auth/login's employee search has to scan every
// tenant's app_state, because at that point in the request we don't yet know which tenant the
// submitted credentials belong to -- that's literally what this query is resolving. Every other
// query goes through withTenantScope instead. Deliberately read-only by convention (nothing here
// technically stops a write, so never use this for one) -- keeping it to this single call site
// is what makes that safe.
async function withLoginLookupScope(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.login_lookup', 'true', true)");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function readState(tenantKey = TENANT_KEY) {
  if (!pool) return null;
  return withTenantScope(tenantKey, async client => {
    const result = await client.query('SELECT state, version, updated_at FROM app_state WHERE tenant_key = $1', [tenantKey]);
    return result.rows[0] || null;
  });
}

// zk_devices lives in its own table, separate from app_state, specifically so device pushes
// (which happen independently of any browser session) can never be clobbered by the browser's
// full-state overwrite in PUT /api/state.
async function zkMutateDevice(serial, mutator, tenantKey = TENANT_KEY) {
  if (!pool) return null;
  return withTenantScope(tenantKey, async client => {
    const existing = await client.query('SELECT pending, device_users, commands FROM zk_devices WHERE tenant_key = $1 AND serial = $2 FOR UPDATE', [tenantKey, serial]);
    const row = existing.rows[0] || { pending: [], device_users: [], commands: [] };
    const next = mutator({ pending: row.pending || [], deviceUsers: row.device_users || [], commands: row.commands || [] }) || {};
    await client.query(
      `INSERT INTO zk_devices (tenant_key, serial, last_seen, pending, device_users, commands, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, $5, NOW())
       ON CONFLICT (tenant_key, serial) DO UPDATE SET last_seen = NOW(), pending = $3, device_users = $4, commands = $5, updated_at = NOW()`,
      [tenantKey, serial, JSON.stringify(next.pending || []), JSON.stringify(next.deviceUsers || []), JSON.stringify(next.commands || [])]
    );
  });
}
async function zkAllDevices(tenantKey = TENANT_KEY) {
  if (!pool) return [];
  return withTenantScope(tenantKey, async client => {
    const result = await client.query('SELECT serial, last_seen, pending, device_users, commands FROM zk_devices WHERE tenant_key = $1', [tenantKey]);
    return result.rows;
  });
}
// The device-facing /iclock/* endpoints have no session -- ZKTeco's ADMS push protocol only
// ever sends the device's own serial, nothing that identifies a tenant. This is the one place
// that resolves serial -> tenant, so an unregistered device (including the one real device
// already configured against this deployment today) safely falls back to the original tenant
// instead of failing or needing to be registered retroactively.
async function resolveDeviceTenant(serial) {
  if (!pool) return TENANT_KEY;
  const result = await pool.query('SELECT tenant_key FROM zk_device_registry WHERE serial = $1', [serial]);
  return result.rowCount ? result.rows[0].tenant_key : TENANT_KEY;
}

// Row-level lock on app_state so this can never race the browser's PUT /api/state —
// Postgres serializes any concurrent writer against the same row automatically.
async function mutateAppState(mutator, actor, tenantKey = TENANT_KEY) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_key', $1, true)", [String(tenantKey)]);
    const existing = await client.query('SELECT state, version FROM app_state WHERE tenant_key = $1 FOR UPDATE', [tenantKey]);
    const row = existing.rows[0];
    const state = row ? row.state : {};
    const outcome = mutator(state) || {};
    if (!outcome.changed) { await client.query('ROLLBACK'); return { state, version: row ? Number(row.version) : 0, changed: false }; }
    let version;
    if (row) {
      const updated = await client.query('UPDATE app_state SET state = $1, version = version + 1, updated_at = NOW(), updated_by = $2 WHERE tenant_key = $3 RETURNING version', [state, actor, tenantKey]);
      version = Number(updated.rows[0].version);
    } else {
      const inserted = await client.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3) RETURNING version', [tenantKey, state, actor]);
      version = Number(inserted.rows[0].version);
    }
    await client.query('INSERT INTO app_state_audit (tenant_key, version, actor) VALUES ($1, $2, $3)', [tenantKey, version, actor]);
    await client.query('COMMIT');
    return { state, version, changed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ZKTeco ATTLOG status codes: 0/4 mean the employee punched "in" on the device's own
// toggle, 1/2/3/5 mean "out" (check-out / break-out / break-in / overtime-out all read as
// an "out" in our simple tin/tout model). Anything else (missing or unrecognized) is left
// unclassified so that day falls back to the earliest/latest heuristic instead of guessing.
function zkPunchKind(statusCode) {
  if (statusCode === '0' || statusCode === '4') return 'in';
  if (statusCode === '1' || statusCode === '2' || statusCode === '3' || statusCode === '5') return 'out';
  return null;
}

function appendNote(existingNotes, note) {
  const notes = String(existingNotes || '').split(' · ').filter(Boolean);
  if (notes.indexOf(note) < 0) notes.push(note);
  return notes.join(' · ');
}

// Builds a specific, approver-facing reason for why a punch couldn't be matched to a
// scheduled shift day, instead of a single generic message — rest-day punches (by far the
// most common case) need to read differently from a genuinely missing/misconfigured shift.
function describeOutOfWindowReason(employee, punchDate, shifts) {
  const name = (employee && employee.name) || 'This employee';
  const shift = (shifts || []).find(s => s.id === (employee && employee.shiftId));
  if (!shift) return `No matching shift configuration found for ${name} — needs manual confirmation.`;
  if (TimekeepingCore.isRestDay(employee, punchDate, shifts)) {
    return `Rest day punch — ${punchDate} is a scheduled rest day (not a working day) on ${name}'s "${shift.name || 'assigned'}" shift. Confirm this is authorized rest-day work before approving.`;
  }
  return `Punch time falls outside the allowed buffer around ${name}'s scheduled shift hours — needs confirmation.`;
}

// Permanently folds every incoming punch into the day's record (via TimekeepingCore.mergePunches
// -- additive only, nothing already captured is ever dropped or replaced) and re-derives
// tin/tout/late/undertime/OT/night-differential/rest-day-holiday hours from the FULL punch log
// using the employee's actual schedule, instead of the flat "tin>=08:30 is late" heuristic and
// always-zero OT/ND this used to leave for a human to fill in by hand.
// outOfBufferReasons (empId|date -> reason text) mark days where the punch fell outside the
// employee's scheduled shift buffer — those are committed but flagged pending instead of
// auto-approved, with the specific reason surfaced to the approver.
function zkCommitPunches(state, punchesByEmpDate, outOfBufferReasons) {
  state.attendance = Array.isArray(state.attendance) ? state.attendance : [];
  let nextId = state.attendance.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
  const employees = state.users || [];
  const shifts = (state.company && state.company.shifts) || [];
  const receivedAt = new Date().toISOString();
  let committed = 0;
  punchesByEmpDate.forEach((entries, key) => {
    const sep = key.indexOf('|');
    const empId = Number(key.slice(0, sep));
    const date = key.slice(sep + 1);
    const employee = employees.find(u => u.id === empId);
    const existing = state.attendance.find(r => r.eid === empId && r.date === date && r.active !== false);
    const mergedPunches = TimekeepingCore.mergePunches(existing && existing.punches, entries.map(e => Object.assign({ receivedAt }, e)));
    const schedule = employee ? TimekeepingCore.scheduleForDate(employee, date, shifts) : null;
    const isRestDay = employee ? TimekeepingCore.isRestDay(employee, date, shifts) : false;
    const noPolicy = employee && (employee.scheduleType === 'exempted' || employee.scheduleType === 'flexWeek');
    const rawComputed = TimekeepingCore.computeFromPunches(mergedPunches, schedule, isRestDay, employee && employee.scheduleType) || {};
    const computed = (isRestDay || noPolicy) ? rawComputed : TimekeepingCore.applyAttendancePolicy(rawComputed, schedule, state.attendancePolicy);
    const reason = outOfBufferReasons && outOfBufferReasons.get(key);
    const policyNote = computed.policyNotes ? computed.policyNotes.join(' · ') : '';
    const patch = Object.assign({}, computed, {
      punches: mergedPunches,
      status: (computed.lwop || computed.incomplete) ? 'absent' : isRestDay ? (existing ? existing.status : 'present') : (computed.lateMinutes > 0 ? 'late' : 'present'),
      source: 'zkteco-realtime', approvalStatus: reason ? 'pending' : 'approved', filedBy: 'ZKTeco realtime',
      active: true, updatedAt: receivedAt
    });
    if (reason) patch.notes = appendNote(existing && existing.notes, reason);
    else if (policyNote) patch.notes = appendNote(existing && existing.notes, policyNote);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.attendance.push(Object.assign({ id: nextId++, eid: empId, date, notes: '' }, patch));
    }
    committed++;
  });
  return committed;
}

const authz = createAuthorization({ readState, tenantKeyOf: req => req.session.tenantKey || TENANT_KEY });

app.get('/api/health', async (_req, res) => {
  try {
    if (pool) await pool.query('SELECT 1');
    res.json({ ok: true, database: pool ? 'connected' : 'not_configured' });
  } catch (error) {
    res.status(503).json({ ok: false, database: 'unavailable', error: error.message });
  }
});
// Persists a freshly-verified legacy-plaintext password as a bcrypt hash for one specific
// employee, the moment (and only the moment) it's been proven correct by a successful login --
// see server/passwords.js's own comment for why this has to be lazy rather than a batch job.
async function migrateUserPasswordHash(tenantKey, userId, plaintext) {
  if (!pool) return;
  const hash = await hashPassword(plaintext);
  await mutateAppState(state => {
    const u = (state.users || []).find(x => x.id === userId);
    if (!u || u.pass === hash) return { changed: false };
    u.pass = hash;
    return { changed: true };
  }, 'system:migration', tenantKey);
}
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  // Two independent limiters (per normalized email, per source IP) so an attack concentrated on
  // one account from many addresses and an attack spraying many accounts from one address are
  // both caught, without either legitimate account or address blocking an unrelated one -- see
  // server/rate-limit.js. Checked before any password verification work happens at all,
  // including the God Admin branch below.
  const emailBlock = loginEmailLimiter.isBlocked(email);
  const ipBlock = loginIpLimiter.isBlocked(ip);
  if (emailBlock.blocked || ipBlock.blocked) {
    const retryAfterMs = Math.max(emailBlock.retryAfterMs, ipBlock.retryAfterMs);
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    // Same generic message as a wrong password, and no indication of which key tripped it, so
    // this can't be used to enumerate whether a given email exists.
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  const loginFail = async reason => {
    const justBlockedByEmail = loginEmailLimiter.recordFailure(email);
    const justBlockedByIp = loginIpLimiter.recordFailure(ip);
    await auditLog(pool, { tenantKey: null, actor: email || 'unknown', action: 'login_failed', target: email, meta: { reason } });
    if (justBlockedByEmail || justBlockedByIp) {
      await auditLog(pool, { tenantKey: null, actor: email || 'unknown', action: 'login_rate_limited', target: email, meta: { by: justBlockedByEmail ? 'email' : 'ip' } });
    }
    return res.status(401).json({ error: 'Invalid email or password.' });
  };
  try {
    // Platform God Admin — platform-wide, not scoped to any one tenant. Still returns the
    // legacy tenant's state exactly as before: the frontend's Platform Admin console reads
    // its client list from state.platformClients until Step 3 moves it onto
    // GET /api/platform/clients instead, so this can't change yet without losing visibility
    // into anything already saved there (archived demo clients, etc.).
    if (email === 'god@sproutripple.com') {
      const ok = await verifyGodAdminPassword(password);
      if (!ok) return loginFail('god-admin-bad-password');
      loginEmailLimiter.recordSuccess(email);
      loginIpLimiter.recordSuccess(ip);
      const record = await readState(TENANT_KEY);
      const token = sign({ sub: email, role: 'platform', tenantKey: TENANT_KEY, exp: Date.now() + 8 * 60 * 60 * 1000 });
      await auditLog(pool, { tenantKey: null, actor: email, action: 'login_succeeded', target: email, meta: { role: 'platform' } });
      return res.json({ token, state: stripPasswordHashes(record?.state || null), version: Number(record?.version || 0), persistence: Boolean(pool) });
    }

    // 1. The one original real tenant — checked first, on the exact same fixed tenant_key,
    //    so this deployment's actual working login can never change under this rewrite.
    const legacyRecord = await readState(TENANT_KEY);
    const legacyUsers = legacyRecord?.state?.users || [];
    let matchedUser = null;
    const legacyCandidate = legacyUsers.find(u => String(u.email || '').toLowerCase() === email && u.active !== false);
    if (legacyCandidate) {
      const { ok, needsMigration } = await verifyPassword(password, legacyCandidate.pass);
      if (ok) {
        matchedUser = legacyCandidate;
        if (needsMigration) await migrateUserPasswordHash(TENANT_KEY, legacyCandidate.id, password);
      }
    }
    const bootstrapAdmin = !legacyRecord && email === (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@ph.com').toLowerCase()
      && password === (process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123');
    let tenantKey = (matchedUser || bootstrapAdmin) ? TENANT_KEY : null;
    let record = tenantKey ? legacyRecord : null;

    // 2. A real client's own company-admin account (platform_clients.admin_email/admin_pass).
    //    admin_email is UNIQUE, so this is always at most one row -- password matching has to
    //    happen in application code now that admin_pass may be a hash, not a SQL '=' filter.
    if (!tenantKey && pool) {
      const clientRow = await pool.query('SELECT id, tenant_key, admin_pass FROM platform_clients WHERE admin_email = $1', [email]);
      if (clientRow.rowCount) {
        const c = clientRow.rows[0];
        const { ok, needsMigration } = await verifyPassword(password, c.admin_pass);
        if (ok) {
          tenantKey = c.tenant_key;
          if (needsMigration) await pool.query('UPDATE platform_clients SET admin_pass = $1 WHERE id = $2', [await hashPassword(password), c.id]);
        }
      }
    }

    // 3. A regular employee of some other real client — search every tenant's own users array
    //    directly via JSONB instead of keeping a separate index in sync. This is the one place
    //    in the app that legitimately needs to see every tenant's app_state at once (we don't
    //    know which tenant these credentials belong to until this query resolves it) -- see
    //    withLoginLookupScope's own comment for why that's safe under RLS. Password matching can
    //    no longer be pushed into the SQL WHERE clause (hashes can't be compared with '='), and
    //    an email isn't guaranteed globally unique across different tenants' own users[], so this
    //    fetches every candidate and verifies each in turn rather than trusting a single LIMIT 1.
    if (!tenantKey && pool) {
      const empRows = await withLoginLookupScope(client => client.query(
        `SELECT tenant_key, state, version, u AS matched_user FROM app_state, jsonb_array_elements(state->'users') AS u
         WHERE u->>'email' = $1 AND COALESCE((u->>'active')::boolean, true) = true`,
        [email]
      ));
      for (const row of empRows.rows) {
        const { ok, needsMigration } = await verifyPassword(password, row.matched_user.pass);
        if (!ok) continue;
        tenantKey = row.tenant_key; record = row; matchedUser = row.matched_user;
        if (needsMigration) await migrateUserPasswordHash(tenantKey, matchedUser.id, password);
        break;
      }
    }

    if (!tenantKey) return loginFail('no-match');
    loginEmailLimiter.recordSuccess(email);
    loginIpLimiter.recordSuccess(ip);
    if (!record) record = await readState(tenantKey);

    const role = (matchedUser && matchedUser.role) || 'admin';
    const token = sign({ sub: email, role, tenantKey, exp: Date.now() + 8 * 60 * 60 * 1000 });
    await auditLog(pool, { tenantKey, actor: email, action: 'login_succeeded', target: email, meta: { role } });
    const fullState = record?.state || null;
    const state = (role === 'employee' && fullState) ? buildScopedStateForEmployee(fullState, { sub: email, role, tenantKey }) : stripPasswordHashes(fullState);
    res.json({ token, state, version: Number(record?.version || 0), persistence: Boolean(pool) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to sign in to the data service.', detail: error.message });
  }
});

/* ── Shared transactional email + one-time-code helpers ──
   Used by Web Bundy guest access, forgot-password, and (eventually) filing/approval
   notifications -- one Resend integration and one code-hashing scheme for all of them. */
function hashOtpCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}
function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}
async function sendAppEmail(to, subject, html) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) throw new Error('Email delivery is not configured on this server yet.');
  const from = process.env.EMAIL_FROM || process.env.BUNDY_OTP_FROM_EMAIL || 'AURA <onboarding@resend.dev>';
  const apiRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html })
  });
  if (!apiRes.ok) {
    const data = await apiRes.json().catch(() => ({}));
    throw new Error(data.message || 'Failed to send email.');
  }
}
function otpCodeEmailHtml(name, code, purposeSentence, expiryMinutes) {
  return `<p>Hi ${name},</p><p>${purposeSentence}</p>`
    + `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>`
    + `<p>This code expires in ${expiryMinutes} minutes. If you didn't request this, you can ignore this email.</p>`;
}
// Built-in wording for every outbound notification email -- an admin can override subject/body
// per tenant from Company Settings (saved to state.company.emailTemplates[type]); composeEmail()
// below falls back to these whenever a tenant hasn't customized a given type. Keep this list and
// its {{placeholder}} names in sync with EMAIL_NOTIFICATION_TYPES in public/index.html (the
// Settings UI's copy of the same static legend -- there's no shared module between the Node
// backend and the browser bundle, so the two are intentionally duplicated).
const DEFAULT_EMAIL_TEMPLATES = {
  'leave-filed': {
    subject: 'Leave request from {{employeeName}}',
    body: 'Hi {{approverName}},\n\n{{employeeName}} filed a {{leaveType}} request for {{days}} day(s), from {{from}} to {{to}}.\n\nPlease review it in AURA.'
  },
  'leave-decided': {
    subject: 'Your leave request was {{decision}}',
    body: 'Hi {{employeeName}},\n\nYour {{leaveType}} request ({{from}} to {{to}}) was {{decision}} by {{decidedBy}}.'
  },
  'case-filed': {
    subject: '{{formLabel}} filed by {{employeeName}}',
    body: "Hi there,\n\n{{employeeName}} filed a {{formLabel}} request for {{date}}.\n\nPlease review it in AURA's Resolution Center."
  },
  'case-decided': {
    subject: 'Update on {{caseSubject}}',
    body: 'Hi {{employeeName}},\n\nYour request "{{caseSubject}}" was {{decision}} by {{decidedBy}}.'
  },
  'password-changed': {
    subject: 'Your AURA password was changed',
    body: "Hi {{employeeName}},\n\nYour AURA password was just changed by {{changedBy}}.\n\nIf this wasn't you, contact your administrator immediately."
  },
  'payroll-submitted': {
    subject: 'Payroll submitted for approval ({{period}})',
    body: 'Hi there,\n\n{{submittedBy}} submitted a payroll run for {{period}}.\n\nPlease review it in AURA.'
  },
  'payslip-released': {
    subject: 'Your payslip is ready ({{period}})',
    body: 'Hi {{employeeName}},\n\nYour payslip for {{period}} is now available in AURA under My Payslips.'
  },
  'employee-welcome': {
    subject: 'Welcome to AURA',
    body: "Hi {{employeeName}},\n\n{{addedBy}} just set up your AURA account.\n\nYour login:\nEmail: {{employeeEmail}}\nPassword: {{tempPassword}}\n\nWe recommend changing your password after your first login.\n\nSign in at your company's AURA link to get started."
  },
  'employee-offboarded': {
    subject: 'Employee offboarded: {{employeeName}}',
    body: 'Hi there,\n\n{{employeeName}} ({{eid}}) access to AURA was disabled by {{offboardedBy}}.'
  }
};
// Subject lines are plain text (an email header, never rendered as HTML), so placeholders are
// substituted with their raw values -- no escaping.
function substitutePlain(text, vars) {
  return String(text || '')
    .replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars) ? String(vars[key]) : m)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}
// Body templates are admin-authored plain text, never raw HTML -- the whole literal template is
// escaped FIRST (so an admin can't inject markup/script into an email sent on their behalf), then
// {{placeholders}} (which survive escaping intact) are substituted with escaped runtime values,
// and blank-line-separated paragraphs become <p>/<br> for basic formatting.
function renderTemplateBody(text, vars) {
  let escaped = escapeEmailHtml(text || '');
  escaped = escaped.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars) ? escapeEmailHtml(String(vars[key])) : m);
  return escaped.split(/\n{2,}/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
}
// Looks up the tenant's own customized subject/body for `type` (state.company.emailTemplates,
// edited from Company Settings) and falls back to DEFAULT_EMAIL_TEMPLATES when the tenant hasn't
// customized it. Every /api/notify send and every inline password-changed alert compose through
// this one function, so a tenant's customization applies consistently everywhere that email type
// is sent from.
async function composeEmail(tenantKey, type, vars) {
  const def = DEFAULT_EMAIL_TEMPLATES[type];
  if (!def) throw new Error('Unknown email template type: ' + type);
  let custom = null;
  try {
    const record = await readState(tenantKey);
    custom = record?.state?.company?.emailTemplates?.[type] || null;
  } catch {}
  const subjectSrc = (custom && custom.subject) ? custom.subject : def.subject;
  const bodySrc = (custom && custom.body) ? custom.body : def.body;
  return { subject: substitutePlain(subjectSrc, vars), html: renderTemplateBody(bodySrc, vars) };
}

/* ── Forgot password (self-service, unauthenticated) ──
   Covers the same two account shapes /api/auth/login resolves against, minus God Admin -- that
   platform-wide identity has no real inbox behind its address, so its password stays
   changeable only from Settings (requires the current password) as before. Mirrors the login
   endpoint's own tenant-resolution order: the legacy/bootstrap tenant's own employees first,
   then a real client's own company-admin account, then any other tenant's employee (the one
   legitimate cross-tenant lookup, same as login's). */
const passwordResetOtps = new Map(); // email -> { codeHash, expiresAt, attempts, accountType, tenantKey|clientId, userId, name }
app.post('/api/auth/forgot-password/request', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!pool) return res.status(503).json({ error: 'Password reset requires the database to be configured.' });

    const legacyRecord = await readState(TENANT_KEY);
    const legacyUsers = legacyRecord?.state?.users || [];
    const legacyMatch = legacyUsers.find(u => String(u.email || '').toLowerCase() === email && u.active !== false);
    if (legacyMatch) {
      const name = legacyMatch.firstName || (legacyMatch.name || '').split(' ')[0] || 'there';
      const code = generateOtpCode();
      passwordResetOtps.set(email, { codeHash: hashOtpCode(code), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, accountType: 'tenant-user', tenantKey: TENANT_KEY, userId: legacyMatch.id, name });
      await sendAppEmail(email, 'Reset your AURA password', otpCodeEmailHtml(name, code, 'Use this code to reset your password:', 10));
      return res.json({ ok: true });
    }

    const clientRow = await pool.query('SELECT id, name, tenant_key FROM platform_clients WHERE admin_email = $1', [email]);
    if (clientRow.rowCount) {
      const c = clientRow.rows[0];
      const code = generateOtpCode();
      passwordResetOtps.set(email, { codeHash: hashOtpCode(code), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, accountType: 'client-admin', clientId: c.id, tenantKey: c.tenant_key, name: c.name });
      await sendAppEmail(email, 'Reset your AURA password', otpCodeEmailHtml(c.name, code, 'Use this code to reset your password:', 10));
      return res.json({ ok: true });
    }

    const empRow = await withLoginLookupScope(client => client.query(
      `SELECT tenant_key, u AS matched_user FROM app_state, jsonb_array_elements(state->'users') AS u
       WHERE u->>'email' = $1 AND COALESCE((u->>'active')::boolean, true) = true
       LIMIT 1`,
      [email]
    ));
    if (empRow.rowCount) {
      const { tenant_key: tenantKey, matched_user: matchedUser } = empRow.rows[0];
      const name = matchedUser.firstName || (matchedUser.name || '').split(' ')[0] || 'there';
      const code = generateOtpCode();
      passwordResetOtps.set(email, { codeHash: hashOtpCode(code), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, accountType: 'tenant-user', tenantKey, userId: matchedUser.id, name });
      await sendAppEmail(email, 'Reset your AURA password', otpCodeEmailHtml(name, code, 'Use this code to reset your password:', 10));
      return res.json({ ok: true });
    }

    res.status(404).json({ error: 'No account found with that email.' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to send the verification code.' });
  }
});
app.post('/api/auth/forgot-password/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const newPassword = String(req.body.newPassword || '');
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  if (!pool) return res.status(503).json({ error: 'Password reset requires the database to be configured.' });
  const entry = passwordResetOtps.get(email);
  if (!entry) return res.status(400).json({ error: 'Request a new code first.' });
  if (Date.now() > entry.expiresAt) { passwordResetOtps.delete(email); return res.status(400).json({ error: 'That code expired. Request a new one.' }); }
  entry.attempts += 1;
  if (entry.attempts > 5) { passwordResetOtps.delete(email); return res.status(429).json({ error: 'Too many attempts. Request a new code.' }); }
  const suppliedHash = hashOtpCode(code);
  const match = suppliedHash.length === entry.codeHash.length && crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(entry.codeHash));
  if (!match) return res.status(401).json({ error: 'Incorrect code.' });
  passwordResetOtps.delete(email);
  try {
    const newHash = await hashPassword(newPassword);
    if (entry.accountType === 'client-admin') {
      await pool.query('UPDATE platform_clients SET admin_pass = $1 WHERE id = $2', [newHash, entry.clientId]);
    } else {
      await mutateAppState(state => {
        const u = (state.users || []).find(x => x.id === entry.userId);
        if (!u) return { changed: false };
        u.pass = newHash;
        return { changed: true };
      }, email, entry.tenantKey);
    }
    await auditLog(pool, { tenantKey: entry.tenantKey, actor: email, action: 'password_reset', target: email, meta: { via: 'forgot-password' } });
    composeEmail(entry.tenantKey, 'password-changed', { employeeName: entry.name || 'there', changedBy: 'you (via Forgot Password)' })
      .then(({ subject, html }) => sendAppEmail(email, subject, html)).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to reset the password.', detail: error.message });
  }
});
// Self-service password change for an already-logged-in user -- covers both a real employee
// (state.users[] entry) and a company's own admin login (platform_clients.admin_pass), which
// live in two entirely different places. The frontend's previous "Change Password" modal only
// ever mutated USERS[] client-side and relied on the next full /api/state save to persist it,
// which silently did nothing for an admin-type login (no matching USERS[] entry to find at
// all) while also never actually checking the current password server-side.
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const { tenantKey, sub } = req.session;
  try {
    const record = await readState(tenantKey);
    const users = record?.state?.users || [];
    const match = users.find(u => String(u.email || '').toLowerCase() === String(sub || '').toLowerCase());
    if (match) {
      const { ok } = await verifyPassword(currentPassword, match.pass);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
      const newHash = await hashPassword(newPassword);
      await mutateAppState(state => {
        const u = (state.users || []).find(x => x.id === match.id);
        if (!u) return { changed: false };
        u.pass = newHash;
        return { changed: true };
      }, sub, tenantKey);
      await auditLog(pool, { tenantKey, actor: sub, action: 'password_change', target: sub, meta: { via: 'self-service' } });
      composeEmail(tenantKey, 'password-changed', { employeeName: match.firstName || match.name || 'there', changedBy: 'you' })
        .then(({ subject, html }) => sendAppEmail(sub, subject, html)).catch(() => {});
      return res.json({ ok: true });
    }
    const clientRow = await pool.query('SELECT id, admin_pass FROM platform_clients WHERE tenant_key = $1', [tenantKey]);
    if (!clientRow.rowCount) return res.status(404).json({ error: 'Account not found.' });
    const { ok } = await verifyPassword(currentPassword, clientRow.rows[0].admin_pass);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
    await pool.query('UPDATE platform_clients SET admin_pass = $1 WHERE id = $2', [await hashPassword(newPassword), clientRow.rows[0].id]);
    await auditLog(pool, { tenantKey, actor: sub, action: 'password_change', target: sub, meta: { via: 'self-service-admin' } });
    composeEmail(tenantKey, 'password-changed', { employeeName: 'there', changedBy: 'you' })
      .then(({ subject, html }) => sendAppEmail(sub, subject, html)).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update the password.', detail: error.message });
  }
});

/* ── Web Bundy guest access (email OTP) ──
   Replaces the old "type any employee's email, no password, get in" guest shortcut, which
   effectively granted full account access to anyone who knew (or guessed) an employee's email --
   see the readiness-audit finding this closes. An OTP mailed to that same employee's own address
   proves inbox access before anything is issued, and the token this flow ends with (purpose:
   'bundy-punch', 20-minute expiry) is only ever accepted by the two narrow endpoints below, never
   by /api/state or anything else -- a verified guest can punch in/out and read today's own log,
   nothing more, regardless of what the underlying employee record could otherwise see. */
const bundyOtps = new Map(); // email -> { codeHash, expiresAt, attempts, tenantKey, eid, name }
function requireBundyAuth(req, res, next) {
  const payload = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!payload || payload.purpose !== 'bundy-punch') return res.status(401).json({ error: 'Your verification has expired. Please verify your email again.' });
  req.bundy = payload;
  next();
}
app.post('/api/bundy/otp/request', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!pool) return res.status(503).json({ error: 'Web Bundy guest access requires the database to be configured.' });
    const found = await withLoginLookupScope(client => client.query(
      `SELECT tenant_key, u AS matched_user FROM app_state, jsonb_array_elements(state->'users') AS u
       WHERE u->>'email' = $1 AND COALESCE((u->>'active')::boolean, true) = true
       LIMIT 1`,
      [email]
    ));
    if (!found.rowCount) return res.status(404).json({ error: 'Email not found or account disabled. Please contact HR.' });
    const { tenant_key: tenantKey, matched_user: matchedUser } = found.rows[0];
    const name = matchedUser.firstName || (matchedUser.name || '').split(' ')[0] || 'there';
    const code = generateOtpCode();
    bundyOtps.set(email, { codeHash: hashOtpCode(code), expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0, tenantKey, eid: matchedUser.id, name });
    await sendAppEmail(email, `Your Web Bundy code: ${code}`, otpCodeEmailHtml(name, code, 'Your Web Bundy verification code is:', 5));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to send the verification code.' });
  }
});
app.post('/api/bundy/otp/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const entry = bundyOtps.get(email);
  if (!entry) return res.status(400).json({ error: 'Request a new code first.' });
  if (Date.now() > entry.expiresAt) { bundyOtps.delete(email); return res.status(400).json({ error: 'That code expired. Request a new one.' }); }
  entry.attempts += 1;
  if (entry.attempts > 5) { bundyOtps.delete(email); return res.status(429).json({ error: 'Too many attempts. Request a new code.' }); }
  const suppliedHash = hashOtpCode(code);
  const expectedHash = entry.codeHash;
  const match = suppliedHash.length === expectedHash.length && crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(expectedHash));
  if (!match) return res.status(401).json({ error: 'Incorrect code.' });
  bundyOtps.delete(email);
  const token = sign({ sub: email, tenantKey: entry.tenantKey, eid: entry.eid, purpose: 'bundy-punch', exp: Date.now() + 20 * 60 * 1000 });
  res.json({ token, name: entry.name });
});
app.get('/api/bundy/today', requireBundyAuth, async (req, res) => {
  try {
    const { tenantKey, eid } = req.bundy;
    const record = await readState(tenantKey);
    const todayStr = new Date().toISOString().slice(0, 10);
    const logs = ((record?.state?.bundyLogs) || []).filter(b => b.eid === eid && b.date === todayStr);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load today’s log.', detail: error.message });
  }
});
app.post('/api/bundy/punch', requireBundyAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const { tenantKey, eid } = req.bundy;
  const type = req.body.type === 'out' ? 'out' : 'in';
  const { lat, lng, accuracy, address, withinZone, selfie } = req.body;
  try {
    await mutateAppState(state => {
      state.users = state.users || [];
      state.attendance = state.attendance || [];
      state.bundyLogs = state.bundyLogs || [];
      const employee = state.users.find(u => u.id === eid);
      if (!employee) return { changed: false };
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const nextBundyId = state.bundyLogs.reduce((max, b) => Math.max(max, b.id || 0), 0) + 1;
      const entry = {
        id: nextBundyId, eid, empName: fmtNameServer(employee), type, date: todayStr,
        time: now.toTimeString().slice(0, 5), datetime: now.toISOString(),
        lat, lng, accuracy, address, withinZone: !!withinZone, selfie: selfie || null,
        source: 'web-bundy-guest'
      };
      state.bundyLogs.push(entry);
      const todaysPunches = state.bundyLogs
        .filter(b => b.eid === eid && b.date === todayStr)
        .map(b => ({ time: b.time, kind: b.type, source: 'web-bundy', receivedAt: b.datetime }));
      const existing = TimekeepingCore.canonicalRecord(state.attendance, eid, todayStr);
      const mergedPunches = TimekeepingCore.mergePunches(existing && existing.punches, todaysPunches);
      const schedule = TimekeepingCore.scheduleForDate(employee, todayStr, state.company?.shifts || []);
      const isRest = TimekeepingCore.isRestDay(employee, todayStr, state.company?.shifts || []);
      const noPolicy = employee.scheduleType === 'exempted' || employee.scheduleType === 'flexWeek';
      const rawComputed = TimekeepingCore.computeFromPunches(mergedPunches, schedule, isRest, employee.scheduleType) || {};
      const computed = (isRest || noPolicy) ? rawComputed : TimekeepingCore.applyAttendancePolicy(rawComputed, schedule, state.attendancePolicy || {});
      const nextAttId = state.attendance.reduce((max, a) => Math.max(max, a.id || 0), 0) + 1;
      TimekeepingCore.upsert(state.attendance, eid, todayStr, {
        ...computed, punches: mergedPunches,
        status: (computed.lwop || computed.incomplete) ? 'absent' : isRest ? 'present' : (computed.lateMinutes > 0 ? 'late' : 'present'),
        notes: 'Web Bundy (guest, email-verified)', ot: 0, approvalStatus: 'approved', filedBy: fmtNameServer(employee)
      }, () => nextAttId, fmtNameServer(employee));
      return { changed: true, entry };
    }, req.bundy.sub, tenantKey);
    res.json({ ok: true, time: new Date().toTimeString().slice(0, 5), type });
  } catch (error) {
    res.status(500).json({ error: 'Unable to record the punch.', detail: error.message });
  }
});

// Password hashes must never reach any client, admin included -- there is no legitimate reason
// for the frontend to ever hold one, and the whole point of "God Admin can't view a password
// either" (see the Access & Permissions UI change) only holds if the value genuinely never
// leaves this process. Shallow-clones state.users with `pass` deleted from every entry; never
// mutates the object passed in, since the same in-memory record can be reused elsewhere in a
// request (e.g. reconcileUserPasswords below reads the pre-strip version back out of Postgres).
function stripPasswordHashes(state) {
  if (!state || !Array.isArray(state.users)) return state;
  return { ...state, users: state.users.map(u => { if (!u || !('pass' in u)) return u; const { pass, ...rest } = u; return rest; }) };
}
// Reconciles state.users[].pass against what's already persisted, mutating in place, so an
// admin-role save is safe to accept even though the frontend never receives a real password or
// hash to send back (see stripPasswordHashes above -- there is nothing else for it to echo).
//   - No `pass` field on the incoming record (the normal case for every existing employee, since
//     the client was never given one to hold onto): keep whatever's already persisted for that
//     user id, if anything.
//   - A non-empty string that isn't already a hash: a real new plaintext value was set by some
//     client-side flow that doesn't have its own server endpoint yet (Add Employee, Bulk Upload,
//     the Access & Permissions "Reset Password" action) -- hash it before it's ever written.
//   - Already a bcrypt hash: left as-is (shouldn't normally happen from a client that's never
//     given one, but safe either way).
async function reconcileUserPasswords(state, previousUsers) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const byId = new Map((previousUsers || []).map(u => [u.id, u]));
  for (const u of users) {
    if (!u) continue;
    if (typeof u.pass !== 'string' || u.pass === '') {
      const prev = byId.get(u.id);
      if (prev && prev.pass) u.pass = prev.pass; else delete u.pass;
    } else if (!looksLikeHash(u.pass)) {
      u.pass = await hashPassword(u.pass);
    }
  }
}
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const tenantKey = req.session.tenantKey || TENANT_KEY;
    const record = await readState(tenantKey);
    const fullState = record?.state || null;
    const state = (req.session.role === 'employee' && fullState)
      ? buildScopedStateForEmployee(fullState, req.session)
      : stripPasswordHashes(fullState);
    res.json({ state, version: Number(record?.version || 0), updatedAt: record?.updated_at || null });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load application data.', detail: error.message });
  }
});
// Regular employees can never replace the full tenant state (see server/state-serialization.js's
// own comment for why) -- an admin/platform session's write is accepted as-is, exactly like
// before, except every plaintext password it might carry gets hashed first. An employee session's
// submitted state is never trusted directly: applyEmployeeStateOverlay reconstructs a safe state
// from what's currently on record, overlaying only that employee's own records in a small set of
// self-service arrays, and everything else -- including every other employee's data, company
// config, and access levels -- is carried over untouched no matter what the payload contains.
app.put('/api/state', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const submittedState = req.body.state;
  const expectedVersion = Number(req.body.version || 0);
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  if (!submittedState || typeof submittedState !== 'object') return res.status(400).json({ error: 'A valid application state is required.' });
  try {
    let stateToPersist = submittedState;
    const current = await readState(tenantKey);
    if (req.session.role === 'employee') {
      const overlaid = applyEmployeeStateOverlay(current?.state || {}, submittedState, req.session);
      if (!overlaid) return res.status(403).json({ error: 'Your account could not be matched to an employee record.' });
      stateToPersist = overlaid;
    } else {
      await reconcileUserPasswords(stateToPersist, current?.state?.users);
    }
    // Backend-authoritative locked-payroll/closed-period immutability (issue 14/15) -- this generic
    // full-state endpoint is the ONE place a locked run or closed period could otherwise be
    // silently edited, deleted, or reopened by any caller with write access to /api/state, no
    // matter what the UI does or doesn't expose. Checked against whatever is ACTUALLY about to be
    // persisted (post employee-overlay too), never skipped for an admin/platform caller.
    const immutability = checkPayrollImmutability(current && current.state, stateToPersist);
    if (!immutability.ok) {
      await auditLog(pool, {
        tenantKey, actor: req.session.sub,
        action: immutability.code === 'CLOSED_PERIOD_DELETED' || immutability.code === 'CLOSED_PERIOD_REOPENED' || immutability.code === 'CLOSED_PERIOD_RELINKED' ? 'closed_period_mutation_blocked' : 'locked_payroll_mutation_blocked',
        target: String(immutability.runId || immutability.periodId || ''),
        meta: { code: immutability.code, field: immutability.field || null }
      });
      return res.status(409).json({ error: immutability.reason });
    }
    const { result, version } = await withTenantScope(tenantKey, async client => {
      const r = expectedVersion === 0
        ? await client.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3) ON CONFLICT DO NOTHING RETURNING version, updated_at', [tenantKey, stateToPersist, req.session.sub])
        : await client.query('UPDATE app_state SET state = $1, version = version + 1, updated_at = NOW(), updated_by = $2 WHERE tenant_key = $3 AND version = $4 RETURNING version, updated_at', [stateToPersist, req.session.sub, tenantKey, expectedVersion]);
      if (!r.rowCount) return { result: r, version: null };
      const v = Number(r.rows[0].version);
      await client.query('INSERT INTO app_state_audit (tenant_key, version, actor) VALUES ($1, $2, $3)', [tenantKey, v, req.session.sub]);
      return { result: r, version: v };
    });
    if (!result.rowCount) return res.status(409).json({ error: 'Newer changes are available. Reload before saving again.' });
    // The client's own in-memory state and this save's actual result diverge for an employee
    // session (their local snapshot may still hold stale copies of fields the overlay discarded),
    // so hand back what was ACTUALLY persisted, scoped exactly like GET /api/state, rather than
    // just an ok/version ack -- the frontend re-hydrates from this on every successful save.
    const responseState = req.session.role === 'employee' ? buildScopedStateForEmployee(stateToPersist, req.session) : undefined;
    res.json({ ok: true, version, updatedAt: result.rows[0].updated_at, state: responseState });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save application data.', detail: error.message });
  }
});

/* ── Attendance/leave approval decisions -- backend-authoritative ──
   Previously "approving" a record was just a client-side mutation (applyAttendanceDecision/
   applyLeaveDecision in public/compliance.js) that got swept up in the next full-state autosave.
   The employee-write overlay's per-record ownership check (server/state-serialization.js) already
   made that unreliable for anyone who wasn't approving their OWN record -- a manager's approval
   of a subordinate's record would just be silently discarded, since it isn't the manager's own
   record. These endpoints are the real fix: the server itself now decides whether the caller may
   act (canActOnRecord in server/approval-chain.js, a backend port of the same chain logic,
   plus a floor permission check and an unconditional self-approval block neither of the client
   functions had), computes the resulting record state, and persists it transactionally via
   mutateAppState. The response includes the authoritative updated record so the frontend never
   has to assume its own optimistic mutation was valid before the server confirms it. */
function loadTargetRecord(state, arrayKey, id) {
  return (state[arrayKey] || []).find(r => r.id === id) || null;
}
app.post('/api/attendance/:id/decision', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  const decision = req.body.decision === 'rejected' ? 'rejected' : req.body.decision === 'approved' ? 'approved' : null;
  if (!Number.isInteger(id) || !decision) return res.status(400).json({ error: 'A valid record id and decision ("approved" or "rejected") are required.' });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    let outcome = null;
    const result = await mutateAppState(state => {
      const record = loadTargetRecord(state, 'attendance', id);
      if (!record) { outcome = { error: 404, message: 'Attendance record not found.' }; return { changed: false }; }
      const gate = canActOnRecord(state, req.session, record, 'att_edit', hasPermission, 'approvalStatus');
      if (!gate.allowed) {
        if (gate.conflict) { outcome = { error: 409, message: gate.reason, conflict: true }; return { changed: false }; }
        outcome = { error: 403, message: gate.reason, selfApproval: /own request/.test(gate.reason) }; return { changed: false };
      }
      const caller = resolveCaller(state, req.session);
      const actorName = caller ? caller.name : (req.session.sub || 'Administrator');
      const decisionResult = applyChainDecision(record, decision, actorName, caller && caller.eid, gate.chain, gate.currentLayer, 'approvalStatus');
      outcome = { record, decisionResult };
      return { changed: true };
    }, req.session.sub, tenantKey);
    if (outcome && outcome.error) {
      if (outcome.selfApproval) await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'self_approval_blocked', target: String(id), meta: { recordType: 'attendance' } });
      if (outcome.conflict) await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'invalid_state_transition_blocked', target: String(id), meta: { recordType: 'attendance' } });
      return res.status(outcome.error).json({ error: outcome.message });
    }
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: decision === 'approved' ? 'attendance_approved' : 'attendance_rejected', target: String(id), meta: { final: outcome.decisionResult.final } });
    res.json({ ok: true, record: outcome.record, message: outcome.decisionResult.message, final: outcome.decisionResult.final, version: result.version });
  } catch (error) {
    res.status(500).json({ error: 'Unable to record the decision.', detail: error.message });
  }
});
// Force-approve: admin-only, skips the remaining chain layers without evaluating them at all --
// port of forceApproveAttendance (public/compliance.js). Leave has no equivalent in the existing
// product (no forceApproveLeave anywhere client-side), so none is added here either. Restricted to
// pending records only, same as the normal decision endpoint above -- an already-decided record
// needs an explicit reopen/override workflow to touch again, not a second silent overwrite of its
// approval history through the same button.
app.post('/api/attendance/:id/force-approve', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid record id is required.' });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    let outcome = null;
    const result = await mutateAppState(state => {
      const record = loadTargetRecord(state, 'attendance', id);
      if (!record) { outcome = { error: 404, message: 'Attendance record not found.' }; return { changed: false }; }
      if (record.approvalStatus !== 'pending') { outcome = { error: 409, message: 'This record is no longer pending approval.', conflict: true }; return { changed: false }; }
      const caller = resolveCaller(state, req.session);
      if (!isAdminCaller(req.session, caller)) { outcome = { error: 403, message: 'Force-approve requires administrator access.' }; return { changed: false }; }
      if (caller && record.eid === caller.id) { outcome = { error: 403, message: 'You cannot force-approve your own record.', selfApproval: true }; return { changed: false }; }
      const actorName = caller ? caller.name : (req.session.sub || 'Administrator');
      applyForceApprove(record, actorName, caller && caller.eid, 'approvalStatus');
      outcome = { record };
      return { changed: true };
    }, req.session.sub, tenantKey);
    if (outcome && outcome.error) {
      if (outcome.selfApproval) await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'self_approval_blocked', target: String(id), meta: { recordType: 'attendance', forced: true } });
      if (outcome.conflict) await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'invalid_state_transition_blocked', target: String(id), meta: { recordType: 'attendance', forced: true } });
      return res.status(outcome.error).json({ error: outcome.message });
    }
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'attendance_force_approved', target: String(id), meta: {} });
    res.json({ ok: true, record: outcome.record, version: result.version });
  } catch (error) {
    res.status(500).json({ error: 'Unable to force-approve.', detail: error.message });
  }
});
// Leave filing -- the canonical, backend-authoritative replacement for submitLeave() (public/
// index.html) pushing a client-computed record straight into local state. days/paidDays/
// unpaidDays/halfDayLabel are never trusted from the client; calculateLeaveRequest (server/
// leave-service.js) derives them the same way submitLeave() always did, from the employee's own
// current leave balance and working-day calendar. acknowledgeShortfall round-trips the client's
// confirm() dialog for an over-balance request (see calculateLeaveRequest's own comment) -- a
// first call without it may come back 409 with needsAcknowledgment + the computed numbers instead
// of filing, so the frontend can show that confirmation before resubmitting.
app.post('/api/leaves', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  const acknowledgeShortfall = req.body.acknowledgeShortfall === true;
  try {
    let outcome = null;
    const result = await mutateAppState(state => {
      const caller = resolveCaller(state, req.session);
      if (!caller) { outcome = { error: 403, message: 'Your account could not be matched to an employee record.' }; return { changed: false }; }
      if (!isAdminCaller(req.session, caller) && !hasPermission(state, req.session, 'leave_apply')) {
        outcome = { error: 403, message: 'You do not have permission to file leave requests.' }; return { changed: false };
      }
      const calc = calculateLeaveRequest(state, caller, req.body, acknowledgeShortfall);
      if (!calc.ok) {
        outcome = { error: calc.needsAcknowledgment ? 409 : 400, message: calc.error, needsAcknowledgment: calc.needsAcknowledgment, computed: calc.computed, invalidCalendarDate: calc.invalidCalendarDate };
        return { changed: false };
      }
      state.leaves = Array.isArray(state.leaves) ? state.leaves : [];
      const nextId = state.leaves.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
      const record = { id: nextId, eid: caller.id, ...calc.record, status: 'pending', filed: new Date().toISOString().slice(0, 10), approvalLayer: 1 };
      state.leaves.push(record);
      outcome = { record };
      return { changed: true };
    }, req.session.sub, tenantKey);
    if (outcome && outcome.error) {
      if (outcome.invalidCalendarDate) {
        await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'invalid_calendar_date_rejected', target: null, meta: {} });
      }
      return res.status(outcome.error).json({ error: outcome.message, needsAcknowledgment: outcome.needsAcknowledgment, computed: outcome.computed });
    }
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_filed', target: String(outcome.record.id), meta: { type: outcome.record.type, days: outcome.record.days, dayType: outcome.record.dayType } });
    // The canonical date/fraction footprint is frozen the moment a request is filed (server/
    // leave-service.js's buildLeaveDayAllocation) so a later schedule change can never silently
    // add or drop a date at approval time -- day-counts/dates only, no PII, matching every other
    // audit event's own posture.
    await auditLog(pool, {
      tenantKey, actor: req.session.sub, action: 'leave_allocation_snapshot_created', target: String(outcome.record.id),
      meta: { dates: (outcome.record.leaveAllocation || []).map(a => a.date), dayType: outcome.record.dayType }
    });
    res.json({ ok: true, record: outcome.record, version: result.version });
  } catch (error) {
    res.status(500).json({ error: 'Unable to file leave request.', detail: error.message });
  }
});
// Leave approval decision -- backend-authoritative for BOTH the decision itself and, when it
// finalizes as approved, the complete business side-effect transaction (leave balance deduction,
// approved-leave attendance generation, late-approval payroll crediting) that used to run
// separately in the browser after the fact (actLeave(), public/index.html). finalizeLeaveApproval
// (server/leave-service.js) runs INSIDE this same mutateAppState mutator -- if it throws for any
// reason, the whole transaction (decision included) rolls back rather than leaving the leave
// marked approved with incomplete downstream state. Only ever reached for a currently-pending
// record (canActOnRecord's statusField check above), so this can only ever run once per leave.
app.post('/api/leaves/:id/decision', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  const decision = req.body.decision === 'rejected' ? 'rejected' : req.body.decision === 'approved' ? 'approved' : null;
  if (!Number.isInteger(id) || !decision) return res.status(400).json({ error: 'A valid record id and decision ("approved" or "rejected") are required.' });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    let outcome = null;
    const result = await mutateAppState(state => {
      const record = loadTargetRecord(state, 'leaves', id);
      if (!record) { outcome = { error: 404, message: 'Leave request not found.' }; return { changed: false }; }
      const gate = canActOnRecord(state, req.session, record, 'leave_approve', hasPermission, 'status');
      if (!gate.allowed) {
        if (gate.conflict) { outcome = { error: 409, message: gate.reason, conflict: true }; return { changed: false }; }
        outcome = { error: 403, message: gate.reason, selfApproval: /own request/.test(gate.reason) }; return { changed: false };
      }
      const caller = resolveCaller(state, req.session);
      const actorName = caller ? caller.name : (req.session.sub || 'Administrator');
      const decisionResult = applyChainDecision(record, decision, actorName, caller && caller.eid, gate.chain, gate.currentLayer, 'status');
      let sideEffects = null;
      let canSeePayrollAdjustments = false;
      let canSeeAttendanceDetail = false;
      if (decisionResult.final && decision === 'approved') {
        sideEffects = finalizeLeaveApproval(state, record, actorName);
        // Payroll-adjustment DETAIL (amount, daily-rate-derived figures) is only for a caller who
        // already has payroll visibility -- an employee-role manager approving with only
        // leave_approve must never receive that just because their approval happened to trigger a
        // late-payroll credit. Computed here (inside the transaction, where `state`/`caller` are
        // authoritative) rather than trusting anything about the caller from outside it.
        canSeePayrollAdjustments = isAdminCaller(req.session, caller) || hasPermission(state, req.session, 'payroll');
        // Full attendance record DETAIL (Time In/Out, raw punches, OT/ND/undertime, edit history)
        // is likewise only for a caller who already has a legitimate reason to see it -- admin,
        // att_edit, or payroll. A leave_approve-only manager gets just the safe patch projection
        // built below (projectAttendancePatchForSession), never the raw timekeeping detail, just
        // because their approval happened to touch Attendance.
        canSeeAttendanceDetail = isAdminCaller(req.session, caller) || hasPermission(state, req.session, 'att_edit') || hasPermission(state, req.session, 'payroll');
        // TEST-ONLY fault injection, proving finalizeLeaveApproval's in-memory mutations (balance/
        // attendance/payroll, already applied to `state` above) roll back together with the
        // decision itself if anything downstream in this same transaction fails -- mutateAppState's
        // own BEGIN/COMMIT/ROLLBACK is what actually does the rolling back; this only exercises it
        // with a genuine thrown error instead of asserting the property by reading the code. Gated
        // behind an env var no real deployment sets and this test harness sets explicitly, so it's
        // inert everywhere else -- never reachable outside a test run that opts in on purpose.
        if (process.env.TEST_ALLOW_LEAVE_FINALIZATION_FAULT_INJECTION === 'true' && req.body.__testForceFinalizationFailure === true) {
          throw new Error('Injected test failure after finalization side effects (rollback proof) -- not a real error.');
        }
      }
      outcome = { record, decisionResult, sideEffects, canSeePayrollAdjustments, canSeeAttendanceDetail };
      return { changed: true };
    }, req.session.sub, tenantKey);
    if (outcome && outcome.error) {
      if (outcome.selfApproval) await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'self_approval_blocked', target: String(id), meta: { recordType: 'leave' } });
      if (outcome.conflict) await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'invalid_state_transition_blocked', target: String(id), meta: { recordType: 'leave' } });
      return res.status(outcome.error).json({ error: outcome.message });
    }
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: decision === 'approved' ? 'leave_approved' : 'leave_rejected', target: String(id), meta: { final: outcome.decisionResult.final } });
    // The response used to hand back the ENTIRE finalized employee record (everything but the
    // password hash) plus the full new payroll adjustments, so an approver's UI could refresh what
    // just changed -- but an employee-role manager holding only leave_approve has no business
    // receiving that subordinate's salary, government IDs, bank details, or payroll-adjustment
    // amount just because they approved a leave request. employeePatch is the one thing
    // finalization actually changes on the employee record that the approving UI needs back
    // (projectLeaveDecisionEmployeeForSession, server/leave-service.js -- id + leaveBalances only,
    // for every caller, admin included); payroll adjustment DETAIL is included only for a caller
    // who already has payroll visibility, everyone else gets just a safe created/count indicator.
    let employeePatch, attendanceRecords, attendancePatches, attendanceUpdated = false, attendanceDates,
      payrollAdjustmentCreated = false, payrollAdjustmentCount = 0, payrollAdjustments,
      retroAdjustmentCreated = false, retroReconciliations;
    if (outcome.sideEffects) {
      const fx = outcome.sideEffects;
      await auditLog(pool, {
        tenantKey, actor: req.session.sub, action: 'leave_finalization_side_effects', target: String(id),
        meta: {
          balanceDeducted: fx.balanceDeducted, attendanceRecordsTouched: fx.attendanceRecords.length,
          payrollAdjustmentsCreated: fx.payrollAdjustments.length, duplicateAdjustmentsSkipped: fx.duplicateAdjustmentsSkipped,
          balanceRecalculated: fx.balanceRecalculated
        }
      });
      if (fx.balanceRecalculated && outcome.record.balanceRecalculation) {
        await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_balance_recalculated_at_approval', target: String(id), meta: outcome.record.balanceRecalculation });
      }
      if (fx.duplicateAdjustmentsSkipped > 0) {
        await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'duplicate_leave_payroll_adjustment_skipped', target: String(id), meta: { count: fx.duplicateAdjustmentsSkipped, legacyAdjustmentMismatches: fx.legacyAdjustmentMismatches } });
      }
      if (fx.allocationDerivedAtApproval) {
        await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_allocation_derived_at_approval', target: String(id), meta: { dates: (outcome.record.leaveAllocation || []).map(a => a.date) } });
      }
      if (fx.scheduleChangedSinceFiling) {
        await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'schedule_changed_after_leave_filing', target: String(id), meta: {} });
      }
      const halfDayTouched = fx.attendanceRecords.filter(r => r.leaveDayType);
      if (halfDayTouched.length) {
        await auditLog(pool, {
          tenantKey, actor: req.session.sub, action: 'half_day_leave_finalized', target: String(id),
          meta: halfDayTouched.map(r => ({ date: r.date, dayType: r.leaveDayType, otherHalfWorked: !!r.otherHalfWorked }))
        });
      }
      if (fx.payrollAdjustments.length) {
        await auditLog(pool, {
          tenantKey, actor: req.session.sub, action: 'leave_fraction_paid', target: String(id),
          meta: fx.payrollAdjustments.map(a => ({ date: a.sourceDate, fraction: a.sourceFraction, amount: a.amount }))
        });
      }
      // Locked-payroll retro reconciliation audit trail (issue 23) -- one event per outcome,
      // never carrying salary/government-ID/bank/password-hash detail, only the identifiers and
      // figures already scoped as safe for an audit record (leave/run/period ids, method, variance).
      for (const recon of (fx.retroReconciliations || [])) {
        if (recon.duplicate) {
          await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_duplicate_skipped', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId } });
          continue;
        }
        await auditLog(pool, {
          tenantKey, actor: req.session.sub, action: 'leave_retro_reconciliation_started', target: String(id),
          meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId, method: recon.method }
        });
        if (recon.status === 'adjustment_created') {
          await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_adjustment_created', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId, method: recon.method, variance: recon.varianceNet } });
          if (recon.supersedesReconciliationId) {
            await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_replacement_created', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId, supersedesReconciliationId: recon.supersedesReconciliationId } });
          }
        } else if (recon.status === 'no_adjustment_required') {
          await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_no_adjustment_required', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId, method: recon.method } });
        } else if (recon.status === 'manual_review_required') {
          await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_manual_review_required', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId, reason: recon.reason } });
          if (/manual override/i.test(recon.reason || '')) {
            await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_manual_override_detected', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId } });
          } else if (/snapshot/i.test(recon.reason || '')) {
            await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_missing_snapshot', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId } });
          }
        }
        await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'leave_retro_reconciliation_completed', target: String(id), meta: { payrollRunId: recon.sourcePayrollRunId, periodId: recon.sourcePeriodId, empId: recon.empId, status: recon.status } });
      }
      employeePatch = projectLeaveDecisionEmployeeForSession(fx.employee);
      attendanceUpdated = fx.attendanceRecords.length > 0;
      attendanceDates = fx.attendanceRecords.map(r => r.date);
      attendancePatches = fx.attendanceRecords.map(projectAttendancePatchForSession);
      if (outcome.canSeeAttendanceDetail) {
        attendanceRecords = fx.attendanceRecords;
      } else if (attendanceUpdated) {
        await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'attendance_response_scoped', target: String(id), meta: { recordCount: fx.attendanceRecords.length } });
      }
      payrollAdjustmentCount = fx.payrollAdjustments.length;
      payrollAdjustmentCreated = payrollAdjustmentCount > 0;
      if (payrollAdjustmentCreated && outcome.canSeePayrollAdjustments) {
        payrollAdjustments = fx.payrollAdjustments;
      }
      // Issue 24/39: retroAdjustmentCreated/retroReconciliationStatus are safe for EVERY caller
      // (leave-workflow status, not a payroll figure) -- original/corrected net, variance, rate,
      // and any other payroll detail are only ever included for a caller who already has payroll
      // visibility, exactly like payrollAdjustments above.
      const retros = fx.retroReconciliations || [];
      if (retros.length) {
        retroAdjustmentCreated = retros.some(r => r.status === 'adjustment_created');
        retroReconciliations = outcome.canSeePayrollAdjustments
          ? retros.map(r => ({ sourceLeaveId: r.sourceLeaveId, sourcePayrollRunId: r.sourcePayrollRunId, sourcePeriodId: r.sourcePeriodId, retroReconciliationStatus: r.status, method: r.method, originalNet: r.originalNet, correctedNet: r.correctedNet, varianceNet: r.varianceNet, reason: r.reason }))
          : retros.map(projectReconciliationForSession);
      }
    }
    res.json({
      ok: true, record: outcome.record, message: outcome.decisionResult.message, final: outcome.decisionResult.final, version: result.version,
      employeePatch, attendanceRecords, attendanceUpdated, attendanceDates, attendancePatches,
      payrollAdjustmentCreated, payrollAdjustmentCount, payrollAdjustments,
      retroAdjustmentCreated, retroReconciliations
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to record the decision.', detail: error.message });
  }
});

// ── Leave retro reconciliation reversal (issue 16/17) -- dedicated, payroll-authorized-only
// endpoint. Never edits the original applied adjustment (immutable once applied, issue 19);
// books a new, equal-and-opposite reversal adjustment via the module's own
// reverseReconciliation() and marks the reconciliation record 'reversed'. A fresh call to the
// normal leave-decision flow for the same leave afterward is then free to create a genuine
// replacement reconciliation (findExistingReconciliation ignores reversed records), which
// automatically links back via supersedesReconciliationId -- full lineage, no separate
// "replacement" endpoint needed.
app.post('/api/leave-retro-reconciliations/:id/reverse', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid reconciliation id is required.' });
  if (!reason) return res.status(400).json({ error: 'A reversal reason is required for the audit trail.' });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    let outcome = null;
    const result = await mutateAppState(state => {
      const caller = resolveCaller(state, req.session);
      if (!(isAdminCaller(req.session, caller) || hasPermission(state, req.session, 'payroll'))) {
        outcome = { error: 403, message: 'You do not have payroll permission to reverse a retro adjustment.' };
        return { changed: false };
      }
      const reversal = LeavePayrollReconciliation.reverseReconciliation(state, id, caller ? caller.name : (req.session.sub || 'Administrator'), reason);
      if (!reversal.ok) { outcome = { error: 409, message: reversal.reason }; return { changed: false }; }
      outcome = { reversal };
      return { changed: true };
    }, req.session.sub, tenantKey);
    if (outcome && outcome.error) return res.status(outcome.error).json({ error: outcome.message });
    await auditLog(pool, {
      tenantKey, actor: req.session.sub, action: 'leave_retro_reversal_created', target: String(id),
      meta: { reversalAdjustmentId: outcome.reversal.reversalAdjustment.id, reversedVariance: outcome.reversal.reversalAdjustment.amount }
    });
    res.json({
      ok: true, version: result.version,
      reconciliation: { sourceLeaveId: outcome.reversal.record.sourceLeaveId, retroReconciliationStatus: outcome.reversal.record.status },
      // The caller only ever reaches this line already holding payroll permission (gated above) --
      // safe to hand back the reversal's own figures, exactly like the full leave-decision response
      // already does for a payroll-authorized caller.
      reversalAdjustment: { id: outcome.reversal.reversalAdjustment.id, amount: outcome.reversal.reversalAdjustment.amount }
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to reverse the retro adjustment.', detail: error.message });
  }
});

/* ── Saved Reports (Report Builder) ──
   Previously a plain in-memory browser array (public/index.html's old `savedReports`) that never
   reached the backend at all -- "Save Report" showed a success alert but the list reset to empty
   on every reload/logout/new device. These endpoints make a saved report a real, tenant-scoped
   record: who created it and when is recorded, and it's shared with every other user who holds
   the same 'reports' permission that already gates the Report Builder itself -- not just the
   creator, and never anyone without that permission (see buildScopedStateForEmployee in
   state-serialization.js, which omits this array entirely from a non-'reports' session's state,
   the same way it already does for `candidates`/`platformClients`/etc.). Deliberately dedicated
   endpoints rather than folding this into PUT /api/state's employee overlay: a non-admin manager
   who holds 'reports' but not full admin write access needs a way to persist a report that
   PUT /api/state's overlay (self-owned-records-only) was never built to allow -- the same reasoning
   that put attendance/leave decisions on their own endpoints in the previous pass. Only the
   'employees'/'payroll'/'timekeeping' report types the Report Builder UI actually offers are
   accepted; column/filter contents are opaque UI config (which columns to show, not the
   underlying employee data itself -- the data those columns pull from is still scoped by each
   session's own normal permissions when the report is actually rendered), so they're only
   size-bounded here, not enumerated against the client's column list. */
const REPORT_TYPES = new Set(['employees', 'payroll', 'timekeeping']);
function validateReportPayload(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'A report name is required.' };
  if (name.length > 120) return { error: 'Report name is too long (120 characters max).' };
  const type = String(body.type || '');
  if (!REPORT_TYPES.has(type)) return { error: 'Invalid report type.' };
  const columns = Array.isArray(body.columns) ? body.columns.filter(c => typeof c === 'string') : [];
  if (columns.length > 200) return { error: 'Too many columns.' };
  const filters = (body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)) ? body.filters : {};
  if (JSON.stringify(filters).length > 5000) return { error: 'Filter data is too large.' };
  return { name, type, columns, filters };
}
app.post('/api/reports', requireAuth, authz.requirePermission('reports'), async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const parsed = validateReportPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    let created = null;
    const result = await mutateAppState(state => {
      state.savedReports = Array.isArray(state.savedReports) ? state.savedReports : [];
      const caller = resolveCaller(state, req.session);
      const nextId = state.savedReports.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
      const now = new Date().toISOString();
      created = {
        id: nextId, name: parsed.name, type: parsed.type, columns: parsed.columns, filters: parsed.filters,
        createdBy: caller ? caller.name : (req.session.sub || 'Administrator'),
        createdByEid: caller ? caller.eid : null,
        createdByUserId: caller ? caller.id : null,
        createdAt: now, updatedBy: null, updatedByEid: null, updatedByUserId: null, updatedAt: null
      };
      state.savedReports.push(created);
      return { changed: true };
    }, req.session.sub, tenantKey);
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'report_saved', target: String(created.id), meta: { name: created.name, type: created.type } });
    res.json({ ok: true, report: created, version: result.version });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save report.', detail: error.message });
  }
});
app.put('/api/reports/:id', requireAuth, authz.requirePermission('reports'), async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid report id is required.' });
  const parsed = validateReportPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    let outcome = null;
    const result = await mutateAppState(state => {
      const report = loadTargetRecord(state, 'savedReports', id);
      if (!report) { outcome = { error: 404, message: 'Saved report not found.' }; return { changed: false }; }
      const caller = resolveCaller(state, req.session);
      const isOwner = !!(caller && report.createdByUserId === caller.id);
      if (!isOwner && !isAdminCaller(req.session, caller)) { outcome = { error: 403, message: 'Only the report\'s creator or an administrator can edit it.' }; return { changed: false }; }
      report.name = parsed.name; report.type = parsed.type; report.columns = parsed.columns; report.filters = parsed.filters;
      report.updatedBy = caller ? caller.name : (req.session.sub || 'Administrator');
      report.updatedByEid = caller ? caller.eid : null;
      report.updatedByUserId = caller ? caller.id : null;
      report.updatedAt = new Date().toISOString();
      outcome = { report };
      return { changed: true };
    }, req.session.sub, tenantKey);
    if (outcome && outcome.error) return res.status(outcome.error).json({ error: outcome.message });
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'report_updated', target: String(id), meta: { name: outcome.report.name } });
    res.json({ ok: true, report: outcome.report, version: result.version });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update report.', detail: error.message });
  }
});
app.delete('/api/reports/:id', requireAuth, authz.requirePermission('reports'), async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid report id is required.' });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    let outcome = null;
    const result = await mutateAppState(state => {
      state.savedReports = Array.isArray(state.savedReports) ? state.savedReports : [];
      const report = state.savedReports.find(r => r.id === id);
      if (!report) { outcome = { error: 404, message: 'Saved report not found.' }; return { changed: false }; }
      const caller = resolveCaller(state, req.session);
      const isOwner = !!(caller && report.createdByUserId === caller.id);
      if (!isOwner && !isAdminCaller(req.session, caller)) { outcome = { error: 403, message: 'Only the report\'s creator or an administrator can delete it.' }; return { changed: false }; }
      state.savedReports = state.savedReports.filter(r => r.id !== id);
      outcome = { name: report.name };
      return { changed: true };
    }, req.session.sub, tenantKey);
    if (outcome && outcome.error) return res.status(outcome.error).json({ error: outcome.message });
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'report_deleted', target: String(id), meta: { name: outcome.name } });
    res.json({ ok: true, version: result.version });
  } catch (error) {
    res.status(500).json({ error: 'Unable to delete report.', detail: error.message });
  }
});

/* ── AI-powered chat assistant (opt-in, Company Settings toggle) ──
   The client-side chat widget's own deterministic assistantAnswer() (enterprise.js) is the
   default and needs no server support at all -- this endpoint only backs the optional
   "AI-Powered Assistant" toggle, so an admin can trade a per-request API cost for more
   flexible natural-language understanding. The API key lives only in this process's
   environment, never sent to or readable by the browser.

   Security model: the LLM never gets live database or tool access. Every request instead
   hands it one pre-built, permission-scoped JSON snapshot -- an admin's snapshot mirrors
   exactly what canAccess()-gated admin views already show; a non-admin's snapshot is built
   by mirroring canAccess()'s own self_view_* checks server-side (serverCanAccess below), field
   by field, so a permission this account doesn't have simply never reaches the prompt at all,
   the same as the deterministic assistant already enforces. The one rule no permission key
   could express -- a non-admin can never see anyone else's record here -- is structural: their
   snapshot only ever contains their own data to begin with. */
function fmtNameServer(u) {
  if (!u) return '';
  const last = (u.lastName || '').trim().toUpperCase();
  const first = (u.firstName || '').trim().toUpperCase();
  if (!last && !first) return u.name || '';
  const mi = (u.middleName || '').trim().charAt(0).toUpperCase();
  const suffix = (u.suffix || '').trim().toUpperCase();
  let out = (last ? last + ', ' : '') + first;
  if (mi) out += ' ' + mi + '.';
  if (suffix) out += ', ' + suffix;
  return out;
}
function serverCanAccess(state, me, key) {
  if (!me) return false;
  if (me.role === 'admin' || me.accessLevelId === 1) return true;
  const al = (state.accessLevels || []).find(a => a.id === me.accessLevelId);
  return !!(al && al.perms && al.perms[key] === true);
}
// Static description of how AURA and Philippine payroll/timekeeping rules work in general --
// never company- or employee-specific, so it's identical for every session regardless of role
// and safe to include unconditionally. Keeps the assistant grounded on real AURA behavior
// instead of guessing at how a generic HR system might work.
const ASSISTANT_SYSTEM_KNOWLEDGE = [
  'AURA modules: Employee 201 records (personal/employment/compensation/gov\'t IDs/bank details), Org Structure, Time & Attendance (shift setup, holiday calendar, Web Bundy clock-in with selfie capture and email-OTP guest access for kiosks), Attendance Forms (time correction, overtime, rest-day OT, WFH, OB/official business, schedule adjustment), Leave (configurable leave types with a multi-layer approval chain resolved from the org reporting hierarchy, not one fixed approver), Payroll (draft/preview, a 5-stage approval workflow -- Maker, Timekeeping Reviewer, HR Checker, Finance Checker, Authorized Approver -- ending in an immutable Locked run, Pay Calendar & cutoffs, Payroll Groups), Resolution Center (a shared HR Operations / Payroll Team queue for attendance, payroll, payslip, and general cases -- any authorized admin/HR user can resolve one, not a single named approver), My Payslips (employee self-service, visible once a payroll run reaches the relevant stage), Loans, Recruitment (job requisitions, candidates, pipeline stages), Performance (goals, check-ins), Compliance (health scoring, downloadable statutory working papers: SSS R3, PhilHealth RF-1, Pag-IBIG MCRF, BIR 1601-C, BIR 2316, BIR 1604-C), Bulk Upload (employees, adjustments, income/deduction types), and Company Settings (branding, payroll defaults, statutory rate tables, email notification templates).',
  'How AURA computes pay: Daily Rate = Monthly Salary ÷ the company\'s configured Daily Rate Divisor (standard 22 working days/month). Overtime premiums stack on top of the hourly rate per DOLE rules -- ordinary OT is +25%, work on a rest day is +30% (and stacks further if that rest-day work is also OT, or falls on a holiday), a special (non-working) holiday is +30%, a regular holiday is a 100% premium (double pay), and night differential (10pm-6am) adds +10% -- exact combinations depend on which of these apply together on a given day.',
  'Attendance rules: a configurable "Late Half Day" minute threshold and a "Minimum Hours for a Full Day" threshold decide automatic attendance status -- falling short of the minimum can auto-mark the day LWOP (Leave Without Pay/Absent). A filing deadline can lock employee self-service filing a set number of days after each pay period\'s attendance window closes (admins/HR are never blocked by it).',
  'Statutory deductions AURA computes: SSS (bracket-based Monthly Salary Credit, with an optional Mandatory Provident Fund/MPF portion once salary exceeds a configured threshold), PhilHealth (a flat percentage of salary within a configured floor and ceiling), Pag-IBIG/HDMF (a percentage of salary capped at a configured maximum fund salary, with a lower employee rate below a low-income threshold -- the employer share can differ from the employee share depending on the salary tier), and BIR withholding tax (graduated brackets, with an optional year-end or final-pay annualization reconciliation). This company\'s actual currently-configured rates, thresholds, and policy toggles are in DATA.policies when present -- always prefer those exact numbers over this general description.'
].join('\n\n');
// Company-wide POLICY/rate configuration -- never a specific employee's confidential data, so
// it's safe to hand to every session regardless of role, unlike the per-employee branches below.
// Grounds the assistant's payroll/timekeeping explanations in what this tenant actually has
// configured (rather than the model guessing at generic textbook numbers), while still keeping
// it small and curated rather than dumping the entire GOVT_RATES/ATTENDANCE_POLICY objects.
function buildPolicyContext(state) {
  const ap = state.attendancePolicy || {};
  const gr = state.governmentRates || {};
  const co = state.company || {};
  return {
    dailyRateDivisor: co.dailyDivisor ?? null,
    hoursPerDay: co.hoursPerDay ?? null,
    salaryMultiplier: co.salaryMultiplier ?? null,
    attendancePolicy: {
      lateHalfDayMinutes: ap.lateHalfDayMinutes ?? null,
      minHoursFullDay: ap.minHoursFullDay ?? null,
      deductLateFromOT: !!ap.deductLateFromOT,
      filingDeadlineEnabled: !!ap.filingDeadlineEnabled,
      filingDeadlineDaysAfterPeriodEnd: ap.filingDeadlineDaysAfterPeriodEnd ?? null
    },
    absenceFallbackPolicy: co.absenceFallbackPolicy || null,
    taxPolicy: co.taxPolicy || null,
    statutoryRates: {
      sss: gr.sss ? { ratePercent: gr.sss.ratePercent, mpfEnabled: !!gr.sss.mpfEnabled, mpfThreshold: gr.sss.mpfThreshold, mpfRate: gr.sss.mpfRate } : null,
      philhealth: gr.philhealth ? { ratePercent: gr.philhealth.ratePercent, minSalary: gr.philhealth.minSalary, minContrib: gr.philhealth.minContrib, maxSalary: gr.philhealth.maxSalary, maxContrib: gr.philhealth.maxContrib } : null,
      pagibig: gr.pagibig ? { ratePercent: gr.pagibig.ratePercent, lowRatePercent: gr.pagibig.lowRatePercent, lowRateThreshold: gr.pagibig.lowRateThreshold, maxFundSalary: gr.pagibig.maxFundSalary, maxContrib: gr.pagibig.maxContrib } : null
    }
  };
}
// Deeper, admin-only ANALYSIS data -- pre-aggregated summaries, never raw per-record dumps
// (state.attendance grows unbounded, roughly one row per employee per workday forever), so the
// assistant can reason about trends/patterns/risks instead of only reciting point-in-time facts,
// while keeping the payload small and bounded regardless of company size or data history.
// complianceHealth's scoring formula is mirrored from enterprise.js by hand -- no shared module
// between the browser bundle and this Node backend.
function buildAnalyticsContext(state) {
  const users = (state.users || []).filter(u => u.role === 'employee');
  const active = users.filter(u => u.active !== false);
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const cutoff30 = daysAgo(30), cutoff90 = daysAgo(90);

  const missingGovCount = active.filter(u => !u.sss || !u.ph || !u.pi || !u.tin).length;
  const missingBankCount = active.filter(u => !u.bank || !u.bankAccount).length;
  const pendingAttCount = (state.attendance || []).filter(a => a.approvalStatus === 'pending').length;
  const pendingPayCount = (state.payrolls || []).filter(r => r.status === 'pending_approval').length;
  const complianceScore = Math.max(0, 100 - missingGovCount * 10 - missingBankCount * 5 - pendingAttCount * 3 - pendingPayCount * 8);

  const byDept = {}, byType = {};
  active.forEach(u => {
    const d = u.dept || 'Unassigned', t = u.type || 'unspecified';
    byDept[d] = (byDept[d] || 0) + 1; byType[t] = (byType[t] || 0) + 1;
  });

  const recentHires = users.filter(u => u.hired && u.hired >= cutoff90).length;
  const recentSeparations = users.filter(u => u.active === false && u.effectiveTermDate && u.effectiveTermDate >= cutoff90).length;

  const runs = [...(state.payrolls || [])].sort((a, b) => String(a.to || '').localeCompare(String(b.to || ''))).slice(-6);
  const payrollCostTrend = runs.map(r => {
    const items = r.items || [];
    const sum = key => +items.reduce((s, i) => s + (Number(i[key]) || 0), 0).toFixed(2);
    // totalDed, not total -- a real payroll item has no `total` field, so this previously
    // silently summed to 0 for every run (item[key] || 0 masked the undefined).
    return { period: `${r.from || ''} to ${r.to || ''}`, status: r.status, headcount: items.length, totalGross: sum('gross'), totalDeductions: sum('totalDed'), totalNet: sum('net') };
  });

  const recentAtt = (state.attendance || []).filter(a => a.date >= cutoff30);
  let lateCount = 0, absentCount = 0, totalOtHours = 0;
  const otByDept = {};
  recentAtt.forEach(a => {
    if (a.status === 'late') lateCount++;
    if (a.status === 'absent') absentCount++;
    const ot = Number(a.ot) || 0;
    if (ot > 0) {
      totalOtHours += ot;
      const emp = users.find(u => u.id === a.eid);
      const dept = emp ? (emp.dept || 'Unassigned') : 'Unassigned';
      otByDept[dept] = +((otByDept[dept] || 0) + ot).toFixed(2);
    }
  });

  const recentLeaves = (state.leaves || []).filter(l => l.filed && l.filed >= cutoff90);
  const leaveTypeCounts = {};
  recentLeaves.forEach(l => { leaveTypeCounts[l.type] = (leaveTypeCounts[l.type] || 0) + 1; });

  return {
    asOf: todayStr,
    note: 'attendanceLast30Days and leaveLast90Days are pre-aggregated totals over that trailing window, not individual records; payrollCostTrend covers up to the last 6 payroll runs, oldest first.',
    complianceHealth: { score: complianceScore, missingGovIdCount: missingGovCount, missingBankDetailsCount: missingBankCount, pendingAttendanceApprovals: pendingAttCount, pendingPayrollApprovals: pendingPayCount },
    headcount: { active: active.length, byDepartment: byDept, byEmploymentType: byType },
    turnoverLast90Days: { hires: recentHires, separations: recentSeparations },
    payrollCostTrend,
    attendanceLast30Days: { lateCount, absentCount, totalOtHours: +totalOtHours.toFixed(2), otHoursByDepartment: otByDept },
    leaveLast90Days: { totalRequestsFiled: recentLeaves.length, approved: recentLeaves.filter(l => l.status === 'approved').length, rejected: recentLeaves.filter(l => l.status === 'rejected').length, pending: recentLeaves.filter(l => l.status === 'pending').length, byType: leaveTypeCounts }
  };
}
function buildAssistantContext(state, session, isAdmin) {
  const users = (state.users || []).filter(u => u.role === 'employee');
  const today = new Date().toISOString().slice(0, 10);
  const policies = buildPolicyContext(state);
  if (isAdmin) {
    const enterprise = state.enterprise || {};
    return {
      today,
      companyName: state.company?.name || '',
      policies,
      analytics: buildAnalyticsContext(state),
      employees: users.map(u => ({
        name: fmtNameServer(u), department: u.dept, position: u.pos, employmentType: u.type,
        active: u.active !== false, hired: u.hired, probationEndDate: u.probEndDate || null,
        sss: u.sss, philhealth: u.ph, pagibig: u.pi, tin: u.tin, bank: u.bank, bankAccount: u.bankAccount,
        monthlySalary: u.salaryPM, dailyRate: u.rate, email: u.email,
        manager: [u.managerFirst, u.managerLast].filter(Boolean).join(' ') || null
      })),
      pendingLeaveRequests: (state.leaves || []).filter(l => l.status === 'pending').map(l => ({
        employee: fmtNameServer(users.find(u => u.id === l.eid)), type: l.type
      })),
      pendingPayrollRuns: (state.payrolls || []).filter(r => r.status === 'pending_approval').length,
      attendanceExceptionsToday: (state.attendance || []).filter(a => a.date === today && (a.status === 'late' || a.status === 'absent')).map(a => ({
        employee: fmtNameServer(users.find(u => u.id === a.eid)), status: a.status
      })),
      // Recruitment/performance/case data for the admin-only "Workforce AI Copilot" page's
      // talent-pipeline and workforce-pulse analysis -- irrelevant to the personal chat widget,
      // but this whole branch only ever runs for a confirmed admin session.
      candidates: (state.candidates || []).map(c => ({
        name: c.name, position: c.pos, department: c.dept, stage: c.stage
      })),
      jobRequisitions: (enterprise.jobRequisitions || []).map(r => ({
        title: r.title, department: r.dept, openings: r.openings, filled: r.filled, status: r.status
      })),
      performanceGoals: (enterprise.performanceGoals || []).map(g => ({
        employee: fmtNameServer(users.find(u => u.id === g.eid)), title: g.title, status: g.status, progress: g.progress, target: g.target
      })),
      openResolutionCases: (enterprise.resolutionCases || []).filter(c => c.status === 'open' || c.status === 'in_review').map(c => ({
        employee: fmtNameServer(users.find(u => u.id === c.employeeId)), category: c.category, subject: c.subject, priority: c.priority, status: c.status, dueDate: c.dueDate
      }))
    };
  }
  // Non-admin: `me` is the asking employee's own record. A client-admin-only login with no
  // matching USERS[] entry (persistence.js's synthetic {id:0,...} admin, or here simply no
  // match at all) leaves `me` undefined -- self stays {} and the note below explains why.
  const me = users.find(u => u.email === session.sub);
  const self = {};
  if (me) {
    self.name = fmtNameServer(me);
    if (serverCanAccess(state, me, 'self_view_employment')) {
      self.department = me.dept; self.position = me.pos; self.employmentType = me.type;
      self.hired = me.hired; self.probationEndDate = me.probEndDate || null;
      self.manager = [me.managerFirst, me.managerLast].filter(Boolean).join(' ') || null;
    }
    if (serverCanAccess(state, me, 'self_view_govt')) {
      self.sss = me.sss; self.philhealth = me.ph; self.pagibig = me.pi; self.tin = me.tin;
    }
    if (serverCanAccess(state, me, 'self_view_compensation')) {
      self.monthlySalary = me.salaryPM; self.dailyRate = me.rate;
    }
    if (serverCanAccess(state, me, 'self_view_personal')) {
      self.email = me.email;
    }
    if (serverCanAccess(state, me, 'leave')) {
      const leaveTypes = (state.company?.leaveTypes || []).filter(t => t.active);
      self.leaveBalances = leaveTypes.map(t => ({
        type: t.name, balance: (me.leaveBalances && me.leaveBalances[t.id] && me.leaveBalances[t.id].balance) || 0
      }));
    }
    if (serverCanAccess(state, me, 'myslips')) {
      // Last 6 runs this employee appears in (not just the latest) so the assistant can answer
      // about a specific past cutoff, not only "how much was I paid most recently". item.total
      // does not exist on a real payroll item (the actual field is item.totalDed) -- this used to
      // silently read undefined here, meaning "deductions" was always missing/zero; fixed below.
      const mine = (state.payrolls || []).map(r => ({ r, item: (r.items || []).find(i => i.eid === me.id) })).filter(x => x.item).slice(-6);
      self.payslipHistory = mine.map(({ r, item }) => ({
        period: `${r.from || ''} - ${r.to || ''}`, status: r.status,
        basicPay: item.basic ?? null, otPay: item.ot ?? null, otHours: item.otH ?? null, nightDiffPay: item.nd ?? null,
        gross: item.gross ?? null, totalDeductions: item.totalDed ?? null, net: item.net ?? null
      }));
    }
    if (serverCanAccess(state, me, 'self_view_attendance')) {
      // Own attendance records for roughly the last 90 days -- enough to cover the current and
      // prior couple of cutoffs without unbounded growth (state.attendance otherwise keeps every
      // record forever). `notes` already carries the human-readable reason a day was marked late/
      // half-day/LWOP (see applyAttendancePolicy's policyNotes, folded into notes when the record
      // is written), so the assistant can explain "why" from real data instead of guessing.
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      self.attendanceHistory = (state.attendance || [])
        .filter(a => a.eid === me.id && a.date >= cutoffStr)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map(a => ({
          date: a.date, status: a.status, timeIn: a.tin || null, timeOut: a.tout || null,
          lateMinutes: a.lateMinutes ?? null, undertimeMinutes: a.undertimeMinutes ?? null,
          otHours: a.ot ?? null, nightDiffHours: a.nd ?? null,
          approvalStatus: a.approvalStatus || null, notes: a.notes || null
        }));
    }
  }
  return {
    today, companyName: state.company?.name || '', policies, me: me ? self : null,
    note: me ? undefined : "This login isn't tied to a specific employee record, so there's no personal data to show for it."
  };
}
app.post('/api/assistant/ask', requireAuth, async (req, res) => {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'The AI-powered assistant is not configured on this server yet.' });
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'A question is required.' });
  if (question.length > 2000) return res.status(400).json({ error: 'That question is too long.' });
  const lang = req.body.lang === 'tl' ? 'tl' : 'en';
  try {
    const tenantKey = req.session.tenantKey || TENANT_KEY;
    const record = await readState(tenantKey);
    const state = record?.state || {};
    const isAdmin = req.session.role === 'admin' || req.session.role === 'platform';
    const context = buildAssistantContext(state, req.session, isAdmin);
    const systemPrompt = [
      'You are AURA Assistant, an expert HR and payroll assistant embedded in AURA, a Philippine HR/payroll system. You know AURA\'s features end to end and how Philippine HR/payroll rules generally work -- see SYSTEM KNOWLEDGE below. You may explain that freely to anyone, at any access level, since it describes how the software and Philippine payroll rules work in general, not this company\'s or any employee\'s private data.',
      'For anything specific to this company or a person -- names, numbers, statuses, balances, configured rates -- answer ONLY using the DATA JSON below. Never invent, estimate, or guess a specific fact that is not present in it. Prefer DATA over SYSTEM KNOWLEDGE whenever both cover the same thing (e.g. this company\'s actual configured statutory rates over general PH rates).',
      'Some data is deliberately left out of DATA based on this user\'s own access level or because it belongs to someone else -- if asked something specific that is not present, say plainly that you do not have that information, and never imply it exists or could be found another way.',
      lang === 'tl' ? 'Respond in Tagalog/Filipino.' : 'Respond in English.',
      isAdmin
        ? 'You are talking to an admin/HR user. As well as answering direct questions, you may actively ANALYZE DATA.analytics and DATA.employees/payroll/leave/case data -- spot trends, compare periods, flag outliers or risks (e.g. a department with unusually high OT or lateness, a compliance score driven mainly by one factor, a payroll run that jumped versus the prior one), and give a short recommendation when it is clearly warranted. Ground every specific number in DATA -- never invent a trend or figure that is not actually derivable from it. A real analysis can run a short paragraph or a few bullet points when that reads more clearly than prose, but stay a focused briefing, not a long report.'
        : 'Be concise -- a few sentences at most, like a helpful coworker, not a report. When DATA.me.attendanceHistory and DATA.me.payslipHistory are both present, you can explain a specific cutoff -- match a payslipHistory entry\'s period (its from/to dates) against attendanceHistory records falling inside that same date range to answer things like "why was I marked late/absent that cutoff" (attendanceHistory.notes usually states the exact reason, e.g. a late-minutes threshold) and "was my overtime paid, and how much" (payslipHistory.otPay is the actual peso amount paid for that cutoff, otHours is the hours). If the employee names a cutoff/date not covered by what\'s in DATA, say you only have the periods listed there.',
      '',
      'SYSTEM KNOWLEDGE:',
      ASSISTANT_SYSTEM_KNOWLEDGE,
      '',
      'DATA:',
      JSON.stringify(context)
    ].join('\n');
    const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_ASSISTANT_MODEL || 'openai/gpt-oss-120b',
        max_tokens: isAdmin ? 900 : 500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ]
      })
    });
    const data = await apiRes.json().catch(() => ({}));
    if (!apiRes.ok) {
      console.error('[assistant/ask] Groq API error', apiRes.status, JSON.stringify(data));
      return res.status(502).json({
        error: data.error?.message || 'The AI assistant request failed.',
        upstreamStatus: apiRes.status,
        upstreamType: data.error?.type || null
      });
    }
    const answer = data.choices?.[0]?.message?.content || '';
    res.json({ answer });
  } catch (error) {
    console.error('[assistant/ask] request failed', error);
    res.status(500).json({ error: 'Unable to reach the AI assistant.', detail: error.message });
  }
});

/* ── Filing/approval email notifications ──
   The client already knows exactly who to notify (it resolves the approval chain itself, the
   same logic Team View and the approvals list already run) -- this endpoint just sends the
   email, so it has to independently confirm the named recipient is actually a real account in
   the caller's own tenant before sending anything. Without that check, any authenticated user
   could name an arbitrary external address here and turn this into an open mail relay. */
async function emailBelongsToTenant(tenantKey, email) {
  const record = await readState(tenantKey);
  const users = record?.state?.users || [];
  if (users.some(u => String(u.email || '').toLowerCase() === email.toLowerCase())) return true;
  const clientRow = await pool.query('SELECT 1 FROM platform_clients WHERE tenant_key = $1 AND admin_email = $2', [tenantKey, email]);
  return clientRow.rowCount > 0;
}
function escapeEmailHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Mirrors the frontend's own isAdminUser()/canAccess() logic against the CALLER's own already-
// persisted account (never the target of the action), so it doesn't hit the same debounced-
// autosave race a check against a just-created record would. Used only where a notification
// type's recipient can't be verified via emailBelongsToTenant instead (see employee-welcome).
async function callerHasPerm(tenantKey, session, permKey) {
  if (session.role === 'platform') return true;
  const record = await readState(tenantKey);
  const state = record?.state;
  if (!state) return false;
  const caller = (state.users || []).find(u => String(u.email || '').toLowerCase() === String(session.sub || '').toLowerCase());
  if (!caller) return session.role === 'admin'; // synthetic company-admin login (platform_clients.admin_email) has no USERS[] row
  if (caller.role === 'admin' || caller.accessLevelId === 1) return true;
  const level = (state.accessLevels || []).find(a => a.id === caller.accessLevelId);
  return !!(level && level.perms && level.perms[permKey] === true);
}
app.post('/api/notify', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Notifications require the database to be configured.' });
  const type = String(req.body.type || '');
  const payload = req.body.payload || {};
  const tenantKey = req.session.tenantKey;
  try {
    if (type === 'leave-filed') {
      const approverEmail = String(payload.approverEmail || '').trim();
      if (!approverEmail || !(await emailBelongsToTenant(tenantKey, approverEmail))) return res.status(400).json({ error: 'Invalid recipient.' });
      const { subject, html } = await composeEmail(tenantKey, 'leave-filed', {
        approverName: payload.approverName || 'there', employeeName: payload.employeeName || 'An employee',
        leaveType: payload.leaveType || 'leave', from: payload.from || '', to: payload.to || '', days: payload.days ?? ''
      });
      await sendAppEmail(approverEmail, subject, html);
    } else if (type === 'leave-decided') {
      const employeeEmail = String(payload.employeeEmail || '').trim();
      if (!employeeEmail || !(await emailBelongsToTenant(tenantKey, employeeEmail))) return res.status(400).json({ error: 'Invalid recipient.' });
      const { subject, html } = await composeEmail(tenantKey, 'leave-decided', {
        employeeName: payload.employeeName || 'there', leaveType: payload.leaveType || 'leave',
        from: payload.from || '', to: payload.to || '',
        decision: payload.decision === 'approved' ? 'approved' : 'rejected', decidedBy: payload.decidedBy || 'your approver'
      });
      await sendAppEmail(employeeEmail, subject, html);
    } else if (type === 'case-filed') {
      // Attendance forms (time correction, OT, RDH OT, WFH, OB, schedule adjustment, etc.) file
      // into the same shared Resolution Center queue as general HR/payroll cases -- there's no
      // single personal approver the way Leave has one, it's routed to a team ("HR Operations"/
      // "Payroll Team"), so this takes a recipient LIST (every admin, resolved client-side) and
      // validates each one independently rather than a single address.
      const recipients = Array.isArray(payload.recipientEmails) ? payload.recipientEmails.map(e => String(e || '').trim()).filter(Boolean) : [];
      const validated = [];
      for (const email of recipients) {
        if (await emailBelongsToTenant(tenantKey, email)) validated.push(email);
      }
      if (!validated.length) return res.status(400).json({ error: 'No valid recipients.' });
      const { subject, html } = await composeEmail(tenantKey, 'case-filed', {
        employeeName: payload.employeeName || 'An employee', formLabel: payload.formLabel || 'attendance request',
        date: payload.date || '(no date given)'
      });
      await sendAppEmail(validated, subject, html);
    } else if (type === 'case-decided') {
      // Fires from the same resolveCase() action that decides every Resolution Center case --
      // attendance-linked or not -- so this one trigger covers both "attendance approved/
      // rejected -> employee" and "resolution case update -> employee" at once; they're the
      // same underlying action in this app.
      const employeeEmail = String(payload.employeeEmail || '').trim();
      if (!employeeEmail || !(await emailBelongsToTenant(tenantKey, employeeEmail))) return res.status(400).json({ error: 'Invalid recipient.' });
      const { subject, html } = await composeEmail(tenantKey, 'case-decided', {
        employeeName: payload.employeeName || 'there', caseSubject: payload.caseSubject || 'your case',
        decision: payload.decision === 'resolved' ? 'approved' : 'rejected', decidedBy: payload.decidedBy || 'your admin team'
      });
      await sendAppEmail(employeeEmail, subject, html);
    } else if (type === 'password-changed') {
      // Admin-reset-for-employee path (applyPasswordReset() in index.html) -- the only password
      // mutation that doesn't already go through server.js directly, so it's the only one that
      // needs this as a client-triggered /api/notify call rather than an inline send at the
      // point of change (see change-password and forgot-password/reset for those). Without a
      // permission check here, any authenticated employee could name any colleague's email and
      // have this endpoint mail them a "your password was changed" notice they never asked for --
      // low-damage on its own, but exactly the kind of thing this endpoint must never allow one
      // employee to do to another. Only someone who could actually reset a password (the same
      // permission the Reset button itself is gated on) may trigger this.
      if (!(await callerHasPerm(tenantKey, req.session, 'emp_reset_password'))) return res.status(403).json({ error: 'Employee password reset access required.' });
      const employeeEmail = String(payload.employeeEmail || '').trim();
      if (!employeeEmail || !(await emailBelongsToTenant(tenantKey, employeeEmail))) return res.status(400).json({ error: 'Invalid recipient.' });
      await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'password_reset', target: employeeEmail, meta: { via: 'admin-reset' } });
      const { subject, html } = await composeEmail(tenantKey, 'password-changed', {
        employeeName: payload.employeeName || 'there', changedBy: payload.changedBy || 'an administrator'
      });
      await sendAppEmail(employeeEmail, subject, html);
    } else if (type === 'payroll-submitted') {
      // Every payroll workflow stage shares the same 'payroll_approve' permission rather than
      // being tied to a specific named individual (see notifyPayrollSubmitted() in
      // payroll-governance.js) -- same recipient-list validation as case-filed above.
      const recipients = Array.isArray(payload.recipientEmails) ? payload.recipientEmails.map(e => String(e || '').trim()).filter(Boolean) : [];
      const validated = [];
      for (const email of recipients) {
        if (await emailBelongsToTenant(tenantKey, email)) validated.push(email);
      }
      if (!validated.length) return res.status(400).json({ error: 'No valid recipients.' });
      const { subject, html } = await composeEmail(tenantKey, 'payroll-submitted', {
        submittedBy: payload.submittedBy || 'A payroll maker', period: payload.period || 'the current period'
      });
      await sendAppEmail(validated, subject, html);
    } else if (type === 'payslip-released') {
      // One individual email per employee -- batching every employee's address into a single
      // email's recipient list would expose the whole payroll roster's emails to each other,
      // which "your payslip is ready" should never do (unlike the admin/HR-facing types above,
      // where every recipient is already staff who'd reasonably see each other listed).
      const employees = Array.isArray(payload.employees) ? payload.employees : [];
      const period = payload.period || 'the current period';
      let sent = 0;
      for (const entry of employees) {
        const email = String((entry && entry.email) || '').trim();
        if (!email || !(await emailBelongsToTenant(tenantKey, email))) continue;
        const { subject, html } = await composeEmail(tenantKey, 'payslip-released', { employeeName: (entry && entry.name) || 'there', period });
        await sendAppEmail(email, subject, html);
        sent++;
      }
      if (!sent) return res.status(400).json({ error: 'No valid recipients.' });
    } else if (type === 'employee-welcome') {
      // The new hire was only just pushed into USERS client-side -- it hasn't reached the
      // persisted tenant state yet (the debounced autosave lands ~700ms later), so
      // emailBelongsToTenant can't confirm this recipient the way every other type does.
      // callerHasPerm substitutes for it: only someone who actually holds emp_add (checked
      // against their own, already-persisted account) can trigger this send.
      if (!(await callerHasPerm(tenantKey, req.session, 'emp_add'))) return res.status(403).json({ error: 'Employee management access required.' });
      const employeeEmail = String(payload.employeeEmail || '').trim();
      if (!employeeEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employeeEmail)) return res.status(400).json({ error: 'Invalid recipient.' });
      const { subject, html } = await composeEmail(tenantKey, 'employee-welcome', {
        employeeName: payload.employeeName || 'there', employeeEmail, tempPassword: payload.tempPassword || '',
        addedBy: payload.addedBy || 'your HR team'
      });
      await sendAppEmail(employeeEmail, subject, html);
    } else if (type === 'employee-offboarded') {
      const recipients = Array.isArray(payload.recipientEmails) ? payload.recipientEmails.map(e => String(e || '').trim()).filter(Boolean) : [];
      const validated = [];
      for (const email of recipients) {
        if (await emailBelongsToTenant(tenantKey, email)) validated.push(email);
      }
      if (!validated.length) return res.status(400).json({ error: 'No valid recipients.' });
      const { subject, html } = await composeEmail(tenantKey, 'employee-offboarded', {
        employeeName: payload.employeeName || 'An employee', eid: payload.eid || '—', offboardedBy: payload.offboardedBy || 'System'
      });
      await sendAppEmail(validated, subject, html);
    } else {
      return res.status(400).json({ error: 'Unknown notification type.' });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to send notification.' });
  }
});

/* ── Platform client directory: lists/creates real, backend-tracked companies.
   Creating one also seeds its own isolated app_state row (defaultTenantState) so it's
   loggable-into immediately — see /api/auth/login below for how a login resolves to it. */
app.get('/api/platform/clients', requirePlatformAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  try {
    const result = await pool.query('SELECT * FROM platform_clients ORDER BY id ASC');
    res.json({ clients: result.rows.map(toPlatformClientJson) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load clients.', detail: error.message });
  }
});
app.post('/api/platform/clients', requirePlatformAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const name = String(req.body.name || '').trim();
  const adminEmail = String(req.body.adminEmail || '').trim().toLowerCase();
  const adminPass = String(req.body.adminPass || '');
  if (!name) return res.status(400).json({ error: 'Company name is required.' });
  if (!adminEmail || !adminPass) return res.status(400).json({ error: 'Admin email and password are required.' });
  const industry = String(req.body.industry || '');
  const plan = String(req.body.plan || 'Starter');
  const color = String(req.body.color || '#4f46e5');
  const initials = String(req.body.initials || name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '??');
  const contact = String(req.body.contact || 'Admin');
  // The create form only ever gathers one email address (the admin login), so default the
  // point-of-contact email to it rather than leaving the client card showing "—" for an
  // address the admin already typed in. Title/mobile aren't collected here and stay blank
  // until filled in via Edit Point of Contact.
  const contactEmail = String(req.body.contactEmail || adminEmail || '');
  const modules = Array.isArray(req.body.modules) ? req.body.modules : [];
  try {
    const base = slugifyTenantKey(name);
    let tenantKey = base;
    let attempt = 0;
    // Retry with a numeric suffix on the rare unique-key collision (two clients slugifying
    // to the same name) instead of failing the whole request.
    for (;;) {
      const existing = await pool.query('SELECT 1 FROM platform_clients WHERE tenant_key = $1', [tenantKey]);
      if (!existing.rowCount) break;
      attempt += 1;
      tenantKey = `${base}-${attempt}`;
    }
    const result = await pool.query(
      `INSERT INTO platform_clients (tenant_key, name, industry, plan, status, color, initials, contact, contact_email, admin_email, admin_pass, modules)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [tenantKey, name, industry, plan, color, initials, contact, contactEmail, adminEmail, await hashPassword(adminPass), JSON.stringify(modules)]
    );
    const client = result.rows[0];
    // Seed this tenant's own app_state row immediately — a client should never exist in the
    // directory without somewhere for its data to actually live.
    await withTenantScope(tenantKey, client2 => client2.query(
      'INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3) ON CONFLICT (tenant_key) DO NOTHING',
      [tenantKey, defaultTenantState(client), req.session.sub]
    ));
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'platform_client_created', target: tenantKey, meta: { name } });
    res.status(201).json({ client: toPlatformClientJson(client) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A client with that admin email or tenant key already exists.' });
    res.status(500).json({ error: 'Unable to create client.', detail: error.message });
  }
});
// Lets a God Admin open a real client's own data without ever seeing or replaying that
// client's actual password (GET /api/platform/clients deliberately never returns admin_pass).
// Issues a token scoped to that tenant, exactly like a normal login would, marked with
// impersonatedBy so it's distinguishable from the tenant's own admin logging in directly.
app.post('/api/platform/clients/:id/session', requirePlatformAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid client id is required.' });
  try {
    const clientRow = await pool.query('SELECT tenant_key, admin_email, status FROM platform_clients WHERE id = $1', [id]);
    if (!clientRow.rowCount) return res.status(404).json({ error: 'Client not found.' });
    const client = clientRow.rows[0];
    if (client.status === 'archived') return res.status(409).json({ error: 'This client is archived. Restore it before entering.' });
    const record = await readState(client.tenant_key);
    const token = sign({
      sub: client.admin_email, role: 'admin', tenantKey: client.tenant_key,
      impersonatedBy: req.session.sub, exp: Date.now() + 8 * 60 * 60 * 1000
    });
    await pool.query('UPDATE platform_clients SET last_active_at = NOW() WHERE id = $1', [id]);
    await auditLog(pool, { tenantKey: client.tenant_key, actor: req.session.sub, action: 'impersonation_started', target: client.admin_email, meta: {} });
    res.json({ token, state: stripPasswordHashes(record?.state || null), version: Number(record?.version || 0), persistence: Boolean(pool) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to open this client.', detail: error.message });
  }
});
// Actually persists a new God Admin password (see godAdminPassword() and the platform_admin_
// credential table above) -- previously Settings only ever changed a frontend-only variable, so
// a "changed" password stopped working the moment the page reloaded or a different device logged
// in, while every backend-authorized action still silently required the original one. Requires
// the current password as confirmation, same spirit as any normal password-change form, so a
// stolen/leaked session token alone can't relock the account away from its real owner.
app.post('/api/platform/god-password', requirePlatformAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  try {
    const ok = await verifyGodAdminPassword(currentPassword);
    if (!ok) return res.status(403).json({ error: 'Current password is incorrect.' });
    await setGodAdminPassword(newPassword, req.session.sub);
    await auditLog(pool, { tenantKey: null, actor: req.session.sub, action: 'password_change', target: 'god-admin', meta: {} });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update the password.', detail: error.message });
  }
});
const PLATFORM_CLIENT_STATUSES = new Set(['active', 'paused', 'archived']);
app.patch('/api/platform/clients/:id', requirePlatformAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid client id is required.' });
  const status = req.body.status;
  if (status !== undefined && !PLATFORM_CLIENT_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Status must be one of: active, paused, archived.' });
  }
  // Point-of-contact fields: undefined means "leave as-is" (COALESCE), but an explicit ''
  // must actually clear the field, so only fall back to the column's current value on
  // undefined, not on empty string.
  const contact = req.body.contact !== undefined ? String(req.body.contact) : null;
  const contactTitle = req.body.contactTitle !== undefined ? String(req.body.contactTitle) : null;
  const contactEmail = req.body.contactEmail !== undefined ? String(req.body.contactEmail) : null;
  const contactMobile = req.body.contactMobile !== undefined ? String(req.body.contactMobile) : null;
  try {
    const result = await pool.query(
      `UPDATE platform_clients SET
         status = COALESCE($1, status),
         contact = COALESCE($2, contact),
         contact_title = COALESCE($3, contact_title),
         contact_email = COALESCE($4, contact_email),
         contact_mobile = COALESCE($5, contact_mobile)
       WHERE id = $6 RETURNING *`,
      [status || null, contact, contactTitle, contactEmail, contactMobile, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Client not found.' });
    res.json({ client: toPlatformClientJson(result.rows[0]) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update client.', detail: error.message });
  }
});
// The one real original tenant (its directory row's tenant_key matches the fixed TENANT_KEY
// constant) can never be deleted through this — same rule the frontend already enforces for
// PLATFORM_CLIENTS id 1, kept here too since this is now a real, independent code path.
app.delete('/api/platform/clients/:id', requirePlatformAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid client id is required.' });
  try {
    const clientRow = await pool.query('SELECT tenant_key, status FROM platform_clients WHERE id = $1', [id]);
    if (!clientRow.rowCount) return res.status(404).json({ error: 'Client not found.' });
    const client = clientRow.rows[0];
    if (client.tenant_key === TENANT_KEY) return res.status(403).json({ error: 'The real connected company can never be permanently deleted.' });
    if (client.status !== 'archived') return res.status(409).json({ error: 'Archive this client before deleting it permanently.' });
    await pool.query('DELETE FROM platform_clients WHERE id = $1', [id]);
    await withTenantScope(client.tenant_key, async client2 => {
      await client2.query('DELETE FROM app_state WHERE tenant_key = $1', [client.tenant_key]);
      await client2.query('DELETE FROM app_state_audit WHERE tenant_key = $1', [client.tenant_key]);
      await client2.query('DELETE FROM zk_devices WHERE tenant_key = $1', [client.tenant_key]);
    });
    // zk_device_registry is intentionally outside RLS (see initializeDatabase), so this can stay
    // a plain query -- but it still needs cleaning up here, or a deleted tenant's device serials
    // would stay claimed forever, permanently unable to be registered to any other company.
    await pool.query('DELETE FROM zk_device_registry WHERE tenant_key = $1', [client.tenant_key]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to delete client.', detail: error.message });
  }
});

/* ── ZKTeco ADMS (push protocol) ──────────────────────────────────────────
   The device itself calls these endpoints — no auth, no CORS needed (it's not
   a browser). Configure on the device: Menu → Comm → Cloud Server Setting →
   Server Address = this app's host, Server Port = 80/443, enable ADMS. */
function parseAdmsLines(body) {
  return String(body || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
function zkKey(userId, date, time) { return userId + '|' + date + '|' + time; }

app.get('/iclock/cdata', async (req, res) => {
  const sn = String(req.query.SN || req.query.sn || 'unknown');
  const tenantKey = await resolveDeviceTenant(sn).catch(() => TENANT_KEY);
  await zkMutateDevice(sn, current => current, tenantKey).catch(() => {});
  res.type('text/plain').send(
    `GET OPTION FROM: ${sn}\r\nStamp=9999\r\nOpStamp=0\r\nErrorDelay=60\r\nDelay=30\r\nTransFlag=1111000000\r\nTimeZone=8\r\nRealtime=1\r\nEncrypt=None\r\n`
  );
});

app.post('/iclock/cdata', express.text({ type: '*/*', limit: '4mb' }), async (req, res) => {
  const sn = String(req.query.SN || req.query.sn || 'unknown');
  const table = String(req.query.table || '').toUpperCase();
  const lines = parseAdmsLines(req.body);
  let count = 0;
  try {
    const tenantKey = await resolveDeviceTenant(sn);
    if (table === 'ATTLOG') {
      const punches = [];
      lines.forEach(line => {
        const cols = line.split('\t');
        const userId = (cols[0] || '').trim();
        const timestamp = (cols[1] || '').trim();
        const statusCode = (cols[2] || '').trim();
        if (!userId || !timestamp) return;
        const [date, rawTime] = timestamp.split(' ');
        if (!date || !rawTime) return;
        // Some firmware reports seconds (HH:MM:SS) in the ATTLOG timestamp -- normalize to
        // HH:MM at the source so every downstream consumer (attendance calc, display, the
        // Attendance Report) only ever sees the clean format the rest of the app expects.
        const time = rawTime.slice(0, 5);
        punches.push({ userId, date, time, statusCode });
      });
      const record = await readState(tenantKey);
      const userMapping = record?.state?.zk?.userMapping || {};
      const employees = record?.state?.users || [];
      const shifts = record?.state?.company?.shifts || [];
      const punchBuffer = record?.state?.zk?.punchBuffer || { beforeMinutes: 120, afterMinutes: 480 };
      const mapped = punches.filter(p => userMapping[p.userId] != null);
      const unmapped = punches.filter(p => userMapping[p.userId] == null);
      if (mapped.length) {
        const punchesByEmpDate = new Map();
        const outOfBufferReasons = new Map();
        mapped.forEach(p => {
          const empId = userMapping[p.userId];
          const employee = employees.find(u => u.id === empId);
          // Only attempt shift-day resolution for employees who actually have a shift
          // assigned — otherwise there's no schedule to validate against, so keep the
          // punch on its raw device-reported date exactly like before.
          const hasShift = employee && employee.shiftId != null;
          const resolvedDate = hasShift
            ? TimekeepingCore.resolveShiftDay(employee, p.date, p.time, shifts, punchBuffer.beforeMinutes, punchBuffer.afterMinutes)
            : p.date;
          const finalDate = resolvedDate || p.date;
          const key = empId + '|' + finalDate;
          if (!punchesByEmpDate.has(key)) punchesByEmpDate.set(key, []);
          punchesByEmpDate.get(key).push({ time: p.time, kind: zkPunchKind(p.statusCode), statusCode: p.statusCode, serial: sn, source: 'zkteco-realtime' });
          if (hasShift && !resolvedDate) outOfBufferReasons.set(key, describeOutOfWindowReason(employee, p.date, shifts));
        });
        try {
          await mutateAppState(state => {
            const committed = zkCommitPunches(state, punchesByEmpDate, outOfBufferReasons);
            return { changed: committed > 0 };
          }, 'zk-device:' + sn, tenantKey);
          count += mapped.length;
        } catch (error) {
          console.error('ADMS attendance auto-commit error:', error.message);
          unmapped.push(...mapped); // fall back to pending so it isn't lost
        }
      }
      if (unmapped.length) {
        await zkMutateDevice(sn, current => {
          const seen = new Set(current.pending.map(r => zkKey(r.userId, r.date, r.time)));
          unmapped.forEach(p => {
            const key = zkKey(p.userId, p.date, p.time);
            if (seen.has(key)) return;
            seen.add(key);
            current.pending.push({ userId: p.userId, date: p.date, time: p.time, statusCode: p.statusCode || '', receivedAt: new Date().toISOString() });
            count++;
          });
          return current;
        }, tenantKey);
      } else {
        await zkMutateDevice(sn, current => current, tenantKey); // still touch last_seen
      }
    } else if (table === 'OPERLOG') {
      // Firmware varies on whether USER lines are tab- or space-delimited (and "USER PIN=16"
      // often arrives as one token), so extract known fields by regex instead of splitting.
      await zkMutateDevice(sn, current => {
        lines.forEach(line => {
          if (!/^USER\b/.test(line)) return;
          const pin = /\bPIN=(\S+)/.exec(line);
          if (!pin) return;
          const name = /\bName=(.*?)(?:\s+(?:Pri|Passwd|Card|Grp|TZ|Verify|ViceCard)=|\t|$)/.exec(line);
          const card = /\bCard=(\S+)/.exec(line);
          const userId = pin[1];
          const existing = current.deviceUsers.find(u => u.userId === userId);
          const entry = { userId, name: (name ? name[1] : '').trim(), cardNo: card ? card[1] : '' };
          if (existing) Object.assign(existing, entry); else current.deviceUsers.push(entry);
          count++;
        });
        return current;
      }, tenantKey);
    } else {
      await zkMutateDevice(sn, current => current, tenantKey);
    }
  } catch (error) {
    // Device retries on failure; log and still ack what we could to avoid a stuck retry loop.
    console.error('ADMS ingest error:', error.message);
  }
  res.type('text/plain').send(`OK: ${count}`);
});

app.get('/iclock/getrequest', async (req, res) => {
  const sn = String(req.query.SN || req.query.sn || 'unknown');
  try {
    const tenantKey = await resolveDeviceTenant(sn);
    let toSend = [];
    await zkMutateDevice(sn, current => {
      toSend = (current.commands || []).filter(c => c.status === 'pending');
      const sentAt = new Date().toISOString();
      toSend.forEach(c => { c.status = 'sent'; c.sentAt = sentAt; });
      return current;
    }, tenantKey);
    if (!toSend.length) return res.type('text/plain').send('OK');
    res.type('text/plain').send(toSend.map(c => `C:${c.id}:${c.command}`).join('\r\n') + '\r\n');
  } catch (error) {
    console.error('ADMS getrequest error:', error.message);
    res.type('text/plain').send('OK');
  }
});

// Devices report command results as key=value pairs (query string and/or body — this varies
// by firmware, so both are checked) like "ID=3&Return=0&CMD=REBOOT". Return=0 means success.
function parseAdmsKV(str) {
  const out = {};
  String(str || '').split('&').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    out[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
  });
  return out;
}
app.post('/iclock/devicecmd', express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const sn = String(req.query.SN || req.query.sn || 'unknown');
  try {
    const kv = Object.assign({}, parseAdmsKV(req.body), req.query);
    const cmdId = Number(kv.ID);
    if (cmdId) {
      const tenantKey = await resolveDeviceTenant(sn);
      await zkMutateDevice(sn, current => {
        const entry = (current.commands || []).find(c => c.id === cmdId);
        if (entry) {
          entry.status = String(kv.Return) === '0' ? 'done' : 'failed';
          entry.returnCode = kv.Return != null ? String(kv.Return) : null;
          entry.completedAt = new Date().toISOString();
        }
        return current;
      }, tenantKey);
    }
  } catch (error) {
    console.error('ADMS devicecmd error:', error.message);
  }
  res.type('text/plain').send('OK');
});

/* ── ZKTeco setup API (used by the browser UI) ──
   userMapping is admin-edited and lives in app_state (round-trips with the normal save flow);
   everything else here is device-owned and lives in zk_devices so it's never at risk of being
   overwritten by a stale browser save. */
app.get('/api/zk/status', requireAuth, authz.requirePermission('zksetup'), async (req, res) => {
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  const [record, devices, registry] = await Promise.all([
    readState(tenantKey), zkAllDevices(tenantKey),
    pool ? pool.query('SELECT serial, registered_at FROM zk_device_registry WHERE tenant_key = $1 ORDER BY registered_at ASC', [tenantKey]) : Promise.resolve({ rows: [] })
  ]);
  const userMapping = record?.state?.zk?.userMapping || {};
  res.json({
    devices: devices.map(d => ({
      serial: d.serial, lastSeen: d.last_seen, pendingCount: (d.pending || []).length,
      commands: (d.commands || []).slice(-10).reverse()
    })),
    deviceUsers: devices.flatMap(d => (d.device_users || []).map(u => ({ ...u, serial: d.serial }))),
    userMapping,
    registeredSerials: registry.rows.map(r => ({ serial: r.serial, registeredAt: r.registered_at }))
  });
});
// Claims a device serial for the caller's own tenant, so /iclock/* pushes from that serial
// resolve to this tenant instead of falling back to the original TENANT_KEY (see
// resolveDeviceTenant). A serial already claimed by a DIFFERENT tenant is refused rather than
// silently reassigned -- that would mean either a typo or a device that's genuinely changed
// hands, and either way it shouldn't happen without deliberate confirmation. Re-registering to
// the SAME tenant (e.g. after a device replacement using the old serial) is a harmless no-op.
app.post('/api/zk/register-device', requireAuth, authz.requirePermission('zksetup'), async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const serial = String(req.body.serial || '').trim();
  if (!serial) return res.status(400).json({ error: 'A device serial number is required.' });
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    const existing = await pool.query('SELECT tenant_key FROM zk_device_registry WHERE serial = $1', [serial]);
    if (existing.rowCount && existing.rows[0].tenant_key !== tenantKey) {
      return res.status(409).json({ error: 'This device serial is already registered to a different company.' });
    }
    await pool.query(
      `INSERT INTO zk_device_registry (serial, tenant_key, registered_by) VALUES ($1, $2, $3)
       ON CONFLICT (serial) DO UPDATE SET tenant_key = $2, registered_by = $3, registered_at = NOW()`,
      [serial, tenantKey, req.session.sub]
    );
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'zk_device_registered', target: serial, meta: {} });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to register device.', detail: error.message });
  }
});
// Releases a serial this tenant registered, e.g. after mis-typing it or decommissioning the
// device. Scoped to the caller's own tenant_key so one tenant can never release -- and thereby
// free up for reclaiming -- a serial that actually belongs to someone else.
app.post('/api/zk/unregister-device', requireAuth, authz.requirePermission('zksetup'), async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const serial = String(req.body.serial || '').trim();
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    const result = await pool.query('DELETE FROM zk_device_registry WHERE serial = $1 AND tenant_key = $2', [serial, tenantKey]);
    if (!result.rowCount) return res.status(404).json({ error: 'That serial is not registered to your company.' });
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'zk_device_unregistered', target: serial, meta: {} });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to unregister device.', detail: error.message });
  }
});
// Commands are an allowlist, not free-text, so the browser can never queue an arbitrary
// ADMS directive — only the ones vetted here. CLEAR LOG is destructive on the device (it
// erases attendance records not yet pushed), so the UI must confirm before calling this.
const ZK_COMMANDS = {
  reboot: { content: 'REBOOT', label: 'Restart device' },
  resync: { content: 'DATA QUERY ATTLOG', label: 'Resync attendance log' },
  resyncusers: { content: 'DATA QUERY USERINFO', label: 'Resync user list' },
  clearlog: { content: 'CLEAR LOG', label: 'Clear attendance log' }
};
// Command execution is deliberately gated on a narrower permission (zkcommand) than
// view/register/configure (zksetup) -- reboot and clear-log are destructive on the physical
// device, a meaningfully bigger blast radius than seeing status or claiming a serial for the
// tenant. zkcommand defaults to off for everyone except Super Admin; a tenant that wants a
// broader group of staff to be able to send device commands grants it explicitly.
app.post('/api/zk/command', requireAuth, authz.requirePermission('zkcommand'), async (req, res) => {
  const serial = String(req.body.serial || '');
  const def = ZK_COMMANDS[String(req.body.action || '')];
  if (!serial || !def) return res.status(400).json({ error: 'A valid device and command are required.' });
  try {
    let queuedId;
    const tenantKey = req.session.tenantKey || TENANT_KEY;
    await zkMutateDevice(serial, current => {
      const commands = current.commands || [];
      queuedId = commands.reduce((max, c) => Math.max(max, Number(c.id) || 0), 0) + 1;
      commands.push({
        id: queuedId, command: def.content, label: def.label, status: 'pending',
        queuedAt: new Date().toISOString(), sentAt: null, completedAt: null, returnCode: null,
        queuedBy: req.session.sub
      });
      current.commands = commands;
      return current;
    }, tenantKey);
    await auditLog(pool, { tenantKey, actor: req.session.sub, action: 'zk_command', target: serial, meta: { command: req.body.action } });
    res.json({ ok: true, id: queuedId });
  } catch (error) {
    res.status(500).json({ error: 'Unable to queue command.', detail: error.message });
  }
});
app.get('/api/zk/pending', requireAuth, authz.requirePermission('zksetup'), async (req, res) => {
  const devices = await zkAllDevices(req.session.tenantKey || TENANT_KEY);
  res.json({ records: devices.flatMap(d => (d.pending || []).map(r => ({ ...r, serial: d.serial }))) });
});
app.post('/api/zk/ack', requireAuth, authz.requirePermission('zksetup'), async (req, res) => {
  const consumedBySerial = new Map();
  (req.body.consumed || []).forEach(r => {
    const serial = r.serial || 'unknown';
    if (!consumedBySerial.has(serial)) consumedBySerial.set(serial, new Set());
    consumedBySerial.get(serial).add(zkKey(r.userId, r.date, r.time));
  });
  try {
    const tenantKey = req.session.tenantKey || TENANT_KEY;
    for (const [serial, keys] of consumedBySerial) {
      await zkMutateDevice(serial, current => {
        current.pending = current.pending.filter(r => !keys.has(zkKey(r.userId, r.date, r.time)));
        return current;
      }, tenantKey);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update pending records.', detail: error.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`SproutRipple PH running on port ${PORT}`)))
  .catch(error => { console.error('Database initialization failed:', error); process.exit(1); });
