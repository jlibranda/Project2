// Security-event audit trail, separate from app_state_audit (which only records that a save
// happened, not what/why). Written to its own table rather than folded into the JSONB state so
// logging an event is never at risk of racing, or being wiped by, a full-state PUT.
//
// NEVER pass a password, temp password, hash, OTP code, bearer token, or session secret into
// `meta` -- this table is meant to be safe to show an admin/auditor without re-exposing a secret
// through the back door.
async function ensureAuditTable(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_audit_log (
      id BIGSERIAL PRIMARY KEY,
      tenant_key TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      meta JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS security_audit_log_tenant_idx ON security_audit_log (tenant_key, created_at DESC);
  `);
}

const SECRET_KEYS = /pass|token|secret|hash|otp|code/i;

// Defense-in-depth against accidentally logging a secret: strips any meta key whose name looks
// password/token/secret/otp/hash-shaped instead of trusting every call site to remember not to
// pass one in.
function scrubMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEYS.test(key)) continue;
    out[key] = value;
  }
  return out;
}

// tenantKey may be null for platform-level events (God Admin login, client creation) that aren't
// scoped to one tenant -- stored as the literal string 'platform' so the column stays NOT NULL
// and every row is still queryable by tenant.
async function auditLog(pool, { tenantKey, actor, action, target, meta }) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO security_audit_log (tenant_key, actor, action, target, meta) VALUES ($1, $2, $3, $4, $5)',
      [tenantKey || 'platform', String(actor || 'unknown'), String(action), target != null ? String(target) : null, JSON.stringify(scrubMeta(meta))]
    );
  } catch (error) {
    // Audit logging must never break the action it's describing.
    console.error('[audit] failed to write security_audit_log entry:', error.message);
  }
}

module.exports = { ensureAuditTable, auditLog };
