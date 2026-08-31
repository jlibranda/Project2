// Refuse to boot with known-public defaults in production. A local/demo deployment
// (NODE_ENV !== 'production') can still run with zero configuration -- that's the whole point of
// the fallback values existing -- but a production deployment silently inheriting
// 'local-development-only-change-me' as its session-signing secret, or 'admin123'/'godmode2026'
// as real credentials, is exactly the kind of thing that's invisible until it's exploited.
//
// Split into three checks with different timing, because two of them are DB-state-dependent:
//   - the session secret is checked immediately, before the process does anything else -- it has
//     no DB dependency and every token-signing operation needs it to already be safe.
//   - the God Admin and bootstrap-admin checks run once the database is reachable (see
//     initializeDatabase() in server.js), because whether a fallback would ever actually be used
//     depends on whether a real credential already exists: an already-initialized production
//     deployment that changed its God Admin password via Settings (persisted to
//     platform_admin_credential) or already has its one real tenant row in platform_clients no
//     longer needs the corresponding env var at all, and must not be forced to keep it set just
//     to boot. What must NEVER happen is the reverse: no DB credential yet, and the env var
//     missing or left at the known default -- that's the exact loophole this closes, since the
//     original check only caught an env var EXPLICITLY set to the default string, not one simply
//     left unset (which silently falls back to the same default at the point of use).
const KNOWN_DEFAULTS = {
  API_SESSION_SECRET: 'local-development-only-change-me',
  GOD_ADMIN_PASSWORD: 'godmode2026',
  BOOTSTRAP_ADMIN_EMAIL: 'admin@ph.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'admin123'
};

function isProduction(env) {
  return env.NODE_ENV === 'production';
}

function validateSessionSecret(env = process.env) {
  if (!isProduction(env)) return { ok: true, problems: [] };
  const problems = [];
  if (!env.API_SESSION_SECRET || env.API_SESSION_SECRET === KNOWN_DEFAULTS.API_SESSION_SECRET) {
    problems.push('API_SESSION_SECRET is missing or set to the known development default. Every session token is forgeable by anyone who knows this value -- set a long random secret.');
  } else if (env.API_SESSION_SECRET.length < 32) {
    problems.push('API_SESSION_SECRET is shorter than 32 characters -- use a longer, high-entropy random value.');
  }
  return { ok: problems.length === 0, problems };
}

// hasDbCredential: whether a row already exists in platform_admin_credential (a God Admin
// password has been set via Settings at least once). When true, GOD_ADMIN_PASSWORD is optional --
// the DB value is authoritative and the env var is never consulted. When false, the env var is
// what godAdminPassword() will actually fall back to, so it must be present and non-default.
function validateGodAdminCredential({ env = process.env, hasDbCredential }) {
  if (!isProduction(env)) return { ok: true, problems: [] };
  if (hasDbCredential) return { ok: true, problems: [] };
  const problems = [];
  if (!env.GOD_ADMIN_PASSWORD || env.GOD_ADMIN_PASSWORD === KNOWN_DEFAULTS.GOD_ADMIN_PASSWORD) {
    problems.push('No God Admin password exists in the database yet, and GOD_ADMIN_PASSWORD is missing or set to the known public default (godmode2026). Set a real GOD_ADMIN_PASSWORD, or set the password via Settings first on a non-production environment and let it migrate.');
  }
  return { ok: problems.length === 0, problems };
}

// tenantRowExists: whether the one bootstrap tenant row already exists in platform_clients. When
// true, the bootstrap insert is a no-op (ON CONFLICT DO NOTHING) regardless of what
// BOOTSTRAP_ADMIN_PASSWORD holds, so it's never actually used and doesn't need to be checked. When
// false, this boot is about to create that row using BOOTSTRAP_ADMIN_PASSWORD as the real
// credential, so it must be present and non-default.
function validateBootstrapCredential({ env = process.env, tenantRowExists }) {
  if (!isProduction(env)) return { ok: true, problems: [] };
  if (tenantRowExists) return { ok: true, problems: [] };
  const problems = [];
  if (!env.BOOTSTRAP_ADMIN_PASSWORD || env.BOOTSTRAP_ADMIN_PASSWORD === KNOWN_DEFAULTS.BOOTSTRAP_ADMIN_PASSWORD) {
    problems.push('The initial tenant/admin row does not exist yet, and BOOTSTRAP_ADMIN_PASSWORD is missing or set to the known public default (admin123). Set a real BOOTSTRAP_ADMIN_PASSWORD before the first boot that creates it.');
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { validateSessionSecret, validateGodAdminCredential, validateBootstrapCredential, KNOWN_DEFAULTS };
