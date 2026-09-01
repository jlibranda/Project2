// Exact locked-payroll reconciliation for leave approved AFTER the affected pay period was
// already locked -- the final, focused Leave/Payroll pass building on PR #311 (half-day-aware
// timekeeping) and PR #312 (explicit paid/unpaid half-day accounting).
//
// PROBLEM THIS REPLACES: the prior closed-period correction (creditLateApprovalDay /
// debitClosedPeriodUnpaidLeave, still exported below for legacy/test/fallback use only) always
// assumed the correct retro amount was `dailyRate × fraction` -- true only when that happens to
// equal the actual difference between what the locked payroll ALREADY paid/deducted and what it
// SHOULD have, once the newly-approved leave is taken into account. Example: a locked payroll
// already deducted exactly the right ₱500 for a missing AM half (via a virtual-absence sweep);
// the old logic would still fabricate a further -₱500 "unpaid leave" adjustment, overcorrecting.
//
// APPROACH: locate the immutable locked payroll run and the employee's own frozen payroll item
// (public/payroll-governance.js's lockPayrollRun never lets these mutate again), reconstruct an
// "original, attendance-only" payroll figure from the item's own frozen attendanceSummary
// aggregate and rates snapshot (both saved verbatim at lock time), reconstruct a "corrected"
// attendance-only figure the exact same way but from a FRESH TimekeepingCore.periodSummary() over
// the *current* state.attendance (which by now carries the final approved leave metadata for the
// touched date(s)) -- everything else (rules, rates, baseBasic) held IDENTICAL between the two so
// only the leave-driven attendance interpretation can move the number. The delta between them,
// less whatever prior leave-retro variance has already been applied against this same run, is the
// exact correction still owed. No second payroll formula engine: both figures are produced by the
// exact same PayrollRuleEngine.calculate() the rest of the product already uses.
'use strict';
const TimekeepingCore = require('../public/timekeeping-core.js');
const PayrollRuleEngine = require('../public/payroll-rule-engine.js');

const SOURCE_TYPE = 'leave_retro_reconciliation';
const METHOD = 'locked_payroll_delta';

// A synthetic, single-day period/group -- only ever used to isolate the attendance-driven lines
// (BASIC/OT/ND/RDH/ABSENT/UNPAID_LEAVE/LATE/UNDERTIME). statutoryFactor/cutoffNumber/tax timing
// are irrelevant here since statutory/tax are deliberately zeroed out in every reconciliation call
// (see isolatedAttendancePayroll's own comment for why).
const ISOLATION_GROUP = { code: 'RECON', freq: 'monthly', taxMethod: 'monthly', statutoryTiming: 'every-cutoff' };
const ISOLATION_PERIOD = { from: '1970-01-01', to: '1970-01-01', cutoff1: true, cutoff2: true };
const ZERO_STATUTORY = () => ({ sssEE: 0, sssER: 0, phEE: 0, phER: 0, piEE: 0, piER: 0 });
const ZERO_TAX = () => 0;

// Locates the pay period covering `date` for this employee's pay group, then the immutable
// locked payroll run it points to, then the employee's own frozen item within that run -- the
// exact chain issue 1 specifies (payGroupId + date + period.attendanceFrom/To + period.runId +
// run.items). Returns { ok:true, period, run, item } on success, or { ok:false, reason, period?,
// run? } as soon as any link in the chain is missing, so the caller always has a concrete,
// specific reason rather than a bare "not found".
function findLockedPayrollContext(state, employee, date) {
  const periods = state.payPeriods || [];
  const period = periods.find(p => p.groupId === employee.payGroupId && (p.attendanceFrom || p.from) <= date && (p.attendanceTo || p.to) >= date);
  if (!period) return { ok: false, reason: 'No pay period covers this date for the employee\'s pay group.' };
  if (period.status !== 'closed') return { ok: false, reason: 'Pay period is not closed.', period };
  // A closed period with no linked run at all is treated exactly like any other missing/broken
  // snapshot -- manual review, never a guessed dailyRate×fraction correction (issues 2/8/36).
  if (!period.runId) return { ok: false, reason: 'Closed period has no linked payroll run.', period };
  const runs = state.payrolls || [];
  const run = runs.find(r => r.id === period.runId);
  if (!run) return { ok: false, reason: 'The period\'s linked payroll run no longer exists.', period };
  // Only a genuinely finalized/posted run is a valid historical source of truth (issues 2/43/44).
  // pending_approval / returned / superseded / voided are all explicitly NOT eligible -- a voided
  // or superseded run's replacement, if any, is reached by the period's OWN runId (updated
  // whenever a replacement is actually locked), never by chasing the old run's own linkage, so no
  // separate "find the replacement" step is needed here.
  if (run.status !== 'locked') return { ok: false, reason: `Linked payroll run status is '${run.status}', not locked.`, period, run };
  const item = (run.items || []).find(i => i.empId === employee.id);
  if (!item) return { ok: false, reason: 'Employee payroll item not found in the locked run.', period, run };
  return { ok: true, period, run, item };
}

