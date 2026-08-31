// Allowlist-based scoped state builder for non-admin (role==='employee') sessions.
//
// GET /api/state and the login/session-restore response used to hand back the ENTIRE tenant
// state to any authenticated session -- every other employee's compensation, government IDs,
// bank details, other people's payroll, the access-level permission grants, everyone's
// attendance/leave history, and (via the shared original-tenant row) the platform's own client
// directory. This module is the fix: it explicitly constructs what a regular employee session is
// allowed to receive, one field/array at a time, rather than cloning everything and deleting the
// sensitive parts (a denylist here would only be as safe as remembering to keep it exhaustive).
//
// Admin/platform sessions still receive the full, unmodified state -- see server.js's call site.
// That's a deliberate, temporary widening documented in the task this shipped under: the existing
// SPA's admin-side modules all assume the full state shape, and rewriting every one of them onto
// narrow per-module endpoints is future work, not this pass.
//
// Some slices below are broadened beyond "only my own records" for an employee-role account that
// holds a specific elevated permission (att_edit, leave_approve, resolution, etc.) -- these mirror
// permissions that ALREADY gate the equivalent admin-side view client-side (Pending Approval,
// Resolution Center's shared queue, etc.), so a manager/HR-staff account who isn't role==='admin'
// keeps working exactly as it does today instead of silently losing access.
const { hasPermission } = require('./authorization');

const SELF_ONLY_USER_FIELDS_EXCLUDED = new Set(['pass']);

// Fields visible for EVERY user in the directory, including people who are not the caller.
// Deliberately excludes: compensation (salaryPM/rate/salaryPA), government IDs (sss/ph/pi/tin),
// bank details (bank/bankAccount), personal contact/address (contact/contact2/personalEmail/
// permanentAddress/temporaryAddress/city/zipCode), personal details (bday/gender/maritalStatus/
// spouseName/religion), termination detail beyond the active flag, custom FIELD_CONFIG fields
// (unknown shape, could hold anything), leave balances, and biometric device IDs.
const DIRECTORY_FIELDS = [
  'id', 'eid', 'name', 'firstName', 'lastName', 'middleName', 'suffix', 'email',
  'dept', 'pos', 'bu', 'team', 'subteam', 'discipline', 'pod',
  'managerId', 'managerFirst', 'managerLast', 'immediateHeadEid', 'functionalHead',
  'accessLevelId', 'role', 'active', 'type', 'hired', 'shiftId', 'payGroupId', 'scheduleType',
  'currency', 'entityName'
];

function projectDirectoryUser(u) {
  const out = {};
  DIRECTORY_FIELDS.forEach(k => { if (k in u) out[k] = u[k]; });
  return out;
}

function projectSelfUser(u) {
  const out = {};
  Object.keys(u).forEach(k => { if (!SELF_ONLY_USER_FIELDS_EXCLUDED.has(k)) out[k] = u[k]; });
  return out;
}

function projectUsers(users, me) {
  return (users || []).map(u => (me && u.id === me.id) ? projectSelfUser(u) : projectDirectoryUser(u));
}

