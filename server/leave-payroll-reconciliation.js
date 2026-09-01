// Exact locked-payroll reconciliation for leave approved AFTER the affected pay period was
// already locked. Builds on PR #313's locked-payroll-delta architecture (retro = corrected result
// MINUS original locked result) and fixes the risks that pass left open:
//
//   1. The "corrected" side used to be recomputed from the ENTIRE current state.attendance for the
//      whole original period -- which meant an unrelated Time Correction, or a later schedule
//      change, silently rode along inside a leave's own retro delta. Fixed by never touching
//      state.attendance for any date except the ones THIS leave actually authorizes: the corrected
//      side is now built by deep-cloning the run's own frozen item.attendanceInputSnapshot and
//      patching in the CURRENT record for the leave's own dates only -- every other date is
//      whatever the locked payroll already saw, untouched (issues 1-5/28/29/30).
//   2. Historical schedule inputs (assigned shift, personal schedule, schedule adjustments,
//      holidays, startOfWeek) are now read from the item's own frozen scheduleSnapshot, never
//      today's live state.company.shifts -- a shift-template edit after lock can no longer
//      retroactively change what "late" meant for an already-paid date (issue 2/5/30).
//   3. The rule snapshot is validated against the specific rule codes the original calculation
//      actually needed (issue 7), and reconstructed using its own complete fields (priority,
//      coverage, rounding, source) rather than hardcoded defaults, when present (issue 8/35).
//   4. absenceFallbackPolicy/periodDays are threaded through from the item's own frozen snapshot,
//      so a switch-over policy change after lock can't alter historical replay (issue 9/31).
//   5. An item carrying an attendance-dependent recurring allowance is not safely replayable by
//      this isolated attendance-only calculation -- it routes to manual_review_required rather
//      than silently omitting that allowance's own retro impact (issue 10/32).
//   6. Reconciliations are never silently edited once applied. A correction to an applied
//      ('adjustment_created') reconciliation goes through reverseReconciliation() (a new,
//      immutable reversal adjustment, never a mutation of the original) before a fresh
//      reconciliation can be created for the same (leave, run, employee) triple, which then
//      supersedes the reversed one -- full lineage preserved (issue 17-19/36/37).
//
// No second payroll formula engine anywhere in this file: every figure is produced by the exact
// same PayrollRuleEngine.calculate() the rest of the product already uses.
'use strict';
const TimekeepingCore = require('../public/timekeeping-core.js');
const PayrollRuleEngine = require('../public/payroll-rule-engine.js');

const SOURCE_TYPE = 'leave_retro_reconciliation';
const REVERSAL_SOURCE_TYPE = 'leave_retro_reconciliation_reversal';
const METHOD = 'locked_payroll_delta';

// A synthetic, single-day period/group -- only ever used to isolate the attendance-driven lines
// (BASIC/OT/ND/RDH/ABSENT/UNPAID_LEAVE/LATE/UNDERTIME). statutoryFactor/cutoffNumber/tax timing
// are irrelevant here since statutory/tax are deliberately zeroed out in every reconciliation call
// (see isolatedAttendancePayroll's own comment for why).
const ISOLATION_GROUP = { code: 'RECON', freq: 'monthly', taxMethod: 'monthly', statutoryTiming: 'every-cutoff' };
const ISOLATION_PERIOD = { from: '1970-01-01', to: '1970-01-01', cutoff1: true, cutoff2: true };
const ZERO_STATUTORY = () => ({ sssEE: 0, sssER: 0, phEE: 0, phER: 0, piEE: 0, piER: 0 });
const ZERO_TAX = () => 0;

// Rule codes that PAYROLL_RULEBOOK actually defines and that isolatedAttendancePayroll's
// attendance-only calculation can consult (public/payroll-governance.js's PAYROLL_RULEBOOK).
const KNOWN_ATTENDANCE_RULE_CODES = new Set(['BASIC_PAY', 'OT_REGULAR_DAY', 'REST_HOLIDAY_WORK', 'NIGHT_DIFFERENTIAL', 'ABSENCE_DEDUCTION', 'LATE_ROUNDING_MINUTES']);