// Whether the located locked context is actually safe to use for an AUTOMATIC delta calculation
// (issues 19/20). A manual override on the item means a human already decided the system-computed
// figure needed correcting for reasons this code has no way to know -- automatically recomputing
// on top of that could silently discard their intent. A missing attendanceSummary/rates snapshot
// or rule snapshot means there is nothing safe to reconstruct the "original" side from at all.
function checkReconciliationEligibility(ctx) {
  if (!ctx.ok) return { eligible: false, reason: ctx.reason };
  const { item, run } = ctx;
  if (item.manualOverride) {
    return { eligible: false, reason: 'Original locked payroll contains manual overrides; automatic leave delta cannot safely infer intended historical payroll.' };
  }
  if (!item.attendanceSummary || typeof item.attendanceSummary !== 'object') {
    return { eligible: false, reason: 'Locked payroll item is missing its original attendance summary snapshot.' };
  }
  if (!item.rates || !Number.isFinite(Number(item.rates.daily))) {
    return { eligible: false, reason: 'Locked payroll item is missing its original rate snapshot.' };
  }
  if (!Array.isArray(run.ruleSnapshot)) {
    return { eligible: false, reason: 'Locked payroll run is missing its rule snapshot.' };
  }
  return { eligible: true };
}

// Reverse-engineers a synthetic employee whose salaryPM/dailyDivisor/hoursPerDay make
// PayrollRuleEngine.calculate() reproduce EXACTLY the locked item's own frozen rates.daily/
// rates.hourly -- rather than trying to locate and trust a compensation-history snapshot (which,
// per the codebase's own effectiveEmployee(), is frequently absent even for correctly-computed
// payrolls whenever an employee's salary simply never changed), this guarantees byte-for-byte
// historical rate fidelity directly from the one number the original computation already froze
// (issue 4: never let a since-changed salary/divisor/company setting leak into the correction).
function historicalRateEmployee(employee, item) {
  const rates = item.rates || {};
  const daily = Number(rates.daily) || 0;
  const dailyDivisor = Number(rates.dailyDivisor) || 22;
  const hourly = Number(rates.hourly) || (daily / 8);
  const hoursPerDay = hourly > 0 ? daily / hourly : 8;
  return Object.assign({}, employee, {
    salaryPM: daily * dailyDivisor,
    dailyDivisor,
    hoursPerDay: hoursPerDay || 8,
    annualWorkdays: Number(rates.annualWorkdays) || employee.annualWorkdays
  });
}

// Rebuilds PayrollRuleEngine-compatible rule objects from the run's own frozen ruleSnapshot
// (id/code/version/effectiveFrom/value pairs, see payroll-governance.js's lockPayrollRun) -- the
// exact ABSENCE_DEDUCTION/LATE_ROUNDING_MINUTES multipliers active when this run was computed,
// never whatever PAYROLL_RULEBOOK looks like today.
function reconstructHistoricalRules(run) {
  return (run.ruleSnapshot || []).map(r => ({
    code: r.code, status: 'active', effectiveFrom: r.effectiveFrom || '', effectiveTo: '',
    version: r.version, value: r.value, priority: 100, coverage: {}, source: 'Locked payroll run rule snapshot'
  }));
}

// Runs PayrollRuleEngine.calculate() with everything EXCEPT attendance held fixed and isolated --
// no adjustments/loans/recurring allowances, statutory and tax zeroed out. This is deliberate
// (issue 7): the underlying attendance-driven earning/deduction is what this module corrects;
// statutory/tax consequences of THAT correction are left to the next normal payroll run's own
// annualization, exactly like any other payroll adjustment already does, rather than computing
// (and risking double-counting) a second, separate tax delta here.
function isolatedAttendancePayroll(historicalEmployee, rules, baseBasic, attendanceSummary) {
  return PayrollRuleEngine.calculate({
    employee: historicalEmployee, group: ISOLATION_GROUP, period: ISOLATION_PERIOD,
    rules, baseBasic: Number(baseBasic) || 0, defaultDivisor: historicalEmployee.dailyDivisor,
    attendance: attendanceSummary, adjustments: [], loans: [],
    statutory: ZERO_STATUTORY, tax: ZERO_TAX
  });
}