function buildScopedStateForEmployee(state, session) {
  const users = state.users || [];
  const me = users.find(u => String(u.email || '').toLowerCase() === String(session.sub || '').toLowerCase()) || null;
  const meId = me ? me.id : null;

  const has = key => hasPermission(state, session, key);
  const ownOnly = (arr, idKey) => (arr || []).filter(r => r && r[idKey] === meId);

  const canSeeAllAttendance = has('att_edit');
  const canSeeAllLeaves = has('leave_approve');
  const canSeeAllChangeRequests = has('resolution');
  const canSeeAllPerformance = has('performance');
  const canSeeAllLoans = has('loans');
  const canApplyOwnLoan = has('loans_apply');
  const canSeeAllPayroll = has('payroll');
  const canSeeAllBundy = has('bundyadmin');
  const canSeeZk = has('zksetup');
  const canSeeRecruitment = has('recruitment');

  return {
    schemaVersion: state.schemaVersion,
    // Organizational structure/config: company-wide, not any one employee's confidential data,
    // and needed broadly to render self-service UI (dropdowns, dept/manager display, policy
    // text, leave-type list, filters). Passed through unchanged.
    org: state.org || [],
    lookups: state.lookups || {},
    company: state.company || {},
    employeeNumberConfig: state.employeeNumberConfig || {},
    statutoryConfig: state.statutoryConfig || {},
    approvalConfig: state.approvalConfig || {},
    fieldConfig: state.fieldConfig || {},
    incomeTypes: state.incomeTypes || [],
    attendancePolicy: state.attendancePolicy || {},
    // A small fixed config object of adjustment FORMULAS (absent/late/undertime basis+divisor),
    // not per-employee filing records -- company-wide, passed through unchanged like the other
    // policy/config objects above.
    attendanceAdjustments: state.attendanceAdjustments || {},
    overtimeRates: state.overtimeRates || [],
    payrollGroups: state.payrollGroups || [],
    payPeriods: state.payPeriods || [],
    officeZones: state.officeZones || [],
    governmentRates: state.governmentRates || {},
    birTaxVersions: state.birTaxVersions || [],
    // Permission SCHEMA (which grants exist and what each grants), not per-employee data --
    // required for the client's own canAccess()/isAdminUser() checks to work at all, including
    // deciding what to show for THIS session. Passed through unchanged.
    accessLevels: state.accessLevels || [],

    // Per-employee data: self-only unless the caller holds the same permission that already
    // gates the equivalent broader admin-side view for that module.
    users: projectUsers(users, me),
    attendance: canSeeAllAttendance ? (state.attendance || []) : ownOnly(state.attendance, 'eid'),
    leaves: canSeeAllLeaves ? (state.leaves || []) : ownOnly(state.leaves, 'eid'),
    loans: canSeeAllLoans ? (state.loans || []) : (canApplyOwnLoan ? ownOnly(state.loans, 'eid') : []),
    changeRequests: canSeeAllChangeRequests ? (state.changeRequests || []) : ownOnly(state.changeRequests, 'eid'),
    performance: canSeeAllPerformance ? (state.performance || []) : ownOnly(state.performance, 'eid'),
    bundyLogs: canSeeAllBundy ? (state.bundyLogs || []) : ownOnly(state.bundyLogs, 'eid'),
    candidates: canSeeRecruitment ? (state.candidates || []) : [],
    onboarding: ownOnly(state.onboarding, 'eid'),

    // Payroll: my own payslip line items only, never another employee's, unless the caller holds
    // the same broad 'payroll' permission that already gates the Payroll module admin-side.
    payrolls: canSeeAllPayroll ? (state.payrolls || []) : (state.payrolls || [])
      .filter(r => (r.items || []).some(i => i.eid === meId))
      .map(r => ({ ...r, items: (r.items || []).filter(i => i.eid === meId) })),
    payrollAdjustments: canSeeAllPayroll ? (state.payrollAdjustments || []) : ownOnly(state.payrollAdjustments, 'empId'),
    finalPayList: canSeeAllPayroll ? (state.finalPayList || []) : ownOnly(state.finalPayList, 'empId'),
    // Operational/admin-only working state -- never needed for employee self-service.
    payrollDraft: canSeeAllPayroll ? (state.payrollDraft || {}) : {},
    payrollAudit: canSeeAllPayroll ? (state.payrollAudit || []) : [],
    payrollGovernance: canSeeAllPayroll ? (state.payrollGovernance || {}) : {},

    // ZK biometric device/user mapping -- covers every employee's device user id, so it's scoped
    // the same as the ZK setup page itself (zksetup permission).
    zk: canSeeZk ? (state.zk || {}) : { userMapping: {}, realtimeEnabled: false, connectionOverride: {}, punchBuffer: state.zk?.punchBuffer || {} },

    // Talent module data beyond `candidates`/`performance` above.
    enterprise: {
      resolutionCases: canSeeAllChangeRequests ? (state.enterprise?.resolutionCases || []) : ownOnly(state.enterprise?.resolutionCases, 'employeeId'),
      performanceGoals: canSeeAllPerformance ? (state.enterprise?.performanceGoals || []) : ownOnly(state.enterprise?.performanceGoals, 'eid'),
      jobRequisitions: canSeeRecruitment ? (state.enterprise?.jobRequisitions || []) : [],
      // Chat history could contain anything another session asked the assistant, including
      // things surfaced from an admin's own broader context -- never worth the risk for a
      // feature no self-service view actually reads today.
      aiHistory: []
    },

    // Never included for a non-admin session, regardless of permission grants:
    // - securityAudit / audit trail of security-sensitive actions across the whole tenant.
    // - platformClients / the platform's directory of every OTHER tenant company (name, admin
    //   email). No self-service view has any legitimate reason to see this; it's already
    //   fetched by the one legitimate consumer (a platform-role session) via the dedicated,
    //   requirePlatformAdmin-gated GET /api/platform/clients endpoint instead.
    securityAudit: [],
    platformClients: []
  };
}

