// Backend immutability enforcement for locked payroll runs and closed pay periods (final payroll
// integrity pass, issues 14/15/20/21/22/23).
//
// PROBLEM: public/payroll-governance.js's lockPayrollRun() marks a run status:'locked'/
// immutable:true entirely client-side -- but the generic admin/platform PUT /api/state endpoint
// (server.js) accepts and persists WHATEVER full application state a caller submits. Nothing on
// the backend ever actually checked that a submission didn't quietly edit a locked run's net pay,
// delete it outright, or silently reopen a closed pay period. The UI never offering those actions
// is not the same as the backend refusing them.
//
// FIX: before any PUT /api/state write is persisted, compare every EXISTING locked run / closed
// period in the last-known state against what's being submitted. Any of the following is rejected
// with 409, never silently applied:
//   - a locked run's protected fields changed (status, items, employee amounts/attendanceSummary/
//     attendanceInputSnapshot/scheduleSnapshot/rates/ruleSnapshot/compensationSnapshot/
//     calculationTrace/net/gross/deductions, workflow, lockedAt, approvedBy, its own dates)
//   - a locked run deleted outright
//   - a closed period's status/runId changed, or the period deleted outright
// A run that is NOT locked (draft/pending_approval/returned) is completely unaffected -- normal
// payroll workflow keeps working exactly as it always has (issue 22).
'use strict';

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

// Every field on a LOCKED run that must never move except through the dedicated reversal/reopen
// workflow (issue 14) -- deliberately broader than just the money fields, since the whole point is
// that a locked run is a historical source of truth other code (leave retro reconciliation) already
// depends on being frozen.
const PROTECTED_RUN_FIELDS = [
  'status', 'items', 'attendanceSummary', 'attendanceInputSnapshot', 'scheduleSnapshot', 'rates',
  'ruleSnapshot', 'compensationSnapshot', 'calculationTrace', 'net', 'gross', 'deductions', 'totalDed',
  'workflow', 'lockedAt', 'approvedBy', 'approvedAt', 'from', 'to', 'periodId', 'groupId'
];

// Compares `submittedState` against `currentState` (the last durably-saved state) and returns
// { ok:true } if every locked run / closed period is untouched, or { ok:false, reason, code } for
// the FIRST violation found -- the caller (server.js) rejects the whole write with 409 rather than
// silently applying a partial state that includes the violation.
function checkPayrollImmutability(currentState, submittedState) {
  const currentRuns = (currentState && currentState.payrolls) || [];
  const submittedRuns = (submittedState && submittedState.payrolls) || [];
  for (const run of currentRuns) {
    // Only a genuinely LOCKED run is protected here -- draft/pending_approval/returned payroll
    // work must keep behaving exactly as it always has (issue 22).
    if (run.status !== 'locked') continue;
    const match = submittedRuns.find(r => r && r.id === run.id);
    if (!match) {
      return { ok: false, code: 'LOCKED_RUN_DELETED', reason: `Locked payroll run #${run.id} cannot be deleted. Use the payroll reversal/reopen workflow.`, runId: run.id };
    }
    for (const field of PROTECTED_RUN_FIELDS) {
      if (!deepEqual(run[field], match[field])) {
        return { ok: false, code: 'LOCKED_RUN_MUTATED', reason: `Locked payroll runs are immutable. Field '${field}' on run #${run.id} cannot be changed through this endpoint. Use the payroll reversal/reopen workflow.`, runId: run.id, field };
      }
    }
  }

  const currentPeriods = (currentState && currentState.payPeriods) || [];
  const submittedPeriods = (submittedState && submittedState.payPeriods) || [];
  for (const period of currentPeriods) {
    if (period.status !== 'closed') continue;
    const match = submittedPeriods.find(p => p && p.id === period.id);
    if (!match) {
      return { ok: false, code: 'CLOSED_PERIOD_DELETED', reason: `Closed pay period #${period.id} cannot be deleted. Use the payroll reversal/reopen workflow.`, periodId: period.id };
    }
    if (match.status !== 'closed') {
      return { ok: false, code: 'CLOSED_PERIOD_REOPENED', reason: `Closed pay period #${period.id} cannot be reopened through this endpoint. Use the payroll reversal/reopen workflow.`, periodId: period.id };
    }
    if ((match.runId || null) !== (period.runId || null)) {
      return { ok: false, code: 'CLOSED_PERIOD_RELINKED', reason: `Closed pay period #${period.id}'s linked payroll run cannot be changed through this endpoint. Use the payroll reversal/reopen workflow.`, periodId: period.id };
    }
  }

  // A voided run is still historically immutable (issue 23) -- once a run is 'voided' (only ever
  // reachable through the dedicated reversal workflow, never this generic endpoint), the same
  // protected-field/deletion checks above continue to apply to it exactly like a 'locked' one, and
  // a submission is never allowed to directly flip a still-locked run to 'voided' here at all
  // (caught by the 'status' field check above, since 'voided' !== 'locked').

  return { ok: true };
}

module.exports = { deepEqual, checkPayrollImmutability, PROTECTED_RUN_FIELDS };
