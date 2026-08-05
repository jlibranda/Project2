const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_key, serial)
    );
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
    const existing = await client.query('SELECT pending, device_users FROM zk_devices WHERE tenant_key = $1 AND serial = $2 FOR UPDATE', [TENANT_KEY, serial]);
    const row = existing.rows[0] || { pending: [], device_users: [] };
    const next = mutator({ pending: row.pending || [], deviceUsers: row.device_users || [] }) || {};
    await client.query(
      `INSERT INTO zk_devices (tenant_key, serial, last_seen, pending, device_users, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, NOW())
       ON CONFLICT (tenant_key, serial) DO UPDATE SET last_seen = NOW(), pending = $3, device_users = $4, updated_at = NOW()`,
      [TENANT_KEY, serial, JSON.stringify(next.pending || []), JSON.stringify(next.deviceUsers || [])]
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
  const result = await pool.query('SELECT serial, last_seen, pending, device_users FROM zk_devices WHERE tenant_key = $1', [TENANT_KEY]);
  return result.rows;
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
      await zkMutateDevice(sn, current => {
        const seen = new Set(current.pending.map(r => zkKey(r.userId, r.date, r.time)));
        lines.forEach(line => {
          const cols = line.split('\t');
          const userId = (cols[0] || '').trim();
          const timestamp = (cols[1] || '').trim();
          if (!userId || !timestamp) return;
          const [date, time] = timestamp.split(' ');
          if (!date || !time) return;
          const key = zkKey(userId, date, time);
          if (seen.has(key)) return;
          seen.add(key);
          current.pending.push({ userId, date, time, receivedAt: new Date().toISOString() });
          count++;
        });
        return current;
      });
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

app.get('/iclock/getrequest', (req, res) => {
  // Command queue not implemented yet — always tell the device there's nothing pending.
  res.type('text/plain').send('OK');
});

app.post('/iclock/devicecmd', express.text({ type: '*/*', limit: '256kb' }), (_req, res) => {
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
    devices: devices.map(d => ({ serial: d.serial, lastSeen: d.last_seen, pendingCount: (d.pending || []).length })),
    deviceUsers: devices.flatMap(d => (d.device_users || []).map(u => ({ ...u, serial: d.serial }))),
    userMapping
  });
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
