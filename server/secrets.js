// Phase 5: refuse to boot with known-public defaults in production. A local/demo deployment
// (NODE_ENV !== 'production') can still run with zero configuration -- that's the whole point of
// the fallback values existing -- but a production deployment silently inheriting
// 'local-development-only-change-me' as its session-signing secret, or 'admin123'/'godmode2026'
// as real credentials, is exactly the kind of thing that's invisible until it's exploited.
const KNOWN_DEFAULTS = {
  API_SESSION_SECRET: 'local-development-only-change-me',
  GOD_ADMIN_PASSWORD: 'godmode2026',
  BOOTSTRAP_ADMIN_EMAIL: 'admin@ph.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'admin123'
};

function validateProductionSecurityConfiguration(env = process.env) {
  if (env.NODE_ENV !== 'production') return { ok: true, problems: [] };
  const problems = [];
  if (!env.API_SESSION_SECRET || env.API_SESSION_SECRET === KNOWN_DEFAULTS.API_SESSION_SECRET) {
    problems.push('API_SESSION_SECRET is missing or set to the known development default. Every session token is forgeable by anyone who knows this value -- set a long random secret.');
  }
  if (env.API_SESSION_SECRET && env.API_SESSION_SECRET.length < 32) {
    problems.push('API_SESSION_SECRET is shorter than 32 characters -- use a longer, high-entropy random value.');
  }
  if (env.GOD_ADMIN_PASSWORD === KNOWN_DEFAULTS.GOD_ADMIN_PASSWORD) {
    problems.push('GOD_ADMIN_PASSWORD is set to the known public default (godmode2026). Change it, or set the God Admin password via Settings once and remove this env var.');
  }
  if (env.BOOTSTRAP_ADMIN_PASSWORD === KNOWN_DEFAULTS.BOOTSTRAP_ADMIN_PASSWORD) {
    problems.push('BOOTSTRAP_ADMIN_PASSWORD is set to the known public default (admin123). This only matters before the first tenant row exists, but change it anyway.');
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { validateProductionSecurityConfiguration, KNOWN_DEFAULTS };
