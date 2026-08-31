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
// submitted payload contains.
//
// First pass (commit #305) stopped there: an employee could still set arbitrary VALUES on a
// record that genuinely was their own, including authoritative fields like approval status,
// reviewer identity, or approval-chain position -- an employee could flip their own pending leave
// straight to 'approved' by editing their local copy before the debounced autosave fired. Each
// sanitizeEmployee*Record function below closes that: it explicitly allowlists only the fields a
// real employee-facing form actually lets someone set, ported from the exact client-side filing
// code (submitLeave/CHANGE_REQUESTS.push/markStep in public/index.html) rather than guessed at.
// For a genuinely NEW record it returns a fresh object with server-assigned safe defaults
// (status:'pending', no approval metadata at all); for an EXISTING record it starts from what's
// already persisted and copies over only the one or two fields that record type's real UI lets an
// employee change post-filing (e.g. cancelling a still-pending leave request). Returning null
// rejects the record entirely (used where no legitimate employee-authored create/edit path exists
// today at all) rather than silently keeping something that shouldn't be there.
//
// Approval itself (moving a record OFF pending) no longer goes through this overlay at all --
// see POST /api/leaves/:id/decision and POST /api/attendance/:id/decision in server.js, which are
// now the only way any of those fields change.
//
// Not overlaid in this pass (stays byte-identical to the current record for an employee session):
// - users[] -- self-profile-edit is not migrated yet (see the caller's own comment/report); doing
//   this by field-allowlist without first confirming exactly which fields the self-edit UI
//   actually writes risked silently corrupting another employee's record if guessed wrong.
// - payroll*/company/org/lookups/accessLevels/enterprise.resolutionCases (other people's)/etc. --
//   none of these are things a plain self-service action legitimately creates or edits.
// - bundyLogs -- written through the dedicated /api/bundy/punch endpoint already.

// Leave: submitLeave() is the only employee-authored creation path; cancelLeaveRequest() is the
// only employee-authored edit of an existing record (pending -> cancelled, nothing else).
function sanitizeEmployeeLeaveRecord(existing, incoming, isNew, meId, todayStr) {
  if (isNew) {
    if (!incoming || typeof incoming !== 'object') return null;
    return {
      id: incoming.id, eid: meId,
      type: incoming.type, s: incoming.s, e: incoming.e, reason: incoming.reason,
      days: incoming.days, paidDays: incoming.paidDays, unpaidDays: incoming.unpaidDays,
      dayType: incoming.dayType, halfDayLabel: incoming.halfDayLabel,
      status: 'pending', filed: todayStr, approvalLayer: 1
      // No approvalHistory/reviewedBy/reviewedAt -- those don't exist until a decision is made.
    };
  }
  const next = { ...existing };
  if (existing.status === 'pending' && incoming && incoming.status === 'cancelled') next.status = 'cancelled';
  return next;
}

// Attendance: no employee-authored creation or edit path exists anywhere in the client -- ATT
// records come from ZK devices, Web Bundy, admin filing, leave approval, or attendance-policy
// derivation only. Every employee-owned attendance record is therefore fully protected; nothing
// in an employee's submitted payload can change it. Corrections go through the Resolution Center
// (a change request/case, reviewed by an admin), not a direct attendance edit.
function sanitizeEmployeeAttendanceRecord(existing, incoming, isNew) {
  if (isNew) return null;
  return { ...existing };
}

// Loans: no employee-authored creation path exists yet either -- LOANS.push only happens from an
// admin-only "Add Loan" modal today. loans_apply/loans_approve permissions exist in PERM_DEFS but
// nothing wires them to a client action currently, so this stays fully protected until a real
// self-service loan-application flow ships (at which point this function is where to add it).
function sanitizeEmployeeLoanRecord(existing, incoming, isNew) {
  if (isNew) return null;
  return { ...existing };
}

// Change requests (profile-change proposals, distinct from Resolution Center cases): `changes`
// is the only employee-authored field at creation; status/reviewedBy/reviewedOn/rejectReason are
// admin-only, set when an admin reviews it through their own unrestricted state write.
function sanitizeEmployeeChangeRequest(existing, incoming, isNew, meId, todayStr) {
  if (isNew) {
    if (!incoming || typeof incoming !== 'object') return null;
    return { id: incoming.id, eid: meId, changes: incoming.changes, status: 'pending', submitted: todayStr, reviewedBy: '', reviewedOn: '', rejectReason: '' };
  }
  return { ...existing };
}