// Locates the pay period covering `date` for this employee's pay group, then the immutable
// locked payroll run it points to, then the employee's own frozen item within that run.
// Returns { ok:true, period, run, item } on success, or { ok:false, reason, period?, run? } as
// soon as any link in the chain is missing, so the caller always has a concrete, specific reason.
function findLockedPayrollContext(state, employee, date) {
  const periods = state.payPeriods || [];
  const period = periods.find(p => p.groupId === employee.payGroupId && (p.attendanceFrom || p.from) <= date && (p.attendanceTo || p.to) >= date);
  if (!period) return { ok: false, reason: 'No pay period covers this date for the employee\'s pay group.' };
  if (period.status !== 'closed') return { ok: false, reason: 'Pay period is not closed.', period };
  // A closed period with no linked run at all is treated exactly like any other missing/broken
  // snapshot -- manual review, never a guessed dailyRate×fraction correction.
  if (!period.runId) return { ok: false, reason: 'Closed period has no linked payroll run.', period };
  const runs = state.payrolls || [];
  const run = runs.find(r => r.id === period.runId);
  if (!run) return { ok: false, reason: 'The period\'s linked payroll run no longer exists.', period };
  // Only a genuinely finalized/posted run is a valid historical source of truth. pending_approval /
  // returned / superseded / voided are all explicitly NOT eligible -- a voided or superseded run's
  // replacement, if any, is reached by the period's OWN runId (updated whenever a replacement is
  // actually locked), never by chasing the old run's own linkage.
  if (run.status !== 'locked') return { ok: false, reason: `Linked payroll run status is '${run.status}', not locked.`, period, run };
  const item = (run.items || []).find(i => i.empId === employee.id);
  if (!item) return { ok: false, reason: 'Employee payroll item not found in the locked run.', period, run };
  return { ok: true, period, run, item };
}

// Derives which PAYROLL_RULEBOOK rule codes the item's own original calculation actually needed --
// ABSENCE_DEDUCTION whenever the locked item ever charged an absence or unpaid-leave day (both
// share that rule's multiplier), LATE_ROUNDING_MINUTES whenever it charged any late minutes, plus
// anything else recognizable in the item's own calculationTrace (issue 7).
function requiredAttendanceRuleCodes(item) {
  const codes = new Set();
  const summary = item.attendanceSummary || {};
  if (Number(summary.absentDays) > 0 || Number(summary.unpaidLeaveDays) > 0) codes.add('ABSENCE_DEDUCTION');
  if (Number(summary.lateMinutes) > 0) codes.add('LATE_ROUNDING_MINUTES');
  (item.calculationTrace || []).forEach(line => {
    if (line && KNOWN_ATTENDANCE_RULE_CODES.has(line.ruleCode)) codes.add(line.ruleCode);
  });
  return Array.from(codes);
}

// Whether the located locked context is actually safe to use for an AUTOMATIC delta calculation.
// A manual override on the item means a human already decided the system-computed figure needed
// correcting for reasons this code has no way to know. A missing attendanceSummary/rates/
// attendanceInputSnapshot/scheduleSnapshot/ruleSnapshot means there is nothing safe to reconstruct
// the original OR corrected side from at all -- including every OLD, pre-this-pass locked run that
// predates these snapshot fields (issue 26: never fabricate them retroactively from current data).
// An item carrying an attendance-dependent recurring allowance is excluded too -- this isolated,
// attendance-only calculation has no safe way to reproduce that allowance's own historical
// entitlement (issue 10).
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
  if (!Array.isArray(item.attendanceInputSnapshot)) {
    return { eligible: false, reason: 'Locked payroll item is missing its historical attendance input snapshot (attendanceInputSnapshot) -- an old run predating this snapshot cannot be safely replayed for a leave-only correction.' };
  }
  if (!item.scheduleSnapshot || typeof item.scheduleSnapshot !== 'object') {
    return { eligible: false, reason: 'Locked payroll item is missing its historical schedule snapshot (scheduleSnapshot) -- an old run predating this snapshot cannot be safely replayed for a leave-only correction.' };
  }
  if (!Array.isArray(run.ruleSnapshot) || !run.ruleSnapshot.length) {
    return { eligible: false, reason: 'Locked payroll run is missing its rule snapshot.' };
  }
  const missingRules = requiredAttendanceRuleCodes(item).filter(code => !run.ruleSnapshot.some(r => r.code === code));
  if (missingRules.length) {
    return { eligible: false, reason: `Locked payroll run's rule snapshot is missing rule(s) the original calculation required: ${missingRules.join(', ')}.` };
  }
  if ((item.recurringAllowances || []).some(a => a.attendanceBased)) {
    return { eligible: false, reason: 'Locked payroll item includes an attendance-dependent recurring allowance; this isolated attendance-only reconciliation cannot safely reproduce its historical entitlement.' };
  }
  return { eligible: true };
}

