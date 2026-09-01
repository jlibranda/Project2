// Backend immutability + lifecycle-transition enforcement for payroll runs and pay periods.
//
// PROBLEM (original pass): public/payroll-governance.js's lockPayrollRun() marks a run
// status:'locked'/immutable:true entirely client-side -- but the generic admin/platform
// PUT /api/state endpoint (server.js) accepts and persists WHATEVER full application state a
// caller submits. The first version of this module only protected a run that was ALREADY locked
// in the last-known state (`if (run.status !== 'locked') continue;`) -- which correctly blocked
// editing an already-locked run, but left two real gaps:
//   (a) a run that is CURRENTLY pending_approval/returned/draft could be submitted with
//       status:'locked' (plus forged lockedAt/approvedBy/approvalStage) and the check would never
//       even look at it, since the loop skipped every non-'locked' CURRENT run entirely --
//       bypassing the entire maker/checker/approver workflow in one PUT.
//   (b) a run that is CURRENTLY 'voided' was likewise skipped entirely (the loop only ever
//       protected 'locked'), even though the code's own comment claimed voided runs were "protected
//       ... exactly like a locked one" -- they were not.
//
// FIX: every payroll lifecycle status that represents a FINALIZED, historically-immutable run
// (FINALIZED_RUN_STATUSES below) is fully protected -- not just 'locked'. And a run that is NOT
// currently finalized is now also checked for an unauthorized TRANSITION straight into a finalized
// status, or between two different finalized statuses (locked<->voided), which generic
// /api/state must never be allowed to perform on its own. The same two-sided check applies to a
// pay period's 'closed' status. This module intentionally does not implement the actual lock/void/
// reopen workflow -- it only draws the boundary generic /api/state may never cross; the real
// workflow stays exactly where it already lives (public/payroll-governance.js's client-side
// maker/checker/approver flow), which still autosaves through this same endpoint for every
// non-lifecycle-crossing edit (ordinary item/adjustment edits, single-stage approvals that don't
// yet reach the final stage, etc).
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

// The actual payroll-run lifecycle statuses this codebase uses (public/payroll-governance.js):
// 'pending_approval' (maker submitted, awaiting maker/checker/approver stages) -> 'locked'
// (approved through every stage, immutable) or 'returned' (rejected back to the maker) or
// 'superseded' (replaced by a fresh submission before it ever locked); a 'locked' run can later
// become 'voided' (payroll-governance.js's reopenClosedPayPeriod, the only place that transition
// exists today) when its pay period is reopened. 'locked' and 'voided' are the only two statuses
// that represent a FINALIZED, historically-immutable result -- 'returned'/'superseded' are dead
// ends for that specific run object but were never a source of truth anything else depends on, so
// they don't need protecting the same way. No 'posted'/'released' status is ever set on a
// state.payrolls[] run in this codebase (a similarly-named 'released' status exists only on the
// unrelated state.finalPayList[] records, out of scope for this module).
const FINALIZED_RUN_STATUSES = new Set(['locked', 'voided']);
function isFinalizedPayrollRun(run) { return !!run && FINALIZED_RUN_STATUSES.has(run.status); }
// Alias: "protected" and "finalized" are the same concept for a payroll run today -- kept as a
// separate name since the two questions ("is this run done?" vs "must this run's fields never
// move?") are conceptually distinct even though they currently have the same answer.
function isProtectedPayrollRun(run) { return isFinalizedPayrollRun(run); }

// Every field on a FINALIZED (locked or voided) run that must never move except through the
// dedicated reversal/reopen workflow -- deliberately broader than just the money fields, since the
// whole point is that a finalized run is a historical source of truth other code (leave retro
// reconciliation) already depends on being frozen.
const PROTECTED_RUN_FIELDS = [
  'status', 'items', 'attendanceSummary', 'attendanceInputSnapshot', 'scheduleSnapshot', 'rates',
  'ruleSnapshot', 'compensationSnapshot', 'calculationTrace', 'net', 'gross', 'deductions', 'totalDed',
  'workflow', 'lockedAt', 'approvedBy', 'approvedAt', 'from', 'to', 'periodId', 'groupId'
];

// Server-controlled lifecycle fields on a run that is NOT (yet) finalized -- these are only ever
// set together, all at once, by the real lockPayrollRun() workflow. A submission that introduces
// any of these on a still-pending run (without the run's own status actually becoming finalized,
// which is caught separately below) is exactly the "forge the approval paperwork but leave status
// alone so my earlier check doesn't fire" attempt issue 1G describes.
const LOCK_ONLY_RUN_FIELDS = ['lockedAt', 'approvedBy', 'approvedAt', 'immutable'];