// Onboarding: records are admin-created only; the sole employee-facing mutation is marking one of
// their own checklist steps done (markStep()) -- nothing else on the record is employee-editable,
// and a step already marked done can't be un-marked by the employee either (only true is honored).
function sanitizeEmployeeOnboardingRecord(existing, incoming, isNew) {
  if (isNew) return null;
  if (!incoming || !Array.isArray(existing.steps) || !Array.isArray(incoming.steps)) return { ...existing };
  const steps = existing.steps.map((s, i) => (incoming.steps[i] && incoming.steps[i].done === true) ? { ...s, done: true } : s);
  return { ...existing, steps };
}

// Applies `sanitize` to each of the caller's own incoming records (matched by id against their
// own existing records to decide isNew), keeps every other employee's records from `previousArr`
// completely untouched, and preserves any of the caller's own existing records that the incoming
// payload simply didn't include (a stale/partial local snapshot should never look like a delete).
// Guards against a client-assigned id on a "new" record colliding with a different employee's
// existing record by reassigning it a fresh id rather than leaving that ambiguous.
function overlaySanitizedOwnRecords(previousArr, incomingArr, meId, idKey, sanitize, todayStr) {
  const previous = Array.isArray(previousArr) ? previousArr : [];
  const incoming = Array.isArray(incomingArr) ? incomingArr : [];
  const othersPrevious = previous.filter(r => !(r && r[idKey] === meId));
  const previousOwnById = new Map(previous.filter(r => r && r[idKey] === meId).map(r => [r.id, r]));
  const incomingOwn = incoming.filter(r => r && r[idKey] === meId);

  const seenIds = new Set();
  const othersIds = new Set(othersPrevious.map(r => r && r.id));
  let nextId = [...previous, ...incoming].reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;

  const sanitizedOwn = [];
  incomingOwn.forEach(r => {
    const existing = previousOwnById.get(r.id);
    const result = sanitize(existing, r, !existing, meId, todayStr);
    if (!result || result.id == null || seenIds.has(result.id)) return;
    if (othersIds.has(result.id)) result.id = nextId++;
    seenIds.add(result.id);
    sanitizedOwn.push(result);
  });
  // Any of the employee's own existing records the incoming payload didn't mention at all are
  // preserved as-is rather than silently dropped.
  previousOwnById.forEach((existing, id) => { if (!seenIds.has(id)) sanitizedOwn.push(existing); });

  return [...othersPrevious, ...sanitizedOwn];
}

// Returns the safe state to persist, or null if the caller can't be resolved to an employee
// record at all (in which case the route should reject the write outright).
function applyEmployeeStateOverlay(previousState, incomingState, session) {
  const users = previousState.users || [];
  const me = users.find(u => String(u.email || '').toLowerCase() === String(session.sub || '').toLowerCase());
  if (!me) return null;
  const meId = me.id;
  const todayStr = new Date().toISOString().slice(0, 10);
  const next = JSON.parse(JSON.stringify(previousState || {}));
  next.leaves = overlaySanitizedOwnRecords(previousState.leaves, incomingState?.leaves, meId, 'eid', sanitizeEmployeeLeaveRecord, todayStr);
  next.attendance = overlaySanitizedOwnRecords(previousState.attendance, incomingState?.attendance, meId, 'eid', sanitizeEmployeeAttendanceRecord, todayStr);
  next.changeRequests = overlaySanitizedOwnRecords(previousState.changeRequests, incomingState?.changeRequests, meId, 'eid', sanitizeEmployeeChangeRequest, todayStr);
  next.onboarding = overlaySanitizedOwnRecords(previousState.onboarding, incomingState?.onboarding, meId, 'eid', sanitizeEmployeeOnboardingRecord, todayStr);
  if (hasPermission(previousState, session, 'loans_apply')) {
    next.loans = overlaySanitizedOwnRecords(previousState.loans, incomingState?.loans, meId, 'eid', sanitizeEmployeeLoanRecord, todayStr);
  }
  return next;
}

module.exports = {
  buildScopedStateForEmployee, applyEmployeeStateOverlay,
  sanitizeEmployeeLeaveRecord, sanitizeEmployeeAttendanceRecord, sanitizeEmployeeLoanRecord,
  sanitizeEmployeeChangeRequest, sanitizeEmployeeOnboardingRecord
};