// The CORRECTED side needs a stricter, fully-fractional view of absentDays/unpaidLeaveDays than
// TimekeepingCore.periodSummary() itself provides live. periodSummary deliberately keeps a flat
// +1-per-'absent'-record count (and only ever adds unpaidLeaveDays when the work half was
// genuinely worked) specifically so it never double-counts against the SEPARATE, still-unchanged
// open-period credit-back mechanism (creditLateApprovalDay's requireClosedPeriod:false branch,
// server/leave-service.js) that coexists with it for an OPEN period. That mechanism does not
// exist for a locked/closed-period date -- this reconciliation module is the ONE AND ONLY
// correction path there -- so it can and must be fully precise instead: a genuine (non-leave)
// absence still contributes a full 1.0 day, but an approved half-day-leave record -- worked or
// not -- contributes exactly absentWorkFraction (the uncovered work half's own loss, 0 if it WAS
// worked) plus unpaidLeaveFraction (the leave half's own unpaid loss) and nothing else, so a PAID
// leave half is correctly never counted as lost pay in either sub-case. late/undertime/OT/ND/
// rest-day-holiday hours and presentDays are reused verbatim from periodSummary -- only its
// absence/unpaid-leave semantics differ here.
function reconciliationAttendanceSummary(records, employee, from, to, shifts, holidays, startOfWeek) {
  const base = TimekeepingCore.periodSummary(records, employee, from, to, shifts, holidays, startOfWeek);
  const rows = TimekeepingCore.canonicalRecords(records).filter(r => r.eid === employee.id && r.date >= from && r.date <= to && r.approvalStatus !== 'rejected');
  let absentDays = 0, unpaidLeaveDays = 0;
  rows.forEach(record => {
    if (TimekeepingCore.isApprovedHalfDayLeaveRecord(record)) {
      absentDays += Number(record.absentWorkFraction || 0);
      unpaidLeaveDays += Number(record.unpaidLeaveFraction || 0);
    } else if (record.status === 'leave' && record.approvalStatus === 'approved' && Number(record.leaveFraction) === 1) {
      // A whole-day approved leave record: never contributes to absentDays (it isn't an absence),
      // but a genuine unpaidLeaveFraction (a balance-limited whole day, only partly paid) is a real
      // payroll loss the reconciliation must still recover -- markAttendanceForApprovedLeave stamps
      // this fraction on whole-day records for exactly this reason.
      unpaidLeaveDays += Number(record.unpaidLeaveFraction || 0);
    } else if (record.status === 'absent') {
      absentDays += 1;
    }
  });
  return Object.assign({}, base, { absentDays: Math.round(absentDays * 100) / 100, unpaidLeaveDays: Math.round(unpaidLeaveDays * 100) / 100 });
}

// Sum of already-applied leave-retro variance against this SAME locked run, from every OTHER
// leave's reconciliation (never this one -- idempotency for THIS leave is handled by the caller
// before this is ever reached). Without this, two different leaves both retroactively touching
// the same locked run would each compare against the SAME frozen original snapshot and the
// SECOND one would double-count the first's already-applied correction, since the "corrected"
// side is always computed from the current, cumulative state.attendance.
function priorAppliedVarianceForRun(state, runId, empId, excludeLeaveId) {
  const records = (state.leaveRetroReconciliations || []).filter(r =>
    r.sourcePayrollRunId === runId && r.empId === empId && r.sourceLeaveId !== excludeLeaveId && r.status === 'adjustment_created'
  );
  return records.reduce((sum, r) => sum + (Number(r.varianceNet) || 0), 0);
}

function nextReconciliationId(state) {
  const list = state.leaveRetroReconciliations || [];
  return list.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
}
function nextAdjustmentId(state) {
  const list = state.payrollAdjustments || [];
  return list.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
}

// The one reconciliation record for (leave, run, employee) -- issue 9's deterministic identity.
// Idempotent: a second call for the SAME triple returns the SAME stored record untouched,
// never recomputes, never creates a second adjustment (issues 21/38).
function findExistingReconciliation(state, leaveId, runId, empId) {
  return (state.leaveRetroReconciliations || []).find(r =>
    r.sourceType === SOURCE_TYPE && r.sourceLeaveId === leaveId && r.sourcePayrollRunId === runId && r.empId === empId
  ) || null;
}