// Reverse-engineers a synthetic employee whose salaryPM/dailyDivisor/hoursPerDay make
// PayrollRuleEngine.calculate() reproduce EXACTLY the locked item's own frozen rates.daily/
// rates.hourly -- rather than trying to locate and trust a compensation-history snapshot (which,
// per the codebase's own effectiveEmployee(), is frequently absent even for correctly-computed
// payrolls whenever an employee's salary simply never changed), this guarantees byte-for-byte
// historical rate fidelity directly from the one number the original computation already froze.
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

// Reconstructs the exact timekeeping configuration TimekeepingCore.scheduleForDate()/isRestDay()
// need, entirely from the item's own frozen scheduleSnapshot (public/payroll-governance.js's
// buildScheduleSnapshot) -- never today's live state.company.shifts/holidays, and never the
// employee's own CURRENT shiftId/personalSchedule/scheduleAdjustments, any of which may have
// changed since this payroll was locked (issue 2/5/30).
function historicalScheduleContext(item, employee) {
  const snap = item.scheduleSnapshot || {};
  const historicalEmployee = Object.assign({}, employee, {
    shiftId: snap.shiftId || null,
    personalSchedule: snap.personalSchedule || null,
    scheduleAdjustments: Array.isArray(snap.scheduleAdjustments) ? snap.scheduleAdjustments : [],
    hoursPerDay: Number(snap.hoursPerDay) || employee.hoursPerDay,
    scheduleType: snap.scheduleType || employee.scheduleType
  });
  const shifts = snap.assignedShift ? [snap.assignedShift] : [];
  return { historicalEmployee, shifts, holidays: Array.isArray(snap.holidays) ? snap.holidays : [], startOfWeek: snap.startOfWeek || 'mon' };
}

// Merges the rate-fidelity reconstruction and the schedule reconstruction into one synthetic
// historical employee, safe to pass to both isolatedAttendancePayroll (rates/divisor) and
// reconciliationAttendanceSummary/periodSummary (schedule fields).
function combinedHistoricalEmployee(employee, item) {
  const scheduleCtx = historicalScheduleContext(item, employee);
  return Object.assign({}, historicalRateEmployee(employee, item), {
    shiftId: scheduleCtx.historicalEmployee.shiftId, personalSchedule: scheduleCtx.historicalEmployee.personalSchedule,
    scheduleAdjustments: scheduleCtx.historicalEmployee.scheduleAdjustments, scheduleType: scheduleCtx.historicalEmployee.scheduleType
  });
}

// Rebuilds PayrollRuleEngine-compatible rule objects from the run's own frozen ruleSnapshot,
// preserving its own priority/coverage/rounding/formula/source EXACTLY when the snapshot carries
// them (issue 8/35) -- only a pre-this-pass OLD snapshot (id/code/version/effectiveFrom/value only)
// falls back to the old generic defaults.
function reconstructHistoricalRules(run) {
  return (run.ruleSnapshot || []).map(r => ({
    code: r.code, status: r.status || 'active',
    effectiveFrom: r.effectiveFrom || '', effectiveTo: r.effectiveTo || '',
    version: r.version, value: r.value,
    priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
    coverage: r.coverage && typeof r.coverage === 'object' ? r.coverage : {},
    formula: r.formula || '', rounding: r.rounding || '',
    source: r.source || 'Locked payroll run rule snapshot'
  }));
}

