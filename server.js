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
    if (!payload) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    req.session = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid session.' });
  }
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
  `);
}
async function readState() {
  if (!pool) return null;
  const result = await pool.query('SELECT state, version, updated_at FROM app_state WHERE tenant_key = $1', [TENANT_KEY]);
  return result.rows[0] || null;
}

// zk_devices lives in its own table, separate from app_state, specifically so device pushes
// (which happen independently of any browser session) can never be clobbered by the browser's
// full-state overwrite in PUT /api/state.
async function zkMutateDevice(serial, mutator) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT pending, device_users, commands FROM zk_devices WHERE tenant_key = $1 AND serial = $2 FOR UPDATE', [TENANT_KEY, serial]);
    const row = existing.rows[0] || { pending: [], device_users: [], commands: [] };
    const next = mutator({ pending: row.pending || [], deviceUsers: row.device_users || [], commands: row.commands || [] }) || {};
    await client.query(
      `INSERT INTO zk_devices (tenant_key, serial, last_seen, pending, device_users, commands, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, $5, NOW())
       ON CONFLICT (tenant_key, serial) DO UPDATE SET last_seen = NOW(), pending = $3, device_users = $4, commands = $5, updated_at = NOW()`,
      [TENANT_KEY, serial, JSON.stringify(next.pending || []), JSON.stringify(next.deviceUsers || []), JSON.stringify(next.commands || [])]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function zkAllDevices() {
  if (!pool) return [];
  const result = await pool.query('SELECT serial, last_seen, pending, device_users, commands FROM zk_devices WHERE tenant_key = $1', [TENANT_KEY]);
  return result.rows;
}

// Row-level lock on app_state so this can never race the browser's PUT /api/state —
// Postgres serializes any concurrent writer against the same row automatically.
async function mutateAppState(mutator, actor) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT state, version FROM app_state WHERE tenant_key = $1 FOR UPDATE', [TENANT_KEY]);
    const row = existing.rows[0];
    const state = row ? row.state : {};
    const outcome = mutator(state) || {};
    if (!outcome.changed) { await client.query('ROLLBACK'); return { state, version: row ? Number(row.version) : 0, changed: false }; }
    let version;
    if (row) {
      const updated = await client.query('UPDATE app_state SET state = $1, version = version + 1, updated_at = NOW(), updated_by = $2 WHERE tenant_key = $3 RETURNING version', [state, actor, TENANT_KEY]);
      version = Number(updated.rows[0].version);
    } else {
      const inserted = await client.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3) RETURNING version', [TENANT_KEY, state, actor]);
      version = Number(inserted.rows[0].version);
    }
    await client.query('INSERT INTO app_state_audit (tenant_key, version, actor) VALUES ($1, $2, $3)', [TENANT_KEY, version, actor]);
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
// Prefer the device's own in/out tag when any punch that day has one; only fall back to
// earliest-in/latest-out (the old behavior) when none of the day's punches are tagged —
// e.g. older firmware that doesn't send a status code at all.
function zkPickInOut(entries) {
  const ins = entries.filter(e => e.kind === 'in').map(e => e.time).sort();
  const outs = entries.filter(e => e.kind === 'out').map(e => e.time).sort();
  if (ins.length || outs.length) return { tin: ins[0] || '', tout: outs.length ? outs[outs.length - 1] : '' };
  const allTimes = entries.map(e => e.time).filter(Boolean).sort();
  return { tin: allTimes[0] || '', tout: allTimes.length > 1 ? allTimes[allTimes.length - 1] : '' };
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

// Mirrors the client's zkImport() merge logic: extend an existing day's tin/tout with new
// punches rather than overwrite, so a check-out committed after a check-in isn't lost.
// outOfBufferReasons (empId|date -> reason text) mark days where the punch fell outside the
// employee's scheduled shift buffer — those are committed but flagged pending instead of
// auto-approved, with the specific reason surfaced to the approver.
function zkCommitPunches(state, punchesByEmpDate, outOfBufferReasons) {
  state.attendance = Array.isArray(state.attendance) ? state.attendance : [];
  let nextId = state.attendance.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
  let committed = 0;
  punchesByEmpDate.forEach((entries, key) => {
    const sep = key.indexOf('|');
    const empId = Number(key.slice(0, sep));
    const date = key.slice(sep + 1);
    const existing = state.attendance.find(r => r.eid === empId && r.date === date && r.active !== false);
    const allEntries = entries.slice();
    if (existing && existing.tin) allEntries.push({ time: existing.tin, kind: 'in' });
    if (existing && existing.tout) allEntries.push({ time: existing.tout, kind: 'out' });
    const { tin, tout } = zkPickInOut(allEntries);
    const isLate = tin >= '08:30';
    const reason = outOfBufferReasons && outOfBufferReasons.get(key);
    const patch = {
      tin, tout, status: isLate ? 'late' : 'present', source: 'zkteco-realtime',
      approvalStatus: reason ? 'pending' : 'approved', filedBy: 'ZKTeco realtime',
      active: true, updatedAt: new Date().toISOString()
    };
    if (reason) patch.notes = appendNote(existing && existing.notes, reason);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.attendance.push(Object.assign({ id: nextId++, eid: empId, date, ot: 0, nd: 0, notes: '' }, patch));
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
    const record = await readState();
    const users = record?.state?.users || [];
    const matchedUser = users.find(user => String(user.email || '').toLowerCase() === email && user.pass === password && user.active !== false);
    const bootstrapAdmin = !record && email === (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@ph.com').toLowerCase()
      && password === (process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123');
    const platformAdmin = email === 'god@sproutripple.com' && password === (process.env.GOD_ADMIN_PASSWORD || 'godmode2026');
    if (!matchedUser && !bootstrapAdmin && !platformAdmin) return res.status(401).json({ error: 'Invalid email or password.' });
    const actor = matchedUser?.email || email;
    const token = sign({ sub: actor, role: matchedUser?.role || (platformAdmin ? 'platform' : 'admin'), exp: Date.now() + 8 * 60 * 60 * 1000 });
    res.json({ token, state: record?.state || null, version: Number(record?.version || 0), persistence: Boolean(pool) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to sign in to the data service.', detail: error.message });
  }
});
app.get('/api/state', requireAuth, async (_req, res) => {
  try {
    const record = await readState();
    res.json({ state: record?.state || null, version: Number(record?.version || 0), updatedAt: record?.updated_at || null });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load application data.', detail: error.message });
  }
});
app.put('/api/state', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured.' });
  const state = req.body.state;
  const expectedVersion = Number(req.body.version || 0);
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'A valid application state is required.' });
  try {
    const result = expectedVersion === 0
      ? await pool.query('INSERT INTO app_state (tenant_key, state, version, updated_by) VALUES ($1, $2, 1, $3) ON CONFLICT DO NOTHING RETURNING version, updated_at', [TENANT_KEY, state, req.session.sub])
      : await pool.query('UPDATE app_state SET state = $1, version = version + 1, updated_at = NOW(), updated_by = $2 WHERE tenant_key = $3 AND version = $4 RETURNING version, updated_at', [state, req.session.sub, TENANT_KEY, expectedVersion]);
    if (!result.rowCount) return res.status(409).json({ error: 'Newer changes are available. Reload before saving again.' });
    const version = Number(result.rows[0].version);
    await pool.query('INSERT INTO app_state_audit (tenant_key, version, actor) VALUES ($1, $2, $3)', [TENANT_KEY, version, req.session.sub]);
    res.json({ ok: true, version, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save application data.', detail: error.message });
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
  await zkMutateDevice(sn, current => current).catch(() => {});
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
    if (table === 'ATTLOG') {
      const punches = [];
      lines.forEach(line => {
        const cols = line.split('\t');
        const userId = (cols[0] || '').trim();
        const timestamp = (cols[1] || '').trim();
        const statusCode = (cols[2] || '').trim();
        if (!userId || !timestamp) return;
        const [date, time] = timestamp.split(' ');
        if (!date || !time) return;
        punches.push({ userId, date, time, statusCode });
      });
      const record = await readState();
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
          punchesByEmpDate.get(key).push({ time: p.time, kind: zkPunchKind(p.statusCode) });
          if (hasShift && !resolvedDate) outOfBufferReasons.set(key, describeOutOfWindowReason(employee, p.date, shifts));
        });
        try {
          await mutateAppState(state => {
            const committed = zkCommitPunches(state, punchesByEmpDate, outOfBufferReasons);
            return { changed: committed > 0 };
          }, 'zk-device:' + sn);
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
        });
      } else {
        await zkMutateDevice(sn, current => current); // still touch last_seen
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
      });
    } else {
      await zkMutateDevice(sn, current => current);
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
    let toSend = [];
    await zkMutateDevice(sn, current => {
      toSend = (current.commands || []).filter(c => c.status === 'pending');
      const sentAt = new Date().toISOString();
      toSend.forEach(c => { c.status = 'sent'; c.sentAt = sentAt; });
      return current;
    });
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
      await zkMutateDevice(sn, current => {
        const entry = (current.commands || []).find(c => c.id === cmdId);
        if (entry) {
          entry.status = String(kv.Return) === '0' ? 'done' : 'failed';
          entry.returnCode = kv.Return != null ? String(kv.Return) : null;
          entry.completedAt = new Date().toISOString();
        }
        return current;
      });
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
app.get('/api/zk/status', requireAuth, async (_req, res) => {
  const [record, devices] = await Promise.all([readState(), zkAllDevices()]);
  const userMapping = record?.state?.zk?.userMapping || {};
  res.json({
    devices: devices.map(d => ({
      serial: d.serial, lastSeen: d.last_seen, pendingCount: (d.pending || []).length,
      commands: (d.commands || []).slice(-10).reverse()
    })),
    deviceUsers: devices.flatMap(d => (d.device_users || []).map(u => ({ ...u, serial: d.serial }))),
    userMapping
  });
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
    });
    res.json({ ok: true, id: queuedId });
  } catch (error) {
    res.status(500).json({ error: 'Unable to queue command.', detail: error.message });
  }
});
app.get('/api/zk/pending', requireAuth, async (_req, res) => {
  const devices = await zkAllDevices();
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
    for (const [serial, keys] of consumedBySerial) {
      await zkMutateDevice(serial, current => {
        current.pending = current.pending.filter(r => !keys.has(zkKey(r.userId, r.date, r.time)));
        return current;
      });
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
