// Refuse to boot with known-public defaults in production. A local/demo deployment
// (NODE_ENV !== 'production') can still run with zero configuration -- that's the whole point of
// the fallback values existing -- but a production deployment authenticating with
// 'local-development-only-change-me' as its session-signing secret, or 'admin123'/'godmode2026'
// as real credentials, is exactly the kind of thing that's invisible until it's exploited.
//
// Split into three checks with different timing, because two of them are DB-state-dependent:
//   - the session secret is checked immediately, before the process does anything else -- it has
//     no DB dependency and every token-signing operation needs it to already be safe.
//   - the God Admin and bootstrap-admin checks run once the database is reachable (see
//     initializeDatabase() in server.js), because whether a fallback would ever actually be used
//     depends on whether a real credential already exists.
//
// NO production request path may authenticate with a known public default because an env var was
// omitted -- that governs both directions this check has to cover:
//   1. No DB credential yet: the env var is what the effective credential will actually become the
//      moment this boots (see godAdminPassword()/the bootstrap INSERT) -- it must be present and
//      not equal to the known default. A merely-missing var is JUST AS UNSAFE as one explicitly
//      set to the default (both end up authenticating with the public password), so both are
//      hard failures here -- there is no "warn and continue" tier for production.
//   2. A DB credential already exists: normally that's sufficient on its own (a real credential
//      was set via Settings/bootstrap and the env var is never consulted again) -- EXCEPT that
//      credential might itself be a bcrypt hash of the known default (someone bootstrapped with
//      it once, or Settings was used to "change" it back to the same public value). A bcrypt hash
//      of 'admin123' is still 'admin123' -- server.js verifies the stored hash against the known
//      default with verifyPassword() and passes the result in here as dbCredentialIsKnownDefault.
const KNOWN_DEFAULTS = {
  API_SESSION_SECRET: 'local-development-only-change-me',
  GOD_ADMIN_PASSWORD: 'godmode2026',
  BOOTSTRAP_ADMIN_EMAIL: 'admin@ph.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'admin123'
};

// Matches the app's own account password minimum (server.js's normal login/change-password
// validation) -- deliberately kept at 6, never raised independently for these two env-sourced
// credentials, so this is one shared constant rather than a second policy that could drift.
const MIN_PASSWORD_LENGTH = 6;

function isProduction(env) {
  return env.NODE_ENV === 'production';
}

// Whether `value` is acceptable as a real replacement credential: present, not the known public
// default, and at least MIN_PASSWORD_LENGTH characters. Shared between the two validate*
// functions below (the "no DB credential yet" branch) and server.js's own auto-rotation gate (an
// unsafe STORED credential is only rotated when the env var offered as its replacement actually
// clears this bar -- a 1-character GOD_ADMIN_PASSWORD must never become the new stored credential
// any more than it should have been the fallback in the first place).
function isSafeReplacementCredential(value, knownDefault) {
  return typeof value === 'string' && value.length > 0 && value !== knownDefault && value.length >= MIN_PASSWORD_LENGTH;
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
// password has been set via Settings/bootstrap at least once). dbCredentialIsKnownDefault: only
// meaningful when hasDbCredential is true -- whether that stored bcrypt hash verifies against the
// known public default password (server.js computes this with verifyPassword(), never a plain
// looksLikeHash() check, since a hash of the default is still the default). When hasDbCredential
// is false, GOD_ADMIN_PASSWORD is what godAdminPassword() will actually fall back to the moment
// this boots, so it must be present and not the known default -- no exceptions, missing is exactly
// as unsafe as explicit.
function validateGodAdminCredential({ env = process.env, hasDbCredential, dbCredentialIsKnownDefault }) {
  if (!isProduction(env)) return { ok: true, problems: [] };
  if (hasDbCredential) {
    if (dbCredentialIsKnownDefault) {
      return { ok: false, problems: [`The God Admin password stored in the database is the known public default (godmode2026), just bcrypt-hashed -- a hash of a known password is not a secret. A server that refuses to boot can never be logged into to change it via Settings, so set a real, non-default GOD_ADMIN_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) and restart -- the stored credential is rotated to match it automatically at boot (see server.js\'s DB-aware credential check), no direct database access needed.`] };
    }
    return { ok: true, problems: [] };
  }
  if (!isSafeReplacementCredential(env.GOD_ADMIN_PASSWORD, KNOWN_DEFAULTS.GOD_ADMIN_PASSWORD)) {
    return { ok: false, problems: [`No God Admin password exists in the database yet, and GOD_ADMIN_PASSWORD is missing, set to the known public default (godmode2026), or shorter than the required ${MIN_PASSWORD_LENGTH}-character minimum. Set a real GOD_ADMIN_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters, not the public default) before starting -- production must never authenticate with the public default because this env var was left unset or too weak.`] };
  }
  return { ok: true, problems: [] };
}

// tenantRowExists: whether the one bootstrap tenant row already exists in platform_clients.
// bootstrapCredentialIsKnownDefault: only meaningful when tenantRowExists is true -- whether that
// row's platform_clients.admin_pass verifies against the known public default (admin123), same
// verifyPassword()-based check as the God Admin credential above, for the same reason: a bcrypt
// hash of 'admin123' is still 'admin123'. When tenantRowExists is false, this boot is about to
// CREATE that row using BOOTSTRAP_ADMIN_PASSWORD as the real credential, so it must be present and
// not the known default -- missing is exactly as unsafe as explicit, no "warn and continue" tier.
function validateBootstrapCredential({ env = process.env, tenantRowExists, bootstrapCredentialIsKnownDefault }) {
  if (!isProduction(env)) return { ok: true, problems: [] };
  if (tenantRowExists) {
    if (bootstrapCredentialIsKnownDefault) {
      return { ok: false, problems: [`The bootstrap admin password stored in the database is the known public default (admin123), just bcrypt-hashed -- a hash of a known password is not a secret. A server that refuses to boot can never be logged into to change it via Settings, so set a real, non-default BOOTSTRAP_ADMIN_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) and restart -- the stored credential is rotated to match it automatically at boot (see server.js\'s DB-aware credential check), no direct database access needed.`] };
    }
    return { ok: true, problems: [] };
  }
  if (!isSafeReplacementCredential(env.BOOTSTRAP_ADMIN_PASSWORD, KNOWN_DEFAULTS.BOOTSTRAP_ADMIN_PASSWORD)) {
    return { ok: false, problems: [`The initial tenant/admin row does not exist yet, and BOOTSTRAP_ADMIN_PASSWORD is missing, set to the known public default (admin123), or shorter than the required ${MIN_PASSWORD_LENGTH}-character minimum. Set a real BOOTSTRAP_ADMIN_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters, not the public default) before the first boot that creates it -- production must never create that row with the public default because this env var was left unset or too weak.`] };
  }
  return { ok: true, problems: [] };
}

module.exports = { validateSessionSecret, validateGodAdminCredential, validateBootstrapCredential, KNOWN_DEFAULTS, MIN_PASSWORD_LENGTH, isSafeReplacementCredential };