// Runs PayrollRuleEngine.calculate() with everything EXCEPT attendance held fixed and isolated --
// no adjustments/loans/recurring allowances, statutory and tax zeroed out (issue 11: every
// unrelated pay component -- loans, manual adjustments, bonuses, non-attendance allowances,
// statutory, manual overrides, prior corrections -- is held constant by simply never being part of
// this calculation at all). absenceFallbackPolicy/periodDays are threaded through from the item's
// own frozen snapshot so a switch-over policy reproduces exactly (issue 9).
function isolatedAttendancePayroll(historicalEmployee, rules, baseBasic, attendanceSummary, absenceFallbackPolicy, periodDays) {
  return PayrollRuleEngine.calculate({
    employee: historicalEmployee, group: ISOLATION_GROUP, period: ISOLATION_PERIOD,
    rules, baseBasic: Number(baseBasic) || 0, defaultDivisor: historicalEmployee.dailyDivisor,
    attendance: attendanceSummary, adjustments: [], loans: [],
    absenceFallbackPolicy: absenceFallbackPolicy || undefined, periodDays: periodDays || undefined,
    statutory: ZERO_STATUTORY, tax: ZERO_TAX
  });
}

// The CORRECTED side needs a stricter, fully-fractional view of absentDays/unpaidLeaveDays than
// TimekeepingCore.periodSummary() itself provides live (periodSummary deliberately keeps a flat
// +1-per-'absent'-record count for the still-unchanged OPEN-period credit-back mechanism, which
// doesn't apply here). An approved half-day-leave record -- worked or not -- contributes exactly
// absentWorkFraction plus unpaidLeaveFraction; a whole-day approved leave record contributes only
// its own unpaidLeaveFraction (never counted as an absence); a genuine (non-leave) absence still
// contributes a full 1.0 day.
function reconciliationAttendanceSummary(records, employee, from, to, shifts, holidays, startOfWeek) {
  const base = TimekeepingCore.periodSummary(records, employee, from, to, shifts, holidays, startOfWeek);
  const rows = TimekeepingCore.canonicalRecords(records).filter(r => r.eid === employee.id && r.date >= from && r.date <= to && r.approvalStatus !== 'rejected');
  let absentDays = 0, unpaidLeaveDays = 0;
  rows.forEach(record => {
    if (TimekeepingCore.isApprovedHalfDayLeaveRecord(record)) {
      absentDays += Number(record.absentWorkFraction || 0);
      unpaidLeaveDays += Number(record.unpaidLeaveFraction || 0);
    } else if (record.status === 'leave' && record.approvalStatus === 'approved' && Number(record.leaveFraction) === 1) {
      unpaidLeaveDays += Number(record.unpaidLeaveFraction || 0);
    } else if (record.status === 'absent') {
      absentDays += 1;
    }
  });
  return Object.assign({}, base, { absentDays: Math.round(absentDays * 100) / 100, unpaidLeaveDays: Math.round(unpaidLeaveDays * 100) / 100 });
}