// Reconciles ONE leave's effect against ONE locked payroll run in a single pass (issue 9: every
// date this leave touches within this run is folded into one comparison, never one guessed
// adjustment per date) using the ENTIRE original attendance period (issue 17: absence
// fallback/switch-over and other period-total-dependent rules can only be correctly evaluated over
// the full period, not a single isolated date).
//
// Preconditions the caller must guarantee: `state.attendance` already carries this leave's final,
// approved leaveFraction/paidLeaveFraction/unpaidLeaveFraction/absentWorkFraction/leaveDayType
// metadata for every date in `datesInThisRun` (i.e. this runs AFTER markAttendanceForApprovedLeave).
//
// Returns the reconciliation record (freshly created, or the pre-existing one on a duplicate call).
function reconcileOneRun(state, employee, leaveRecord, ctx, actorName) {
  const { period, run, item } = ctx;
  state.leaveRetroReconciliations = Array.isArray(state.leaveRetroReconciliations) ? state.leaveRetroReconciliations : [];
  state.payrollAdjustments = Array.isArray(state.payrollAdjustments) ? state.payrollAdjustments : [];

  const existing = findExistingReconciliation(state, leaveRecord.id, run.id, employee.id);
  if (existing) return Object.assign({}, existing, { duplicate: true });

  const nowIso = new Date().toISOString();
  const base = { id: nextReconciliationId(state), sourceType: SOURCE_TYPE, sourceLeaveId: leaveRecord.id, sourcePayrollRunId: run.id, sourcePeriodId: period.id, empId: employee.id, createdAt: nowIso, createdBy: actorName };

  const eligibility = checkReconciliationEligibility(ctx);
  if (!eligibility.eligible) {
    const record = Object.assign({}, base, { status: 'manual_review_required', method: null, reason: eligibility.reason });
    state.leaveRetroReconciliations.push(record);
    return record;
  }

  const historicalEmployee = historicalRateEmployee(employee, item);
  const rules = reconstructHistoricalRules(run);

  const originalIsolated = isolatedAttendancePayroll(historicalEmployee, rules, item.baseBasic, item.attendanceSummary);
  const correctedSummary = reconciliationAttendanceSummary(state.attendance, employee, item.attendanceFrom, item.attendanceTo, state.company.shifts || [], (state.company && state.company.holidays) || [], state.company && state.company.startOfWeek);
  const correctedIsolated = isolatedAttendancePayroll(historicalEmployee, rules, item.baseBasic, correctedSummary);

  const originalNet = +(originalIsolated.gross - originalIsolated.attendanceDeduction).toFixed(2);
  const correctedNet = +(correctedIsolated.gross - correctedIsolated.attendanceDeduction).toFixed(2);
  const priorVariance = priorAppliedVarianceForRun(state, run.id, employee.id, leaveRecord.id);
  // The delta still owed is the FULL correction less whatever a prior, independent leave already
  // corrected against this same run -- never re-derived from the raw original a second time.
  const varianceNet = +((correctedNet - originalNet) - priorVariance).toFixed(2);

  const record = Object.assign({}, base, {
    method: METHOD,
    originalNet, correctedNet, varianceNet,
    originalAttendanceDeduction: originalIsolated.attendanceDeduction,
    correctedAttendanceDeduction: correctedIsolated.attendanceDeduction,
    originalGross: originalIsolated.gross, correctedGross: correctedIsolated.gross
  });

  // Zero delta -- issue 13's explicit "do not fabricate a ₱0 adjustment" requirement.
  if (Math.abs(varianceNet) < 0.005) {
    record.status = 'no_adjustment_required';
    state.leaveRetroReconciliations.push(record);
    return record;
  }

  const isEarning = varianceNet > 0;
  const amount = varianceNet; // PayrollRuleEngine's own sign convention: positive = earning, negative = deduction.
  const adjustment = {
    id: nextAdjustmentId(state), empId: employee.id, adjType: 'Leave Retro Correction',
    payItemCode: isEarning ? 'LEAVE_RETRO_EARNING' : 'LEAVE_RETRO_DEDUCTION',
    category: isEarning ? 'earnings' : 'deductions', taxable: isEarning, direction: isEarning ? 'income' : 'deduction',
    amount,
    reason: `Leave Retro Correction for ${leaveRecord.type} (leave #${leaveRecord.id}) — Payroll Run #${run.id} (${period.attendanceFrom || period.from} to ${period.attendanceTo || period.to}) was already locked when this leave was approved. Original locked result: ₱${originalNet.toFixed(2)}. Corrected result: ₱${correctedNet.toFixed(2)}. Variance: ${amount >= 0 ? '+' : ''}₱${amount.toFixed(2)}.`,
    effectiveDate: period.attendanceTo || period.to, payPeriodId: null, payPeriodLabel: null, addedBy: actorName, status: 'ready', processStatus: 'ready', createdAt: nowIso.slice(0, 10),
    sourceType: SOURCE_TYPE, sourceLeaveId: leaveRecord.id, sourcePayrollRunId: run.id, sourcePeriodId: period.id, sourceFraction: null
  };
  state.payrollAdjustments.push(adjustment);
  record.status = 'adjustment_created';
  record.payrollAdjustmentId = adjustment.id;
  state.leaveRetroReconciliations.push(record);
  return record;
}

