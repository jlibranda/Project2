const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const TimekeepingCore = require('./public/timekeeping-core.js');

const app = express();
const PORT = process.env.PORT || 3000;
const TENANT_KEY = process.env.APP_TENANT_KEY || 'sproutripple-ph';
const SESSION_SECRET = process.env.API_SESSION_SECRET || 'local-development-only-change-me';
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined })
  : null;
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
  // Migrate the one existing real tenant into the directory, exactly once. Purely additive —
  // its tenant_key and app_state row are untouched, so this can never affect the live login
  // or data flow for the real company.
  await pool.query(
    `INSERT INTO platform_clients (tenant_key, name, industry, plan, status, color, initials, admin_email, admin_pass, modules)
     VALUES ($1, 'SproutRipple PH', 'HR Technology', 'Internal', 'active', '#4f46e5', 'S', $2, $3, '[]')
     ON CONFLICT (tenant_key) DO NOTHING`,
    [TENANT_KEY, process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@ph.com', process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123']
  );
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

app.get('/api/health', async (_req, res) => {
  try {
    if (pool) await pool.query('SELECT 1');
    res.json({ ok: true, database: pool ? 'connected' : 'not_configured' });
  } catch (error) {
    res.status(503).json({ ok: false, database: 'unavailable', error: error.message });
  }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    // Platform God Admin — platform-wide, not scoped to any one tenant. Still returns the
    // legacy tenant's state exactly as before: the frontend's Platform Admin console reads
    // its client list from state.platformClients until Step 3 moves it onto
    // GET /api/platform/clients instead, so this can't change yet without losing visibility
    // into anything already saved there (archived demo clients, etc.).
    const platformAdmin = email === 'god@sproutripple.com' && password === (await godAdminPassword());
    if (platformAdmin) {
      const record = await readState(TENANT_KEY);
      const token = sign({ sub: email, role: 'platform', tenantKey: TENANT_KEY, exp: Date.now() + 8 * 60 * 60 * 1000 });
      return res.json({ token, state: record?.state || null, version: Number(record?.version || 0), persistence: Boolean(pool) });
    }

    // 1. The one original real tenant — checked first, on the exact same fixed tenant_key,
    //    so this deployment's actual working login can never change under this rewrite.
    const legacyRecord = await readState(TENANT_KEY);
    const legacyUsers = legacyRecord?.state?.users || [];
    let matchedUser = legacyUsers.find(u => String(u.email || '').toLowerCase() === email && u.pass === password && u.active !== false);
    const bootstrapAdmin = !legacyRecord && email === (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@ph.com').toLowerCase()
      && password === (process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123');
    let tenantKey = (matchedUser || bootstrapAdmin) ? TENANT_KEY : null;
    let record = tenantKey ? legacyRecord : null;

    // 2. A real client's own company-admin account (platform_clients.admin_email/admin_pass).
    if (!tenantKey && pool) {
      const clientRow = await pool.query('SELECT tenant_key FROM platform_clients WHERE admin_email = $1 AND admin_pass = $2', [email, password]);
      if (clientRow.rowCount) tenantKey = clientRow.rows[0].tenant_key;
    }

    // 3. A regular employee of some other real client — search every tenant's own users array
    //    directly via JSONB instead of keeping a separate index in sync. This is the one place
    //    in the app that legitimately needs to see every tenant's app_state at once (we don't
    //    know which tenant these credentials belong to until this query resolves it) -- see
    //    withLoginLookupScope's own comment for why that's safe under RLS.
    if (!tenantKey && pool) {
      const empRow = await withLoginLookupScope(client => client.query(
        `SELECT tenant_key, state, version, u AS matched_user FROM app_state, jsonb_array_elements(state->'users') AS u
         WHERE u->>'email' = $1 AND u->>'pass' = $2 AND COALESCE((u->>'active')::boolean, true) = true
         LIMIT 1`,
        [email, password]
      ));
      if (empRow.rowCount) { tenantKey = empRow.rows[0].tenant_key; record = empRow.rows[0]; matchedUser = empRow.rows[0].matched_user; }
    }

    if (!tenantKey) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!record) record = await readState(tenantKey);

    const role = (matchedUser && matchedUser.role) || 'admin';
    const token = sign({ sub: email, role, tenantKey, exp: Date.now() + 8 * 60 * 60 * 1000 });
    res.json({ token, state: record?.state || null, version: Number(record?.version || 0), persistence: Boolean(pool) });
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
    if (entry.accountType === 'client-admin') {
      await pool.query('UPDATE platform_clients SET admin_pass = $1 WHERE id = $2', [newPassword, entry.clientId]);
    } else {
      await mutateAppState(state => {
        const u = (state.users || []).find(x => x.id === entry.userId);
        if (!u) return { changed: false };
        u.pass = newPassword;
        return { changed: true };
      }, email, entry.tenantKey);
    }
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
      if (match.pass !== currentPassword) return res.status(401).json({ error: 'Current password is incorrect.' });
      await mutateAppState(state => {
        const u = (state.users || []).find(x => x.id === match.id);
        if (!u) return { changed: false };
        u.pass = newPassword;
        return { changed: true };
      }, sub, tenantKey);
      composeEmail(tenantKey, 'password-changed', { employeeName: match.firstName || match.name || 'there', changedBy: 'you' })
        .then(({ subject, html }) => sendAppEmail(sub, subject, html)).catch(() => {});
      return res.json({ ok: true });
    }
    const clientRow = await pool.query('SELECT id, admin_pass FROM platform_clients WHERE tenant_key = $1', [tenantKey]);
    if (!clientRow.rowCount) return res.status(404).json({ error: 'Account not found.' });
    if (clientRow.rows[0].admin_pass !== currentPassword) return res.status(401).json({ error: 'Current password is incorrect.' });
    await pool.query('UPDATE platform_clients SET admin_pass = $1 WHERE id = $2', [newPassword, clientRow.rows[0].id]);
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

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const record = await readState(req.session.tenantKey || TENANT_KEY);
    res.json({ state: record?.state || null, version: Number(record?.version || 0), updatedAt: record?.updated_at || null });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load application data.', detail: error.message });
  }
});
app.put('/api/state', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const state = req.body.state;
  const expectedVersion = Number(req.body.version || 0);
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'A valid application state is required.' });
  try {
    const { result, version } = await withTenantScope(tenantKey, async client => {
      const r = expectedVersion === 0
        ? await client.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3) ON CONFLICT DO NOTHING RETURNING version, updated_at', [tenantKey, state, req.session.sub])
        : await client.query('UPDATE app_state SET state = $1, version = version + 1, updated_at = NOW(), updated_by = $2 WHERE tenant_key = $3 AND version = $4 RETURNING version, updated_at', [state, req.session.sub, tenantKey, expectedVersion]);
      if (!r.rowCount) return { result: r, version: null };
      const v = Number(r.rows[0].version);
      await client.query('INSERT INTO app_state_audit (tenant_key, version, actor) VALUES ($1, $2, $3)', [tenantKey, v, req.session.sub]);
      return { result: r, version: v };
    });
    if (!result.rowCount) return res.status(409).json({ error: 'Newer changes are available. Reload before saving again.' });
    res.json({ ok: true, version, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save application data.', detail: error.message });
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
function buildAssistantContext(state, session, isAdmin) {
  const users = (state.users || []).filter(u => u.role === 'employee');
  const today = new Date().toISOString().slice(0, 10);
  if (isAdmin) {
    const enterprise = state.enterprise || {};
    return {
      today,
      companyName: state.company?.name || '',
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
      const mine = (state.payrolls || []).map(r => ({ r, item: (r.items || []).find(i => i.eid === me.id) })).filter(x => x.item);
      const last = mine[mine.length - 1];
      if (last) self.latestPayslip = { period: last.r.from + ' - ' + last.r.to, gross: last.item.gross, deductions: last.item.total, net: last.item.net };
    }
  }
  return {
    today, companyName: state.company?.name || '', me: me ? self : null,
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
      'You are AURA Assistant, an HR and payroll data assistant embedded in a Philippine HR/payroll system.',
      'Answer ONLY using the JSON data provided below -- never invent, estimate, or guess a number or fact that is not present in it.',
      'If the answer is not present in the data, say plainly that you do not have that information rather than guessing.',
      lang === 'tl' ? 'Respond in Tagalog/Filipino.' : 'Respond in English.',
      'Be concise -- a few sentences at most, like a helpful coworker, not a report.',
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
        max_tokens: 500,
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
      // point of change (see change-password and forgot-password/reset for those).
      const employeeEmail = String(payload.employeeEmail || '').trim();
      if (!employeeEmail || !(await emailBelongsToTenant(tenantKey, employeeEmail))) return res.status(400).json({ error: 'Invalid recipient.' });
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
      [tenantKey, name, industry, plan, color, initials, contact, contactEmail, adminEmail, adminPass, JSON.stringify(modules)]
    );
    const client = result.rows[0];
    // Seed this tenant's own app_state row immediately — a client should never exist in the
    // directory without somewhere for its data to actually live.
    await withTenantScope(tenantKey, client2 => client2.query(
      'INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3) ON CONFLICT (tenant_key) DO NOTHING',
      [tenantKey, defaultTenantState(client), req.session.sub]
    ));
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
    res.json({ token, state: record?.state || null, version: Number(record?.version || 0), persistence: Boolean(pool) });
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
    const actual = await godAdminPassword();
    if (currentPassword !== actual) return res.status(403).json({ error: 'Current password is incorrect.' });
    await pool.query(
      `INSERT INTO platform_admin_credential (id, password, updated_by) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET password = $1, updated_at = NOW(), updated_by = $2`,
      [newPassword, req.session.sub]
    );
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
app.get('/api/zk/status', requireAuth, async (req, res) => {
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
app.post('/api/zk/register-device', requireAuth, async (req, res) => {
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
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to register device.', detail: error.message });
  }
});
// Releases a serial this tenant registered, e.g. after mis-typing it or decommissioning the
// device. Scoped to the caller's own tenant_key so one tenant can never release -- and thereby
// free up for reclaiming -- a serial that actually belongs to someone else.
app.post('/api/zk/unregister-device', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const serial = String(req.body.serial || '').trim();
  const tenantKey = req.session.tenantKey || TENANT_KEY;
  try {
    const result = await pool.query('DELETE FROM zk_device_registry WHERE serial = $1 AND tenant_key = $2', [serial, tenantKey]);
    if (!result.rowCount) return res.status(404).json({ error: 'That serial is not registered to your company.' });
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
app.post('/api/zk/command', requireAuth, async (req, res) => {
  const serial = String(req.body.serial || '');
  const def = ZK_COMMANDS[String(req.body.action || '')];
  if (!serial || !def) return res.status(400).json({ error: 'A valid device and command are required.' });
  try {
    let queuedId;
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
    }, req.session.tenantKey || TENANT_KEY);
    res.json({ ok: true, id: queuedId });
  } catch (error) {
    res.status(500).json({ error: 'Unable to queue command.', detail: error.message });
  }
});
app.get('/api/zk/pending', requireAuth, async (req, res) => {
  const devices = await zkAllDevices(req.session.tenantKey || TENANT_KEY);
  res.json({ records: devices.flatMap(d => (d.pending || []).map(r => ({ ...r, serial: d.serial }))) });
});
app.post('/api/zk/ack', requireAuth, async (req, res) => {
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
