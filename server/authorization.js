// Backend authorization framework. requireAuth/requirePlatformAdmin (token-only, no DB lookup
// needed) stay in server.js where the token-signing/verification lives; everything here needs
// the CALLER's actual persisted state (their ACCESS_LEVELS grant) to answer "is this allowed",
// which is the authoritative check -- the frontend's canAccess()/isAdminUser() only ever decide
// what to *show*, never what the API actually accepts.
//
// This reuses the exact same permission-key model the Access & Permissions UI already edits
// (state.accessLevels[].perms[key] === true) instead of inventing a second RBAC system --
// serverCanAccess in server.js (used by the AI assistant) checks the identical thing; hasPermission
// below is that same rule, just resolving the caller from session.sub first so every route can
// call it directly instead of re-deriving `me` itself each time.

// role==='admin' / role==='platform' (both are how a session token is actually marked -- see
// server.js sign()) or accessLevelId===1 (Super Admin) bypass every permission check below. This
// mirrors how the rest of the app already treats "admin" -- the frontend's own isAdminUser() and
// the existing AI-assistant serverCanAccess() both use the identical rule -- kept identical here
// rather than introducing a third, subtly different definition that could quietly diverge.
function isAdminCaller(session, caller) {
  if (session && (session.role === 'platform' || session.role === 'admin')) return true;
  return !!(caller && (caller.role === 'admin' || caller.accessLevelId === 1));
}

// Resolves the CALLER's own persisted employee record from their session identity (never the
// target of whatever action is being authorized). A real client's own company-admin login
// (platform_clients.admin_email, session.role==='admin') has no USERS[] row at all -- this
// correctly returns null for that case; isAdminCaller's session.role check already covers it
// without needing a record.
function resolveCaller(state, session) {
  if (!state || !session) return null;
  const email = String(session.sub || '').toLowerCase();
  return (state.users || []).find(u => String(u.email || '').toLowerCase() === email) || null;
}

function hasPermission(state, session, permKey) {
  const caller = resolveCaller(state, session);
  if (isAdminCaller(session, caller)) return true;
  if (!caller) return false;
  const level = (state.accessLevels || []).find(a => a.id === caller.accessLevelId);
  return !!(level && level.perms && level.perms[permKey] === true);
}

function getAuthenticatedUser(state, session) {
  const caller = resolveCaller(state, session);
  return { session, caller, isAdmin: isAdminCaller(session, caller) };
}

// tenantKeyOf/readState are injected so this module never has to know about Postgres or the
// signed-token format directly -- it only needs "given a session, load that tenant's state".
function createAuthorization({ readState, tenantKeyOf }) {
  async function loadCallerState(req) {
    const tenantKey = tenantKeyOf(req);
    const record = await readState(tenantKey);
    return record?.state || {};
  }

  // requirePermission(key): the general-purpose authorization middleware. Attaches
  // req.callerState/req.caller so the route handler doesn't have to re-fetch state itself.
  function requirePermission(permKey) {
    return async (req, res, next) => {
      try {
        const state = await loadCallerState(req);
        if (!hasPermission(state, req.session, permKey)) {
          return res.status(403).json({ error: 'You do not have permission to perform this action.' });
        }
        req.callerState = state;
        req.caller = resolveCaller(state, req.session);
        next();
      } catch (error) {
        res.status(500).json({ error: 'Unable to verify permissions.', detail: error.message });
      }
    };
  }

  // requireTenantAdmin: for endpoints that should stay admin-only regardless of any specific
  // granted permission key (e.g. full-state writes) -- role==='admin'/'platform' or Super Admin.
  function requireTenantAdmin(req, res, next) {
    loadCallerState(req).then(state => {
      const caller = resolveCaller(state, req.session);
      if (!isAdminCaller(req.session, caller)) return res.status(403).json({ error: 'Administrator access required.' });
      req.callerState = state;
      req.caller = caller;
      next();
    }).catch(error => res.status(500).json({ error: 'Unable to verify permissions.', detail: error.message }));
  }

  function canAccessEmployee(state, session, targetEmployeeId) {
    const caller = resolveCaller(state, session);
    if (isAdminCaller(session, caller)) return true;
    return !!(caller && caller.id === targetEmployeeId);
  }

  // "Can this caller see this employee's payroll data" -- either they ARE that employee (and
  // hold the self-service permission that already gates My Payslips client-side), or they're an
  // admin. There is deliberately no "manager can see direct reports' payroll" branch here yet --
  // that's not something any existing client-side view exposes today either, so nothing regresses.
  function canAccessPayroll(state, session, targetEmployeeId) {
    const caller = resolveCaller(state, session);
    if (isAdminCaller(session, caller)) return true;
    return !!(caller && caller.id === targetEmployeeId && hasPermission(state, session, 'myslips'));
  }

  function canManageZkDevices(state, session) { return hasPermission(state, session, 'zksetup'); }
  function canCommandZkDevices(state, session) { return hasPermission(state, session, 'zkcommand'); }

  return {
    requirePermission, requireTenantAdmin, loadCallerState,
    canAccessEmployee, canAccessPayroll, canManageZkDevices, canCommandZkDevices,
    hasPermission, resolveCaller, isAdminCaller, getAuthenticatedUser
  };
}

module.exports = { createAuthorization, hasPermission, resolveCaller, isAdminCaller, getAuthenticatedUser };