// Compares `submittedState` against `currentState` (the last durably-saved state) and returns
// { ok:true } if every payroll-lifecycle boundary is respected, or { ok:false, reason, code } for
// the FIRST violation found -- the caller (server.js) rejects the whole write with 409 rather than
// silently applying a partial state that includes the violation.
function checkPayrollImmutability(currentState, submittedState) {
  const currentRuns = (currentState && currentState.payrolls) || [];
  const submittedRuns = (submittedState && submittedState.payrolls) || [];
  for (const run of currentRuns) {
    const match = submittedRuns.find(r => r && r.id === run.id);

    if (isFinalizedPayrollRun(run)) {
      // Already locked or voided -- fully protected: cannot be deleted, and none of its protected
      // fields (including its own status, e.g. locked->voided or voided->locked) may move.
      if (!match) {
        return { ok: false, code: 'LOCKED_RUN_DELETED', reason: `Payroll run #${run.id} (${run.status}) cannot be deleted. Use the payroll reversal/reopen workflow.`, runId: run.id };
      }
      for (const field of PROTECTED_RUN_FIELDS) {
        if (!deepEqual(run[field], match[field])) {
          return { ok: false, code: 'LOCKED_RUN_MUTATED', reason: `Finalized (${run.status}) payroll runs are immutable. Field '${field}' on run #${run.id} cannot be changed through this endpoint. Use the payroll reversal/reopen workflow.`, runId: run.id, field };
        }
      }
      continue;
    }

    // NOT currently finalized (draft/pending_approval/returned/superseded) -- ordinary payroll
    // work (item edits, adjustment attachment, single-stage approvals) must keep behaving exactly
    // as it always has. But the submission must not use this same freedom to jump straight into a
    // finalized status, skipping the maker/checker/approver workflow entirely (issue 1/1B).
    if (match && isFinalizedPayrollRun(match)) {
      return {
        ok: false, code: 'PAYROLL_STATUS_TRANSITION_BLOCKED',
        reason: 'Payroll lifecycle transitions must use the server-authoritative payroll workflow.', runId: run.id
      };
    }
    if (match) {
      // Approval stage may only ever advance by exactly one step per submission -- a normal single
      // approvePayroll() call increments it by 1. A larger jump would let the run silently skip
      // straight to auto-lock on the very NEXT legitimate approval call (approvePayroll treats an
      // approvalStage past the end of the configured workflow as "fully approved, lock now"),
      // which is the exact "forge approvalStage:999, leave status alone" variant of issue 1's
      // exploit that the status-only check above can't see by itself (issue 1G).
      const currentStage = Number(run.approvalStage) || 0;
      const submittedStage = Number(match.approvalStage) || 0;
      if (submittedStage > currentStage + 1) {
        return {
          ok: false, code: 'PAYROLL_APPROVAL_STAGE_SKIPPED',
          reason: 'Payroll approval stage cannot advance by more than one step through this endpoint. Use the server-authoritative payroll workflow.', runId: run.id
        };
      }
      // lockedAt/approvedBy/approvedAt/immutable are only ever set together, at the moment a run
      // actually becomes 'locked' -- introducing any of them while status stays non-finalized is
      // never a legitimate ordinary edit.
      for (const field of LOCK_ONLY_RUN_FIELDS) {
        if (!run[field] && match[field]) {
          return {
            ok: false, code: 'PAYROLL_LIFECYCLE_FIELD_FORGED',
            reason: `Field '${field}' on run #${run.id} is server-authoritative and cannot be set through this endpoint outside the normal approval workflow.`, runId: run.id, field
          };
        }
      }
    }
  }

  const currentPeriods = (currentState && currentState.payPeriods) || [];
  const submittedPeriods = (submittedState && submittedState.payPeriods) || [];
  for (const period of currentPeriods) {
    const match = submittedPeriods.find(p => p && p.id === period.id);
    if (period.status === 'closed') {
      if (!match) {
        return { ok: false, code: 'CLOSED_PERIOD_DELETED', reason: `Closed pay period #${period.id} cannot be deleted. Use the payroll reversal/reopen workflow.`, periodId: period.id };
      }
      if (match.status !== 'closed') {
        return { ok: false, code: 'CLOSED_PERIOD_REOPENED', reason: `Closed pay period #${period.id} cannot be reopened through this endpoint. Use the payroll reversal/reopen workflow.`, periodId: period.id };
      }
      if ((match.runId || null) !== (period.runId || null)) {
        return { ok: false, code: 'CLOSED_PERIOD_RELINKED', reason: `Closed pay period #${period.id}'s linked payroll run cannot be changed through this endpoint. Use the payroll reversal/reopen workflow.`, periodId: period.id };
      }
      continue;
    }
    // NOT currently closed -- block a submission from directly closing it (issue 1C). Only the
    // server-authoritative payroll locking workflow may close a pay period.
    if (match && match.status === 'closed') {
      return {
        ok: false, code: 'PAY_PERIOD_CLOSE_TRANSITION_BLOCKED',
        reason: 'Only the server-authoritative payroll locking workflow may close a pay period.', periodId: period.id
      };
    }
  }

  return { ok: true };
}

module.exports = {
  deepEqual, checkPayrollImmutability, PROTECTED_RUN_FIELDS, LOCK_ONLY_RUN_FIELDS,
  FINALIZED_RUN_STATUSES, isFinalizedPayrollRun, isProtectedPayrollRun
};
