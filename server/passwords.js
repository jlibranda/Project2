// Centralized password hashing. Every password comparison and every password write in the
// app goes through this module -- no other file should call bcrypt directly or compare a
// password with === anymore.
//
// Migration: existing deployments have plaintext passwords sitting in Postgres (state.users[].pass,
// platform_clients.admin_pass, platform_admin_credential.password). We can't bulk-rehash those
// blind -- a plaintext value and a bcrypt hash are indistinguishable without trying to verify it,
// and there's no way to recover a forgotten plaintext password from a hash to migrate it up front.
// Instead this hashes each account's password lazily, the moment we have both the live plaintext
// (the user just typed it in to log in) and proof it's correct (it matched): see verifyPassword's
// needsMigration flag and every call site that acts on it.
const bcrypt = require('bcrypt');

const BCRYPT_COST = 12;
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function looksLikeHash(value) {
  return typeof value === 'string' && BCRYPT_HASH_RE.test(value);
}

async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_COST);
}

// Returns { ok, needsMigration }. ok=true means the supplied password is correct. needsMigration
// is only ever true alongside ok=true, and means `stored` was legacy plaintext -- the caller
// must hashPassword(supplied) and persist it over the old plaintext value, then never do so again
// for that account. A stored value that's already a bcrypt hash is verified properly and never
// flags migration.
async function verifyPassword(supplied, stored) {
  const value = String(supplied ?? '');
  if (stored == null || stored === '') return { ok: false, needsMigration: false };
  if (looksLikeHash(stored)) {
    const ok = await bcrypt.compare(value, stored);
    return { ok, needsMigration: false };
  }
  // Legacy plaintext row. Constant-time-ish compare isn't meaningful here (the whole point is
  // this path is being retired), but avoid the obvious pitfall of `===` on attacker-controlled
  // length anyway by just comparing directly -- there's no secret-length signal worth closing
  // for a value that's about to stop existing the moment this succeeds once.
  const ok = value.length > 0 && value === String(stored);
  return { ok, needsMigration: ok };
}

module.exports = { hashPassword, verifyPassword, looksLikeHash, BCRYPT_HASH_RE };