// THE fix for issues 1-5/28/29: the corrected side is built from a deep clone of the locked item's
// OWN frozen attendanceInputSnapshot, with ONLY the leave's own authorized dates replaced by the
// CURRENT (final-approved) attendance record for that date. Every other date in the period --
// including one touched by a later, entirely unrelated Time Correction, absence-status fix, or
// late-approval correction -- is left EXACTLY as the locked payroll originally saw it. This is what
// makes "start from the original locked attendance snapshot, overlay only the leave's own changes"
// structurally impossible to violate: an unrelated date's current record is never even read.
function buildLeaveCorrectedAttendanceRecords(item, employee, leaveDates, currentAttendance) {
  const leaveDateSet = new Set(leaveDates);
  const snapshotForEmployee = (item.attendanceInputSnapshot || []).filter(r => r && r.eid === employee.id);
  const kept = snapshotForEmployee.filter(r => !leaveDateSet.has(r.date));
  const patched = [];
  leaveDateSet.forEach(date => {
    const current = (currentAttendance || []).find(r => r.eid === employee.id && r.date === date && r.approvalStatus !== 'rejected');
    if (current) patched.push(current);
  });
  return kept.concat(patched);
}

// Sum of already-EFFECTIVE (still-applied, never reversed or superseded) leave-retro variance
// against this SAME locked run, from every OTHER leave's reconciliation. A reversed or superseded
// reconciliation's variance no longer counts -- its own reversal adjustment already unwound it
// (issue 18/36): only the net of what is genuinely still applied should offset a fresh delta.
function effectivePriorRetroVarianceForRun(state, runId, empId, excludeLeaveId) {
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

// The one LIVE reconciliation record for (leave, run, employee) -- deliberately excludes a
// 'reversed'/'superseded' record, since those are historical lineage, not the current answer.
// Idempotent: a second call for the SAME triple while a live record exists returns that SAME
// stored record untouched, never recomputes, never creates a second adjustment.
function findExistingReconciliation(state, leaveId, runId, empId) {
  return (state.leaveRetroReconciliations || []).find(r =>
    r.sourceType === SOURCE_TYPE && r.sourceLeaveId === leaveId && r.sourcePayrollRunId === runId && r.empId === empId &&
    r.status !== 'reversed' && r.status !== 'superseded'
  ) || null;
}

// The most recent reversed-but-not-yet-superseded reconciliation for this triple, if any -- used
// to link a fresh replacement reconciliation back to what it supersedes (issue 17).
function mostRecentlyReversedReconciliation(state, leaveId, runId, empId) {
  const candidates = (state.leaveRetroReconciliations || []).filter(r =>
    r.sourceType === SOURCE_TYPE && r.sourceLeaveId === leaveId && r.sourcePayrollRunId === runId && r.empId === empId &&
    r.status === 'reversed' && !r.replacementReconciliationId
  );
  return candidates[candidates.length - 1] || null;
}

// Every date, across EVERY leave reconciled against this same run (not just the current one), that
// a prior automatic reconciliation has already confirmed as leave-authorized and safe to read from
// CURRENT attendance -- the authoritative rule's own "plus prior intentionally-applied leave retro
// effects" clause. Without this, reconciling a SECOND leave against a run a first leave already
// touched would reintroduce the FIRST leave's date from the stale original snapshot (still
// 'absent') instead of its own already-correct 'leave' interpretation, silently re-charging an
// absence that was already fixed. A 'manual_review_required' record's dates are deliberately
// excluded -- nothing was ever safely computed for them, so there is nothing safe to carry forward.
function allKnownLeaveDatesForRun(state, runId, empId) {
  const dates = new Set();
  (state.leaveRetroReconciliations || []).forEach(r => {
    if (r.sourcePayrollRunId === runId && r.empId === empId && r.status !== 'manual_review_required' && Array.isArray(r.leaveDates)) {
      r.leaveDates.forEach(d => dates.add(d));
    }
  });
  return dates;
}

// A component-level breakdown of the isolated attendance-only lines (issue 12) -- {code: amount}
// for both sides, so an auditor can see exactly which attendance-driven component moved, never
// just a single collapsed gross-minus-deduction figure.
function componentMap(isolatedResult) {
  const map = {};
  (isolatedResult.lines || []).forEach(line => { map[line.code] = (map[line.code] || 0) + Number(line.amount || 0); });
  return map;
}

// Reconciles ONE leave's effect against ONE locked payroll run, for the specific subset of
// `leaveDatesForThisRun` (issue 9: every one of THIS leave's dates that fall in THIS run is folded
// into one comparison; issue 34: a leave spanning two runs reconciles independently against each,
// via separate calls) using the ENTIRE original attendance period (absence fallback/switch-over and
// other period-total-dependent rules can only be correctly evaluated over the full period, not a
// single isolated date) -- but built exclusively from the locked snapshot plus this leave's own
// patch, never the live, current, full-period attendance state.
//
// Preconditions the caller must guarantee: `state.attendance` already carries this leave's final,
// approved leaveFraction/paidLeaveFraction/unpaidLeaveFraction/absentWorkFraction/leaveDayType
// metadata for every date in `leaveDatesForThisRun` (i.e. this runs AFTER markAttendanceForApprovedLeave).
//
// Returns the reconciliation record (freshly created, or the pre-existing LIVE one on a duplicate call).
function reconcileOneRun(state, employee, leaveRecord, ctx, leaveDatesForThisRun, actorName) {
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

  const historicalEmployee = combinedHistoricalEmployee(employee, item);
  const scheduleCtx = historicalScheduleContext(item, employee);
  const rules = reconstructHistoricalRules(run);
  const fallbackPolicy = item.absenceFallbackPolicySnapshot || null;
  const periodDays = item.periodDaysSnapshot || null;

  const originalIsolated = isolatedAttendancePayroll(historicalEmployee, rules, item.baseBasic, item.attendanceSummary, fallbackPolicy, periodDays);

  // This leave's own dates, UNIONED with every other date already confirmed leave-authorized by a
  // prior reconciliation against this same run -- never just this leave's dates alone, or a second
  // leave against an already-touched run would reintroduce the first leave's date from the stale
  // original snapshot instead of its own already-corrected 'leave' interpretation.
  const patchDates = new Set(leaveDatesForThisRun);
  allKnownLeaveDatesForRun(state, run.id, employee.id).forEach(d => patchDates.add(d));
  const correctedRecords = buildLeaveCorrectedAttendanceRecords(item, employee, Array.from(patchDates), state.attendance);
  const correctedSummary = reconciliationAttendanceSummary(correctedRecords, historicalEmployee, item.attendanceFrom, item.attendanceTo, scheduleCtx.shifts, scheduleCtx.holidays, scheduleCtx.startOfWeek);
  const correctedIsolated = isolatedAttendancePayroll(historicalEmployee, rules, item.baseBasic, correctedSummary, fallbackPolicy, periodDays);

  const originalNet = +(originalIsolated.gross - originalIsolated.attendanceDeduction).toFixed(2);
  const correctedNet = +(correctedIsolated.gross - correctedIsolated.attendanceDeduction).toFixed(2);
  const priorVariance = effectivePriorRetroVarianceForRun(state, run.id, employee.id, leaveRecord.id);
  // The delta still owed is the FULL correction less whatever a prior, still-EFFECTIVE, independent
  // leave already corrected against this same run -- never re-derived from the raw original a
  // second time, and never counting a reversed/superseded prior correction.
  const varianceNet = +((correctedNet - originalNet) - priorVariance).toFixed(2);

  const record = Object.assign({}, base, {
    method: METHOD,
    leaveDates: leaveDatesForThisRun.slice(),
    originalNet, correctedNet, varianceNet,
    originalAttendanceDeduction: originalIsolated.attendanceDeduction,
    correctedAttendanceDeduction: correctedIsolated.attendanceDeduction,
    originalGross: originalIsolated.gross, correctedGross: correctedIsolated.gross,
    componentDelta: { original: componentMap(originalIsolated), corrected: componentMap(correctedIsolated) }
  });

  const priorReversed = mostRecentlyReversedReconciliation(state, leaveRecord.id, run.id, employee.id);
  if (priorReversed) { record.supersedesReconciliationId = priorReversed.id; priorReversed.replacementReconciliationId = record.id; }

  // Zero delta -- do not fabricate a ₱0 adjustment.
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
// groups them by locked payroll run (issue 9: same run -> one reconciliation, using only THAT run's
// own dates; issue 10/34: different runs -> independent reconciliations) and reconciles each run
// once. Dates whose period isn't closed at all are simply skipped here -- the caller is expected to
// have already filtered to closed-period dates only.
function reconcileLeaveAgainstLockedPayroll(state, employee, leaveRecord, closedDates, actorName) {
  const contextsByRunId = new Map();
  const unresolvedByReason = new Map();
  closedDates.forEach(date => {
    const ctx = findLockedPayrollContext(state, employee, date);
    if (!ctx.ok) {
      const key = 'period:' + (ctx.period ? ctx.period.id : date);
      if (!unresolvedByReason.has(key)) unresolvedByReason.set(key, { period: ctx.period, reason: ctx.reason });
      return;
    }
    if (!contextsByRunId.has(ctx.run.id)) contextsByRunId.set(ctx.run.id, { ctx, dates: [] });
    contextsByRunId.get(ctx.run.id).dates.push(date);
  });

  const reconciliations = [];
  contextsByRunId.forEach(({ ctx, dates }) => {
    reconciliations.push(reconcileOneRun(state, employee, leaveRecord, ctx, dates, actorName));
  });
  unresolvedByReason.forEach(({ period, reason }) => {
    state.leaveRetroReconciliations = Array.isArray(state.leaveRetroReconciliations) ? state.leaveRetroReconciliations : [];
    const existing = period ? (state.leaveRetroReconciliations || []).find(r => r.sourceType === SOURCE_TYPE && r.sourceLeaveId === leaveRecord.id && r.sourcePeriodId === period.id && r.empId === employee.id && r.status !== 'reversed' && r.status !== 'superseded') : null;
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

// Reverses an applied ('adjustment_created') reconciliation -- NEVER edits or removes the original
// payroll adjustment (issue 19: once applied, its amount/source metadata is immutable). Instead
// books a new, equal-and-opposite adjustment and marks the reconciliation record itself 'reversed'
// with a full audit trail. A fresh call to reconcileLeaveAgainstLockedPayroll for the same
// (leave, run, employee) triple afterward is then free to create a genuine replacement (issue 17),
// since findExistingReconciliation ignores reversed records.
//
// The reversal is built from an EXPLICIT ALLOWLIST, never Object.assign({}, original, {...}) --
// the original adjustment may already carry real processing-lifecycle state from having gone
// through an actual payroll run (status:'applied', processStatus:'applied', payrollRunId:<id>,
// appliedAt:<timestamp>, payPeriodId/payPeriodLabel once it was actually included in one -- see
// public/payroll-governance.js's runPayroll()/lockPayrollRun(), which are the only places that set
// those fields). A reversal is a brand-new, entirely unprocessed adjustment -- it has never been
// submitted into any payroll run, so it must start in the canonical unprocessed state
// (status/processStatus:'ready', no payrollRunId/payPeriodId/payPeriodLabel/appliedAt at all) and
// enter the normal adjustment queue to be picked up by the next eligible payroll, exactly like any
// other freshly-created adjustment. Object.assign would have silently carried the OLD run's
// processing state onto a brand-new entry that was never actually processed.
//
// Tax/pay-item treatment (taxable/payItemCode/category/direction) is inherited from the ORIGINAL
// correction's own treatment, never re-derived from the reversed amount's sign alone: reversing a
// taxable earning is still reversing a taxable earning. payItemCode/category/direction do still
// track the reversal's OWN amount sign (the payroll engine itself classifies earning-vs-deduction
// purely from amount sign -- public/payroll-rule-engine.js's `isDeduction = amount < 0` -- so
// keeping these three mutually consistent with the reversal's own sign, by deriving all three from
// the same `isEarning` value, is what avoids the contradictory-combination risk), while `taxable`
// is the one field that deliberately does NOT follow that sign -- it preserves the original
// correction's own tax character instead. `reversalOfPayItemCode` records which original pay item
// this reverses, for audit trail, independent of the reversal's own (sign-derived) payItemCode.
function reverseReconciliation(state, reconciliationId, actorName, reason) {
  state.leaveRetroReconciliations = Array.isArray(state.leaveRetroReconciliations) ? state.leaveRetroReconciliations : [];
  state.payrollAdjustments = Array.isArray(state.payrollAdjustments) ? state.payrollAdjustments : [];
  const record = state.leaveRetroReconciliations.find(r => r.id === reconciliationId);
  if (!record) return { ok: false, reason: 'Reconciliation not found.' };
  if (record.status !== 'adjustment_created') {
    return { ok: false, reason: `Only an applied ('adjustment_created') reconciliation can be reversed (current status: '${record.status}').` };
  }
  const original = state.payrollAdjustments.find(a => a.id === record.payrollAdjustmentId);
  if (!original) return { ok: false, reason: 'Original payroll adjustment not found; cannot reverse safely.' };
  if (!reason || !String(reason).trim()) return { ok: false, reason: 'A reversal reason is required for the audit trail.' };
  const nowIso = new Date().toISOString();
  const reversedAmount = -Number(original.amount);
  const isEarning = reversedAmount >= 0;
  const reversal = {
    id: nextAdjustmentId(state),
    empId: original.empId,
    adjType: 'Leave Retro Reversal',
    payItemCode: isEarning ? 'LEAVE_RETRO_EARNING' : 'LEAVE_RETRO_DEDUCTION',
    category: isEarning ? 'earnings' : 'deductions',
    direction: isEarning ? 'income' : 'deduction',
    // Preserves the ORIGINAL correction's own tax character -- never re-derived from the reversed
    // amount's sign.
    taxable: original.taxable,
    amount: reversedAmount,
    reason: `Reversal of adjustment #${original.id} for leave #${record.sourceLeaveId}, payroll run #${record.sourcePayrollRunId}. Reason: ${reason}`,
    effectiveDate: original.effectiveDate,
    // Canonical unprocessed state -- this adjustment has never been submitted into any payroll
    // run. No payrollRunId/appliedAt: it enters the normal queue for the next eligible payroll,
    // never attached directly to the old (locked/voided) run it corrects.
    payPeriodId: null, payPeriodLabel: null, addedBy: actorName, status: 'ready', processStatus: 'ready', createdAt: nowIso.slice(0, 10),
    sourceType: REVERSAL_SOURCE_TYPE, sourceLeaveId: record.sourceLeaveId, sourcePayrollRunId: record.sourcePayrollRunId, sourcePeriodId: record.sourcePeriodId, sourceFraction: null,
    reversesAdjustmentId: original.id, reversesReconciliationId: record.id, reversalOfPayItemCode: original.payItemCode
  };
  state.payrollAdjustments.push(reversal);
  record.status = 'reversed';
  record.reversedBy = actorName;
  record.reversedAt = nowIso;
  record.reversalReason = String(reason).trim();
  record.reversalAdjustmentId = reversal.id;
  return { ok: true, record, reversalAdjustment: reversal };
}

// The safe, minimal projection of a reconciliation result for a caller WITHOUT payroll visibility --
// status only, never any amount, rate, or payroll figure.
function projectReconciliationForSession(record) {
  if (!record) return null;
  return { sourceLeaveId: record.sourceLeaveId, retroReconciliationStatus: record.status };
}

module.exports = {
  findLockedPayrollContext, checkReconciliationEligibility, requiredAttendanceRuleCodes, historicalRateEmployee,
  historicalScheduleContext, combinedHistoricalEmployee, reconstructHistoricalRules, isolatedAttendancePayroll,
  reconciliationAttendanceSummary, buildLeaveCorrectedAttendanceRecords, effectivePriorRetroVarianceForRun,
  findExistingReconciliation, mostRecentlyReversedReconciliation, reconcileOneRun, reconcileLeaveAgainstLockedPayroll,
  reverseReconciliation, projectReconciliationForSession,
  SOURCE_TYPE, REVERSAL_SOURCE_TYPE, METHOD
};