// ── Write side ──────────────────────────────────────────────────────────────────────────────
// A regular employee session must never be able to replace the full tenant state (that's the
// other half of the vulnerability this module fixes -- see server.js's PUT /api/state). Rather
// than trying to validate/reject an arbitrary submitted state (easy to get subtly wrong, and a
// missed case fails open), this CONSTRUCTS the state to persist: start from the state already on
// record, and overlay only the caller's own records in a small set of self-service arrays. Every
// other array/object -- including every OTHER employee's users[] entry, company config, access
// levels, payroll data -- is copied from the current record untouched, no matter what the
// submitted payload contains. Because GET /api/state already only ever gave this session its own
// attendance/leave/loan/case records to begin with (buildScopedStateForEmployee above), what the
// client's own full-state autosave submits back for those arrays is, in the overwhelming majority
// of cases, already exactly "my own records" -- this just makes that a hard guarantee instead of
// an assumption.
//
// Not overlaid in this pass (stays byte-identical to the current record for an employee session):
// - users[] -- self-profile-edit is not migrated yet (see the caller's own comment/report); doing
//   this by field-allowlist without first confirming exactly which fields the self-edit UI
//   actually writes risked silently corrupting another employee's record if guessed wrong.
// - payroll*/company/org/lookups/accessLevels/enterprise.resolutionCases (other people's)/etc. --
//   none of these are things a plain self-service action legitimately creates or edits.
// - bundyLogs -- written through the dedicated /api/bundy/punch endpoint already.
function overlayOwnRecords(previousArr, incomingArr, meId, idKey) {
  const previous = Array.isArray(previousArr) ? previousArr : [];
  const incoming = Array.isArray(incomingArr) ? incomingArr : [];
  const ownIncoming = incoming.filter(r => r && r[idKey] === meId);
  const othersPrevious = previous.filter(r => !(r && r[idKey] === meId));
  return [...othersPrevious, ...ownIncoming];
}

// Returns the safe state to persist, or null if the caller can't be resolved to an employee
// record at all (in which case the route should reject the write outright).
function applyEmployeeStateOverlay(previousState, incomingState, session) {
  const users = previousState.users || [];
  const me = users.find(u => String(u.email || '').toLowerCase() === String(session.sub || '').toLowerCase());
  if (!me) return null;
  const meId = me.id;
  const next = JSON.parse(JSON.stringify(previousState || {}));
  next.attendance = overlayOwnRecords(previousState.attendance, incomingState?.attendance, meId, 'eid');
  next.leaves = overlayOwnRecords(previousState.leaves, incomingState?.leaves, meId, 'eid');
  if (hasPermission(previousState, session, 'loans_apply')) {
    next.loans = overlayOwnRecords(previousState.loans, incomingState?.loans, meId, 'eid');
  }
  next.changeRequests = overlayOwnRecords(previousState.changeRequests, incomingState?.changeRequests, meId, 'eid');
  next.onboarding = overlayOwnRecords(previousState.onboarding, incomingState?.onboarding, meId, 'eid');
  return next;
}

module.exports = { buildScopedStateForEmployee, applyEmployeeStateOverlay };
