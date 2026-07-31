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
const allowedOrigins = new Set((process.env.APP_ALLOWED_ORIGINS || [
  'https://sproutripple-ph.vercel.app',
  'https://sproutripple-ph-payroll.jlibranda.chatgpt.site',
  'https://sproutripple-ph-production.up.railway.app'
].join(',')).split(',').map(value => value.trim()).filter(Boolean));

app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
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
  `);
}
async function readState() {
  if (!pool) return null;
  const result = await pool.query('SELECT state, version, updated_at FROM app_state WHERE tenant_key = $1', [TENANT_KEY]);
  return result.rows[0] || null;
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

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`SproutRipple PH running on port ${PORT}`)))
  .catch(error => { console.error('Database initialization failed:', error); process.exit(1); });
