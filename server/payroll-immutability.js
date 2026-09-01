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
// FIX (that pass): every payroll lifecycle status that represents a FINALIZED, historically-
// immutable run (FINALIZED_RUN_STATUSES below) is fully protected -- not just 'locked'. And a run
// that is NOT currently finalized is checked for an unauthorized TRANSITION straight into a
// finalized status, or between two different finalized statuses (locked<->voided).
//
// THIS pass (server-authoritative payroll lifecycle): dedicated backend endpoints
// (POST /api/payroll-runs/:id/approve, /return, /reopen -- server.js) are now the ONLY legitimate
// way a run's lifecycle actually advances. That closed the "legitimate approval can no longer
// happen at all" regression those endpoints fixed, but it also means generic PUT /api/state must
// now be treated as ENTIRELY read-only for lifecycle fields, not just "can't jump straight to
// locked" -- three more gaps closed here:
//   (c) a BRAND-NEW submitted run with no corresponding CURRENT entry was never inspected at all
//       (the loop below only ever iterated currentState.payrolls) -- an attacker could submit a
//       wholly fabricated `{id:999999, status:'locked', approvedBy:'Attacker', net:999999}` and it
//       would sail through untouched. Same gap for a brand-new pay period submitted pre-closed.
//   (d) the one-step "approvalStage may advance by exactly +1" compatibility carve-out this module
//       used to grant generic PUT (so the OLD client-side approvePayroll() could still work) is
//       removed now that the real dedicated endpoint exists to do this properly (segregation-of-
//       duties, required notes, snapshot-completeness gating, atomic lock) -- ANY approvalStage
//       change through generic PUT is now rejected, full stop.
//   (e) the run's `workflow` history array itself was never protected for a still-pending run (only
//       once already finalized) -- a submission could silently rewrite/drop/relabel an earlier
//       reviewer's entry without ever touching status or approvalStage. Now protected for every run
//       once it exists, the same way LIFECYCLE_ONLY_RUN_FIELDS already is.
// A transition straight into 'returned' (the dedicated POST /api/payroll-runs/:id/return's own
// job) is blocked the same way a transition into a finalized status already was.
//
// This module intentionally does not implement the actual approve/reject/reopen workflow itself --
// it only draws the boundary generic /api/state may never cross; the real workflow lives in the
// dedicated endpoints in server.js. Ordinary in-flight payroll work (item edits, adjustment
// attachment, a still-draft run's own non-lifecycle fields) continues to autosave through this same
// endpoint exactly as before.
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
// become 'voided' (the dedicated POST /api/payroll-runs/:id/reopen endpoint) when its pay period
// is reopened. 'locked' and 'voided' are the only two statuses that represent a FINALIZED,
// historically-immutable result -- 'returned'/'superseded' are dead ends for that specific run
// object but were never a source of truth anything else depends on, so they don't need protecting
// the same permanent way (they're still guarded against being reached BY FORGERY -- see
// LIFECYCLE_TRANSITION_BLOCKED_STATUSES below -- just not frozen forever afterward).
const FINALIZED_RUN_STATUSES = new Set(['locked', 'voided']);
function isFinalizedPayrollRun(run) { return !!run && FINALIZED_RUN_STATUSES.has(run.status); }
// Alias: "protected" and "finalized" are the same concept for a payroll run today -- kept as a
// separate name since the two questions ("is this run done?" vs "must this run's fields never
// move?") are conceptually distinct even though they currently have the same answer.
function isProtectedPayrollRun(run) { return isFinalizedPayrollRun(run); }

// Statuses a submitted run may never be forged INTO through generic PUT -- each one now has its
// own dedicated, server-authoritative endpoint (approve -> locked, return -> returned,
// reopen -> voided) that alone may perform the transition.
const LIFECYCLE_TRANSITION_BLOCKED_STATUSES = new Set(['locked', 'voided', 'returned']);

// Every field on a FINALIZED (locked or voided) run that must never move except through the
// dedicated reversal/reopen workflow -- deliberately broader than just the money fields, since the
// whole point is that a finalized run is a historical source of truth other code (leave retro
// reconciliation) already depends on being frozen.
const PROTECTED_RUN_FIELDS = [
  'status', 'items', 'attendanceSummary', 'attendanceInputSnapshot', 'scheduleSnapshot', 'rates',
  'ruleSnapshot', 'compensationSnapshot', 'calculationTrace', 'net', 'gross', 'deductions', 'totalDed',
  'workflow', 'lockedAt', 'approvedBy', 'approvedAt', 'from', 'to', 'periodId', 'groupId'
];

// Server-controlled lifecycle fields on a run -- these are only ever set by a dedicated endpoint
// (POST /api/payroll-runs/:id/approve|return|reopen), never by generic PUT /api/state, regardless
// of whether the run is currently finalized. A submission that introduces any of these on a run
// that doesn't already carry them (without the run's own status actually transitioning, which is
// caught separately above) is exactly the "forge the approval/rejection/void paperwork but leave
// status alone so the transition-check above doesn't fire" attempt this exists to catch.
const LIFECYCLE_ONLY_RUN_FIELDS = [
  'lockedAt', 'approvedBy', 'approvedAt', 'immutable',
  'rejectedBy', 'rejectedAt', 'returnReason',
  'voidedBy', 'voidedAt', 'voidReason'
];
// Kept as an alias of the (now broader) set above for anything still importing the old name.
const LOCK_ONLY_RUN_FIELDS = LIFECYCLE_ONLY_RUN_FIELDS;