// Top-level entry point: given a set of dates this leave touches that fall in CLOSED pay periods,
// groups them by locked payroll run (issue 9: same run -> one reconciliation; issue 10: different
// runs -> independent reconciliations) and reconciles each run once. Dates whose period isn't
// closed at all are simply skipped here (issue 40: open-period leave never routes through this
// module) -- the caller is expected to have already filtered to closed-period dates only.
//
// Returns { reconciliations }: one entry per distinct locked run actually reconciled
// (adjustment_created / no_adjustment_required), plus one per closed-period date with no usable
// historical snapshot at all -- missing period linkage, missing/unlocked run, missing item,
// manual override, or missing rate/rule snapshot are all, uniformly, manual_review_required
// (issues 2/8/36: never a guessed dailyRate×fraction correction for ANY of these).
function reconcileLeaveAgainstLockedPayroll(state, employee, leaveRecord, closedDates, actorName) {
  const contextsByRunId = new Map();
  const unresolvedByReason = new Map();
  closedDates.forEach(date => {
    const ctx = findLockedPayrollContext(state, employee, date);
    if (!ctx.ok) {
      // A genuine data problem (period not found at all, no runId, run missing, run not locked) --
      // still worth one manual-review record so the correction isn't silently lost, keyed by
      // period rather than run since there IS no run to key by.
      const key = 'period:' + (ctx.period ? ctx.period.id : date);
      if (!unresolvedByReason.has(key)) unresolvedByReason.set(key, { period: ctx.period, reason: ctx.reason });
      return;
    }
    if (!contextsByRunId.has(ctx.run.id)) contextsByRunId.set(ctx.run.id, ctx);
  });

  const reconciliations = [];
  contextsByRunId.forEach(ctx => {
    reconciliations.push(reconcileOneRun(state, employee, leaveRecord, ctx, actorName));
  });
  unresolvedByReason.forEach(({ period, reason }) => {
    state.leaveRetroReconciliations = Array.isArray(state.leaveRetroReconciliations) ? state.leaveRetroReconciliations : [];
    const existing = period ? (state.leaveRetroReconciliations || []).find(r => r.sourceType === SOURCE_TYPE && r.sourceLeaveId === leaveRecord.id && r.sourcePeriodId === period.id && r.empId === employee.id) : null;
    if (existing) { reconciliations.push(Object.assign({}, existing, { duplicate: true })); return; }
    const record = {
      id: nextReconciliationId(state), sourceType: SOURCE_TYPE, sourceLeaveId: leaveRecord.id,
      sourcePayrollRunId: null, sourcePeriodId: period ? period.id : null, empId: employee.id,
      status: 'manual_review_required', method: null, reason,
      createdAt: new Date().toISOString(), createdBy: actorName
    };
    state.leaveRetroReconciliations.push(record);
    reconciliations.push(record);
  });
  return { reconciliations };
}

// The safe, minimal projection of a reconciliation result for a caller WITHOUT payroll visibility
// (issue 24/39) -- status only, never any amount, rate, or payroll figure.
function projectReconciliationForSession(record) {
  if (!record) return null;
  return { sourceLeaveId: record.sourceLeaveId, retroReconciliationStatus: record.status };
}

module.exports = {
  findLockedPayrollContext, checkReconciliationEligibility, historicalRateEmployee, reconstructHistoricalRules,
  isolatedAttendancePayroll, reconciliationAttendanceSummary, priorAppliedVarianceForRun, findExistingReconciliation,
  reconcileOneRun, reconcileLeaveAgainstLockedPayroll, projectReconciliationForSession,
  SOURCE_TYPE, METHOD
};