// Compares `submittedState` against `currentState` (the last durably-saved state) and returns
// { ok:true } if every payroll-lifecycle boundary is respected, or { ok:false, reason, code } for
// the FIRST violation found -- the caller (server.js) rejects the whole write with 409 rather than
// silently applying a partial state that includes the violation.
function checkPayrollImmutability(currentState, submittedState) {
  const currentRuns = (currentState && currentState.payrolls) || [];
  const submittedRuns = (submittedState && submittedState.payrolls) || [];
  const currentRunIds = new Set(currentRuns.map(r => r && r.id));

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
    // work (item edits, adjustment attachment) must keep behaving exactly as it always has. But
    // the submission must not use this same freedom to jump straight into a status that a
    // dedicated endpoint alone may set (locked/voided/returned), skipping the real workflow
    // entirely.
    if (match && run.status !== match.status && LIFECYCLE_TRANSITION_BLOCKED_STATUSES.has(match.status)) {
      return {
        ok: false,
        code: isFinalizedPayrollRun(match) ? 'PAYROLL_STATUS_TRANSITION_BLOCKED' : 'PAYROLL_RETURN_TRANSITION_BLOCKED',
        reason: 'Payroll lifecycle transitions must use the server-authoritative payroll workflow.', runId: run.id
      };
    }
    if (match) {
      // The workflow history is exclusively server-written (the dedicated approve/return/reopen
      // endpoints) -- a still-pending run's workflow array can never move through this generic
      // endpoint, whether by adding, removing, or editing an entry, even without ever touching
      // approvalStage/status themselves.
      if (!deepEqual(run.workflow || [], match.workflow || [])) {
        return {
          ok: false, code: 'PAYROLL_WORKFLOW_FORGERY_BLOCKED',
          reason: `Payroll workflow history for run #${run.id} is server-authoritative and can only change through the dedicated payroll approval workflow.`, runId: run.id
        };
      }
      // approvalStage now ONLY ever advances through the dedicated approval endpoint -- the
      // one-step "compatibility" allowance this module used to grant generic PUT is removed now
      // that a real server-authoritative endpoint exists to do this properly (segregation-of-
      // duties, required notes, snapshot-completeness gating, atomic lock -- none of which this
      // generic endpoint can enforce). ANY change, in either direction, is rejected.
      const currentStage = Number(run.approvalStage) || 0;
      const submittedStage = Number(match.approvalStage) || 0;
      if (submittedStage !== currentStage) {
        return {
          ok: false, code: 'PAYROLL_APPROVAL_STAGE_CHANGE_BLOCKED',
          reason: `Payroll approval stage for run #${run.id} can only change through the dedicated server-authoritative approval endpoint.`, runId: run.id
        };
      }
      // lockedAt/approvedBy/approvedAt/immutable/rejected*/voided* are only ever set by a
      // dedicated endpoint, at the moment a run actually transitions -- introducing any of them
      // without that transition (caught above) is never a legitimate ordinary edit.
      for (const field of LIFECYCLE_ONLY_RUN_FIELDS) {
        if (!run[field] && match[field]) {
          return {
            ok: false, code: 'PAYROLL_LIFECYCLE_FIELD_FORGED',
            reason: `Field '${field}' on run #${run.id} is server-authoritative and cannot be set through this endpoint outside the dedicated payroll workflow.`, runId: run.id, field
          };
        }
      }
    }
  }

  // A brand-new submitted run with NO corresponding current entry was never inspected by the loop
  // above -- block one whose status is already a dedicated-endpoint-only status; only a genuinely
  // fresh, non-finalized submission (e.g. a maker's own 'pending_approval' run) may be created
  // directly through this endpoint.
  const seenNewRunIds = new Set();
  for (const run of submittedRuns) {
    if (!run || currentRunIds.has(run.id)) continue;
    if (seenNewRunIds.has(run.id)) {
      return { ok: false, code: 'DUPLICATE_PAYROLL_RUN_ID', reason: `Two submitted payroll runs share id #${run.id}.`, runId: run.id };
    }
    seenNewRunIds.add(run.id);
    if (LIFECYCLE_TRANSITION_BLOCKED_STATUSES.has(run.status)) {
      return {
        ok: false, code: 'NEW_FINALIZED_PAYROLL_BLOCKED',
        reason: `A new payroll run cannot be created directly with status '${run.status}'. Use the server-authoritative payroll workflow.`, runId: run.id
      };
    }
  }

  const currentPeriods = (currentState && currentState.payPeriods) || [];
  const submittedPeriods = (submittedState && submittedState.payPeriods) || [];
  const currentPeriodIds = new Set(currentPeriods.map(p => p && p.id));
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
    // NOT currently closed -- block a submission from directly closing it. Only the
    // server-authoritative payroll locking workflow may close a pay period.
    if (match && match.status === 'closed') {
      return {
        ok: false, code: 'PAY_PERIOD_CLOSE_TRANSITION_BLOCKED',
        reason: 'Only the server-authoritative payroll locking workflow may close a pay period.', periodId: period.id
      };
    }
  }
  // Same brand-new-entry gap as runs above: a period submitted pre-closed with no current
  // counterpart was never inspected at all.
  for (const period of submittedPeriods) {
    if (!period || currentPeriodIds.has(period.id)) continue;
    if (period.status === 'closed') {
      return {
        ok: false, code: 'NEW_CLOSED_PAY_PERIOD_BLOCKED',
        reason: `A new pay period cannot be created directly with status 'closed'. Use the server-authoritative payroll workflow.`, periodId: period.id
      };
    }
  }

  return { ok: true };
}

module.exports = {
  deepEqual, checkPayrollImmutability, PROTECTED_RUN_FIELDS, LOCK_ONLY_RUN_FIELDS, LIFECYCLE_ONLY_RUN_FIELDS,
  LIFECYCLE_TRANSITION_BLOCKED_STATUSES, FINALIZED_RUN_STATUSES, isFinalizedPayrollRun, isProtectedPayrollRun
};
