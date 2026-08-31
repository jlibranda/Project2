// Backend-authoritative leave filing and approval-finalization logic. Every function here is a
// direct, deliberate port of the real client-side business rules (submitLeave/updateLeaveComputation/
// countLeaveWorkingDays/leaveBalanceFor in public/index.html; markAttendanceForApprovedLeave/
// creditLateApprovalDay/employeeDailyRate/payrollAlreadyClosedFor in public/index.html, invoked
// from actLeave()) -- no new leave policy is introduced here, only where these rules run from.
//
// Why this needs to exist at all: an employee's submitted `days`/`paidDays`/`unpaidDays` are
// payroll-impacting numbers the client used to compute and the server used to simply store
// (server/state-serialization.js's old sanitizeEmployeeLeaveRecord trusted them outright), and the
// leave balance deduction / attendance generation / late-approval payroll credit that happen when
// a leave is finally approved used to run entirely in the browser (actLeave() in public/index.html),
// racing independently against the server-authoritative approval decision itself. Both are fixed by
// moving the actual computation here, callable from both the leave-filing endpoint and the
// leave-decision endpoint's own mutateAppState transaction.
const TimekeepingCore = require('../public/timekeeping-core.js');

const DAY_TYPES = new Set(['whole', 'half_am', 'half_pm']);
const HALF_DAY_LABELS = { half_am: 'Half Day — First Half', half_pm: 'Half Day — Second Half' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A YYYY-MM-DD string is only genuinely valid if reconstructing a Date from it and formatting
// that Date back to YYYY-MM-DD reproduces the exact same string -- 2026-02-31 fails this because
// JS Date rolls the overflow into March, 2026-13-01 and 2026-00-10 fail because there's no such
// month, and the round-trip catches all of them without hand-writing days-in-month/leap-year
// tables (the regex alone would happily accept every one of those as "well-formed").
function isValidIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// THE canonical eligible-leave-date list -- calendar dates in the inclusive range that count as an
// actual leave day, excluding the employee's scheduled rest days (or every calendar day if the
// employee has no shift assigned, since there's no schedule to check rest days against). This is
// the single source of truth every per-date leave effect must use: day-count calculation at
// filing, approved-leave attendance generation, and late-approval payroll crediting all used to
// independently decide "which dates does this leave cover" -- filing correctly excluded rest days
// (countLeaveWorkingDays, below, is now just this function's length) but finalization used to loop
// every calendar date via leaveDateRange() instead, which could mark a rest day as 'leave' in
// Attendance and even generate a late-payroll credit for a day the employee was never scheduled to
// work, while skipping the actual eligible workday that credit should have gone to instead.
function eligibleLeaveDates(state, employee, startStr, endStr) {
  if (!startStr || !endStr || endStr < startStr) return [];
  const shifts = (state.company && state.company.shifts) || [];
  const dates = [];
  let cursor = new Date(startStr + 'T00:00:00Z');
  const last = new Date(endStr + 'T00:00:00Z');
  let guard = 0;
  while (cursor <= last && guard < 3660) { // ~10 years, matches the spirit of leaveDateRange's own 366-day cap
    const ds = cursor.toISOString().slice(0, 10);
    // TimekeepingCore.isRestDay already correctly handles an employee with no assigned shift at
    // all (falls through to `false` -- not a designated rest day) as well as a personal-schedule-
    // or schedule-adjustment-only employee -- gating this behind employee.shiftId used to skip the
    // whole check for exactly that personal-schedule-only case, wrongly counting their configured
    // rest days as eligible leave days.
    const isRest = TimekeepingCore.isRestDay(employee, ds, shifts);
    if (!isRest) dates.push(ds);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard++;
  }
  return dates;
}

// Exact port of countLeaveWorkingDays(startStr, endStr) in public/index.html -- now simply the
// length of the one canonical eligible-date list above, so filing's day count and finalization's
// per-date effects can never disagree about which dates a leave actually covers.
function countLeaveWorkingDays(state, employee, startStr, endStr) {
  return eligibleLeaveDates(state, employee, startStr, endStr).length;
}

// Exact port of leaveBalanceFor(emp, typeId) in public/index.html.
function leaveBalanceFor(employee, typeId) {
  return (employee && employee.leaveBalances && employee.leaveBalances[typeId]) || { balance: 0, adjustments: [] };
}

// Exact port of leaveDateRange(s, e) in public/index.html -- every calendar date from s to e
// inclusive, capped so a bad/huge date range can't loop forever. Kept for compatibility (used by
// legacy-allocation derivation as a raw calendar fallback) even though eligibleLeaveDates is now
// the canonical rest-day-aware source for every normal path.
function leaveDateRange(s, e) {
  const dates = [];
  let cursor = new Date((s || '') + 'T00:00:00Z');
  const last = new Date((e || s || '') + 'T00:00:00Z');
  while (cursor <= last && dates.length < 366) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// THE canonical per-date leave-request FOOTPRINT -- which calendar date(s) a request touches and
// how much of a working day each one represents (1 = a whole eligible day, 0.5 = the single date
// of a half-day request). This is deliberately NOT about paid/unpaid: that split is layered on top
// of this frozen footprint by allocatePaidFraction(), below, using whatever the CURRENT balance
// allows at approval time (unchanged behavior from the prior pass) -- so a later balance change can
// only affect how much of THIS footprint ends up paid, never which dates/fractions it contains.
// Computed once at filing time and stored on the record (leaveRecord.leaveAllocation) precisely so
// a schedule change between filing and approval can never silently add or drop a date (issue 13).
function buildLeaveDayAllocation(state, employee, req) {
  const dayType = (req && req.dayType) || 'whole';
  if (dayType !== 'whole') {
    if (!req || !req.s) return [];
    return [{ date: req.s, fraction: 0.5, dayType }];
  }
  return eligibleLeaveDates(state, employee, req.s, req.e).map(date => ({ date, fraction: 1 }));
}

// Walks a FROZEN leaveAllocation footprint in date order, consuming `paidTotal` days -- returns a
// parallel list where each entry also carries `paidFraction`: how much of THAT date's own fraction
// is actually paid leave (never more than the date's fraction, never more than what's left of
// paidTotal). The remainder on any entry (fraction - paidFraction) is unpaid/absence territory,
// handled by existing attendance/payroll rules, never manufactured into a second paid portion here.
// This is what makes a 1.5-day paid balance correctly split into a full day + a half day of credit
// (dailyRate*1 + dailyRate*0.5) instead of the old integer-counted "2 full days" bug.
function allocatePaidFraction(allocation, paidTotal) {
  let remaining = Math.max(0, Number(paidTotal) || 0);
  return (allocation || []).map(entry => {
    const paidFraction = +Math.max(0, Math.min(entry.fraction, remaining)).toFixed(3);
    remaining = +(remaining - paidFraction).toFixed(3);
    return Object.assign({}, entry, { paidFraction });
  });
}

// Validates + derives a complete leave request server-side, mirroring submitLeave()'s exact rules.
// Never trusts a client-supplied days/paidDays/unpaidDays/halfDayLabel -- those are always derived
// here from type/startDate/endDate/dayType plus the employee's own current leave balance.
//
// One deliberate deviation from the client: submitLeave() silently treats an unrecognized `type`
// string as a fully-paid, uncapped request (COMPANY.leaveTypes has no matching entry, so its
// `if(t){...}` branch never runs and paidDays/unpaidDays fall back to their unmodified defaults).
// That's a client-side quirk, not a rule worth preserving server-side -- "valid leave type" is an
// explicit validation requirement for this pass, so an unrecognized type is rejected outright here
// instead.
//
// acknowledgeShortfall mirrors the client's confirm() dialog for filing over-balance (paid type
// exceeding its balance, becoming partly unpaid; or an unpaid type exceeding ITS OWN tracked
// balance) -- the server can't show a dialog, so when the computed request would need one and the
// caller hasn't already confirmed it (acknowledgeShortfall !== true), this returns needsAcknowledgment
// with the computed numbers instead of filing, so the frontend can show the exact same confirmation
// text before resubmitting with acknowledgeShortfall:true.
function calculateLeaveRequest(state, employee, input, acknowledgeShortfall) {
  const type = String((input && input.type) || '').trim();
  const reason = String((input && input.reason) || '').trim();
  // A dayType that's simply absent defaults to 'whole' (the client's own default) -- but one that
  // IS supplied and isn't a recognized value is rejected outright rather than silently coerced to
  // 'whole', so a forged/garbage value can never be misread as a legitimate whole-day request.
  const dayTypeInput = input && input.dayType;
  let dayType;
  if (dayTypeInput === undefined || dayTypeInput === null || dayTypeInput === '') {
    dayType = 'whole';
  } else if (DAY_TYPES.has(dayTypeInput)) {
    dayType = dayTypeInput;
  } else {
    return { ok: false, error: 'Invalid leave day type.' };
  }
  const startDate = String((input && (input.startDate ?? input.s)) || '').trim();
  let endDate = String((input && (input.endDate ?? input.e)) || '').trim();

  if (!reason) return { ok: false, error: 'Please provide a reason.' };
  // isValidIsoDate does full calendar-existence validation (2026-02-31, 2026-13-01, 2026-00-10 all
  // fail), not just the YYYY-MM-DD shape -- a regex alone would happily accept every one of those.
  if (!startDate || !isValidIsoDate(startDate)) return { ok: false, error: 'A valid start date is required.', invalidCalendarDate: !!startDate && DATE_RE.test(startDate) };
  if (dayType !== 'whole') endDate = startDate; // half-day always locks end to start, exact client rule
  if (!endDate || !isValidIsoDate(endDate)) return { ok: false, error: 'A valid end date is required.', invalidCalendarDate: !!endDate && DATE_RE.test(endDate) };
  if (endDate < startDate) return { ok: false, error: 'End date cannot be before start date.' };

  // Half-day leave can only be filed on a date the employee is actually scheduled to work -- reuses
  // the exact same rest-day check eligibleLeaveDates() already relies on (schedule adjustments and
  // personal schedules included, via TimekeepingCore.isRestDay), no second schedule engine. Not
  // gated behind employee.shiftId: a personal-schedule-only employee (no assigned shift at all)
  // must still have their configured rest days honored, not silently skipped.
  if (dayType !== 'whole') {
    const shifts = (state.company && state.company.shifts) || [];
    if (TimekeepingCore.isRestDay(employee, startDate, shifts)) {
      return { ok: false, error: 'Half-day leave cannot be filed on a scheduled rest day.' };
    }
    // A half-day split requires an actual AM/PM schedule to split -- an employee with no
    // assigned shift, no personal schedule, and no approved schedule adjustment for this date has
    // nothing for the system to divide into halves (and no way to determine what the "other half"
    // is expected to be), so this is rejected outright rather than silently assuming a split.
    // Whole-day leave has no such requirement and is unaffected.
    if (!TimekeepingCore.scheduleForDate(employee, startDate, shifts)) {
      return { ok: false, error: 'Half-day leave requires a work schedule for the selected date.' };
    }
  }

  const leaveTypes = (state.company && state.company.leaveTypes) || [];
  const t = leaveTypes.find(x => x.name === type && x.active !== false);
  if (!t) return { ok: false, error: 'Invalid leave type.' };

  let days;
  if (dayType !== 'whole') days = 0.5;
  else days = countLeaveWorkingDays(state, employee, startDate, endDate);
  if (!Number.isFinite(days) || days <= 0) {
    return { ok: false, error: dayType === 'whole' ? 'The selected date range has no working days (all rest days). Adjust the dates or file this as a different request.' : 'Number of days must be greater than 0.' };
  }

  const bal = leaveBalanceFor(employee, t.id);
  const balance = Number.isFinite(Number(bal.balance)) ? Number(bal.balance) : 0;
  let paidDays, unpaidDays;
  if (t.paid) {
    paidDays = Math.max(0, Math.min(days, balance));
    unpaidDays = +(days - paidDays).toFixed(3);
  } else {
    paidDays = 0;
    unpaidDays = days;
  }

  const needsAcknowledgment = days > balance;
  if (needsAcknowledgment && acknowledgeShortfall !== true) {
    return {
      ok: false, needsAcknowledgment: true,
      error: t.paid
        ? `You have ${balance} day(s) of ${t.name} available. This request for ${days} day(s) will be filed as ${paidDays} paid + ${unpaidDays} UNPAID (exceeds your balance). Continue?`
        : `You only have ${balance} day(s) of ${t.name} available, but requested ${days}. File anyway? HR will need to review the shortfall.`,
      computed: { days, paidDays, unpaidDays }
    };
  }

  // The canonical date/fraction footprint, frozen right now -- see buildLeaveDayAllocation's own
  // comment. Stored on the record so finalization never has to (and never should) silently
  // recompute it against whatever the employee's schedule happens to be by approval time.
  const leaveAllocation = buildLeaveDayAllocation(state, employee, { s: startDate, e: endDate, dayType });

  return {
    ok: true,
    record: {
      type, s: startDate, e: endDate, reason,
      days, paidDays, unpaidDays, dayType,
      halfDayLabel: HALF_DAY_LABELS[dayType] || '',
      leaveAllocation
    }
  };
}

// Exact port of employeeDailyRate(emp) in public/index.html.
function employeeDailyRate(state, employee) {
  const monthly = Number(employee && employee.salaryPM) || 0;
  const divisor = Number((employee && employee.dailyDivisor) || (state.company && state.company.dailyDivisor) || 22);
  return monthly && divisor ? monthly / divisor : Number((employee && employee.rate) || 0);
}

// Exact port of payrollAlreadyClosedFor(emp, date) in public/index.html.
function payrollAlreadyClosedFor(state, employee, date) {
  const periods = state.payPeriods || [];
  const period = periods.find(p => p.groupId === employee.payGroupId && (p.attendanceFrom || p.from) <= date && (p.attendanceTo || p.to) >= date);
  return !!(period && period.status === 'closed');
}

// Extends the original creditLateApprovalDay (empId, date, payItemCode, label) in public/index.html
// with two trailing, backward-compatible parameters:
//   - leaveFraction (default 1): the PAID-LEAVE portion of this date being credited -- amount is
//     always dailyRate * leaveFraction, never a flat full day, so a half-day (0.5) or the tail end
//     of a fractional multi-day balance (e.g. 0.5 of a 1.5-day request) is credited correctly
//     instead of always paying a full daily rate per date touched.
//   - requireClosedPeriod (default true): every EXISTING call site (whole-day leave, and a
//     half-day date whose other half was validly worked) keeps the original "only for a pay period
//     that's already closed" gate untouched -- an open period simply isn't deducted in the first
//     place (attendance stays out of 'absent'), so no correction credit is needed. The one new
//     caller that passes false is a half-day date where the OTHER half was NOT worked: that date's
//     attendance is marked 'absent' (the uncovered half correctly loses pay via the existing,
//     unmodified absence-deduction formula) and this credits back just the 0.5 leave portion,
//     regardless of whether the period has closed yet -- without it, an open period would deduct
//     the whole day for an absence half of which was actually approved, paid leave.
// Returns { created, duplicate, adjustment, legacyMismatch }:
//   - created:true  -- a brand new adjustment was just added (adjustment is the new record).
//   - duplicate:true -- an equivalent adjustment already existed (adjustment is the EXISTING
//     record, not a new one) -- this date already has its credit, just not created THIS call.
//   - legacyMismatch:true (only alongside duplicate:true) -- the existing adjustment's amount
//     doesn't match what THIS fraction would produce (e.g. a full-day amount left over from before
//     this pass, now being re-processed as a half-day) -- flagged for audit/review rather than
//     silently trusting or duplicating it, since blindly creating a second adjustment risks
//     overpaying and silently accepting the mismatch risks underpaying.
//   - all false -- no credit is due at all (period still open and requireClosedPeriod, or no daily rate).
function creditLateApprovalDay(state, employee, leaveRecord, date, payItemCode, label, actorName, leaveFraction, requireClosedPeriod) {
  const fraction = Number.isFinite(Number(leaveFraction)) ? Number(leaveFraction) : 1;
  const gateOnClosedPeriod = requireClosedPeriod !== false;
  if (!(fraction > 0 && fraction <= 1)) return { created: false, duplicate: false, adjustment: null };
  if (!employee || (gateOnClosedPeriod && !payrollAlreadyClosedFor(state, employee, date))) return { created: false, duplicate: false, adjustment: null };
  state.payrollAdjustments = Array.isArray(state.payrollAdjustments) ? state.payrollAdjustments : [];
  const existing = state.payrollAdjustments.find(a => a && a.sourceType === 'leave' && a.sourceLeaveId === leaveRecord.id && a.sourceDate === date && a.payItemCode === payItemCode);
  if (existing) {
    const expectedAmount = +(employeeDailyRate(state, employee) * fraction).toFixed(2);
    const legacyMismatch = Number.isFinite(Number(existing.amount)) && Math.abs(Number(existing.amount) - expectedAmount) > 0.005;
    return { created: false, duplicate: true, adjustment: existing, legacyMismatch };
  }
  const dailyRate = employeeDailyRate(state, employee);
  if (!dailyRate) return { created: false, duplicate: false, adjustment: null };
  const amount = +(dailyRate * fraction).toFixed(2);
  const nextId = state.payrollAdjustments.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
  const todayStr = new Date().toISOString().slice(0, 10);
  const fractionLabel = fraction < 1 ? ` (${fraction} day)` : '';
  const adjustment = {
    id: nextId, empId: employee.id, adjType: label, payItemCode, category: 'earnings', taxable: true, direction: 'income',
    amount,
    reason: `Late-approved ${label}${fractionLabel} for ${date} — original pay period already closed; credited automatically to the next payroll run.`,
    effectiveDate: date, payPeriodId: null, payPeriodLabel: null, addedBy: actorName, status: 'ready', processStatus: 'ready', createdAt: todayStr,
    sourceType: 'leave', sourceLeaveId: leaveRecord.id, sourceDate: date, sourceFraction: fraction
  };
  state.payrollAdjustments.push(adjustment);
  return { created: true, duplicate: false, adjustment };
}

// AM/PM work-segment derivation and other-half validity are now owned entirely by
// TimekeepingCore.splitScheduleIntoHalves/attendanceAgainstSegment (public/timekeeping-core.js) --
// the exact same functions periodSummary() uses to compute payroll-facing late/undertime for these
// dates -- rather than a second, independently-maintained copy here. Two copies of this logic used
// to exist (this file's own halfDaySegments/otherHalfSegment/hasValidOtherHalfWork, plus
// periodSummary's blind full-shift recompute) and could disagree about which half-day dates count
// as validly worked; a single shared implementation makes that impossible.
function otherHalfSegmentForDayType(schedule, dayType) {
  const halves = TimekeepingCore.splitScheduleIntoHalves(schedule);
  if (!halves) return null;
  // half_am leave -> the employee is on leave for the morning, so the OTHER (worked) half is PM;
  // half_pm leave -> the other half is AM.
  return dayType === 'half_am' ? halves.pm : dayType === 'half_pm' ? halves.am : null;
}

// Exact port of markAttendanceForApprovedLeave(l, emp) in public/index.html, operating on
// `state.attendance` via the same shared TimekeepingCore.consolidate/upsert helpers the client
// uses (public/timekeeping-core.js, required by both). A real punch log for the date is left
// untouched and flagged instead of overwritten; otherwise the day is marked 'leave',
// pre-approved (this already went through the leave approval chain -- it doesn't need a second
// attendance approval cycle on top), sourced and reviewed by the server, never the employee's
// original filing payload.
//
// `allocation` is the leave's FROZEN date/fraction footprint (leaveRecord.leaveAllocation, or a
// freshly-derived one for a legacy record -- see finalizeLeaveApproval) rather than a live
// recomputation, so a schedule change between filing and approval can never add or drop a date.
//
// A whole-day entry (fraction:1) keeps the exact prior behavior: the date is marked wholesale
// 'leave' unless a real punch log already exists, in which case it's flagged rather than erased.
//
// A half-day entry (fraction:0.5, dayType set) is handled differently -- issues 4/5/6/7's whole
// point: it must never simply wipe the date to 'leave' the way a whole day does, because half of
// it may be genuinely worked.
//   - If the OTHER half was validly worked (hasValidOtherHalfWork), the existing computed
//     attendance (tin/tout/status from real punches, e.g. 'present'/'late') is left completely
//     alone -- only leaveFraction/leaveDayType metadata is added. Since the record's status is
//     never 'absent', the existing (unmodified) absence-deduction formula already treats this as a
//     fully payable day -- exactly the "0.5 worked + 0.5 leave = 1.0 payable day" rule, achieved
//     without touching payroll math at all.
//   - If the other half was NOT validly worked, any genuine existing tin/tout is still preserved
//     (never blanked out just because it didn't clear the "valid other half" bar), but the record's
//     status becomes 'absent' -- deliberately reusing the existing, unmodified absence-deduction
//     formula so the uncovered half correctly loses pay through the SAME mechanism a normal absence
//     already uses, rather than inventing a new half-pay code path. leaveFraction/leaveDayType
//     metadata still records that 0.5 day was legitimate, audited leave.
// Returns the array of attendance records touched (created or updated), each a live reference
// into state.attendance, so the caller can hand them back to the frontend.
function markAttendanceForApprovedLeave(state, leaveRecord, employee, actorName, allocation) {
  state.attendance = Array.isArray(state.attendance) ? state.attendance : [];
  const shifts = (state.company && state.company.shifts) || [];
  let nextId = state.attendance.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
  const now = new Date().toISOString();
  const touched = [];
  (allocation || []).forEach(entry => {
    const date = entry.date;
    const existing = TimekeepingCore.consolidate(state.attendance, employee.id, date);

    if (entry.fraction >= 1) {
      // Whole-day date -- unchanged prior behavior.
      const hasRealLog = existing && existing.tin && existing.tout && existing.status !== 'leave';
      if (hasRealLog) {
        const flag = `⚠ Overlaps with approved leave (${leaveRecord.type}) — review before payroll.`;
        if (!(existing.notes || '').includes(flag)) {
          touched.push(TimekeepingCore.upsert(state.attendance, employee.id, date, { notes: (existing.notes ? existing.notes + ' · ' : '') + flag }, () => nextId++, actorName));
        }
        return;
      }
      touched.push(TimekeepingCore.upsert(state.attendance, employee.id, date, {
        status: 'leave', tin: '', tout: '',
        notes: 'Approved ' + leaveRecord.type + (leaveRecord.halfDayLabel ? ' — ' + leaveRecord.halfDayLabel : ''),
        source: 'leave-approval', approvalStatus: 'approved', reviewedBy: actorName, reviewedAt: now
      }, () => nextId++, actorName));
      return;
    }

    // Half-day date.
    const schedule = TimekeepingCore.scheduleForDate(employee, date, shifts);
    const segment = otherHalfSegmentForDayType(schedule, entry.dayType);
    // Uses the exact same "belongs to this segment" test periodSummary() uses for its own
    // late/undertime overlay (issues 5/6: a punch pair that only brushes the segment boundary by
    // a minute from a totally different, leave-covered time of day must not qualify) -- so
    // whether the other half "counts as worked" here and how much late/undertime it produces in
    // payroll can never drift out of sync with each other.
    const otherHalfWorked = !!(segment && TimekeepingCore.attendanceAgainstSegment(existing, segment, schedule).valid);
    const halfLabel = HALF_DAY_LABELS[entry.dayType] || 'Half Day';

    if (otherHalfWorked) {
      // Preserve the real punches/status entirely -- just annotate. Never 'absent', so the
      // existing absence-deduction formula already leaves this as a fully payable day.
      const flag = `Approved ${leaveRecord.type} — ${halfLabel} (other half worked — full payable day).`;
      touched.push(TimekeepingCore.upsert(state.attendance, employee.id, date, {
        notes: (existing && existing.notes ? existing.notes + ' · ' : '') + flag,
        leaveFraction: 0.5, leaveDayType: entry.dayType,
        source: existing ? existing.source : 'leave-approval', approvalStatus: 'approved', reviewedBy: actorName, reviewedAt: now
      }, () => nextId++, actorName));
      touched[touched.length - 1].otherHalfWorked = true;
      return;
    }

    // Other half not (validly) worked -- preserve whatever tin/tout may genuinely already exist
    // (never blank them just because they didn't clear the bar), but mark the day 'absent' so the
    // uncovered half correctly loses pay via the existing, unmodified absence-deduction formula.
    const patch = {
      status: 'absent',
      notes: (existing && existing.notes ? existing.notes + ' · ' : '') + `Approved ${leaveRecord.type} — ${halfLabel} (other half not worked).`,
      leaveFraction: 0.5, leaveDayType: entry.dayType,
      source: existing ? existing.source : 'leave-approval', approvalStatus: 'approved', reviewedBy: actorName, reviewedAt: now
    };
    if (!existing) { patch.tin = ''; patch.tout = ''; }
    touched.push(TimekeepingCore.upsert(state.attendance, employee.id, date, patch, () => nextId++, actorName));
    touched[touched.length - 1].otherHalfWorked = false;
  });
  return touched;
}

// Runs the COMPLETE set of leave-finalization side effects that actLeave() (public/index.html)
// used to perform client-side after a final approval: leave balance deduction, mirroring the
// approved days into Attendance, and late-approval payroll crediting for any date whose pay period
// had already closed. Called from inside POST /api/leaves/:id/decision's own mutateAppState
// transaction, ONLY when the decision just became final and approved -- everything here commits
// or rolls back together with the approval decision itself, and (per the state-transition rules
// enforced before this is ever reached) can only ever run once per leave record.
function finalizeLeaveApproval(state, leaveRecord, actorName) {
  const users = state.users || [];
  const employee = users.find(u => u.id === leaveRecord.eid);
  if (!employee) {
    return {
      balanceDeducted: 0, employee: null, attendanceRecords: [], payrollAdjustments: [], balanceRecalculated: false,
      duplicateAdjustmentsSkipped: 0, allocationDerivedAtApproval: false, scheduleChangedSinceFiling: false, legacyAdjustmentMismatches: 0
    };
  }

  const leaveTypes = (state.company && state.company.leaveTypes) || [];
  const t = leaveTypes.find(x => x.name === leaveRecord.type);

  // Total requested days never changes at approval time (it's a function of the calendar/schedule,
  // fixed at filing) -- older records that predate the paid/unpaid split fall back to their own
  // days field, same as before.
  const requestedDays = Number.isFinite(Number(leaveRecord.days))
    ? Number(leaveRecord.days)
    : (Number(leaveRecord.paidDays) || 0) + (Number(leaveRecord.unpaidDays) || 0);
  const originallyFiledPaidDays = leaveRecord.paidDays !== undefined ? Number(leaveRecord.paidDays) : requestedDays;
  const originallyFiledUnpaidDays = Number(leaveRecord.unpaidDays) || 0;

  // The frozen date/fraction footprint -- use it exactly as stored (issue 13: a schedule change
  // between filing and approval must never silently add or drop a date). Older pending records
  // that predate this footprint concept get one derived here, ONCE, using today's best-available
  // rules, then persisted onto the record so a retry of this same approval (or an audit later)
  // sees the exact allocation that was actually used -- never re-derived a second time.
  let allocationDerivedAtApproval = false;
  if (!Array.isArray(leaveRecord.leaveAllocation) || !leaveRecord.leaveAllocation.length) {
    leaveRecord.leaveAllocation = buildLeaveDayAllocation(state, employee, { s: leaveRecord.s, e: leaveRecord.e, dayType: leaveRecord.dayType });
    leaveRecord.allocationDerivedAtApproval = true;
    allocationDerivedAtApproval = true;
  }
  const allocation = leaveRecord.leaveAllocation;

  // Purely informational drift signal (issue 13/24): does today's schedule still agree with the
  // footprint that was frozen at filing? The frozen footprint is what's actually used either way --
  // this never changes behavior, it only tells the caller (for audit) whether it should.
  const currentEligibleDates = eligibleLeaveDates(state, employee, leaveRecord.s, leaveRecord.e).join(',');
  const frozenDates = allocation.map(a => a.date).join(',');
  const scheduleChangedSinceFiling = leaveRecord.dayType === 'whole' && currentEligibleDates !== frozenDates;

  // Revalidate the paid/unpaid split against the CURRENT balance, not the balance as it stood at
  // filing time -- two requests filed against the same balance (before either was decided) must
  // not both blindly deduct their originally-filed paidDays, or the balance can go negative. The
  // split can only ever get MORE conservative here (paid days can only shrink, never grow, since
  // requestedDays itself never changes) -- if the current balance still covers the full request,
  // this is a no-op.
  let deductDays = originallyFiledPaidDays;
  let balanceRecalculated = false;
  if (t) {
    const bucket = (employee.leaveBalances && employee.leaveBalances[t.id]) || { balance: 0, adjustments: [] };
    const currentBalance = Number.isFinite(Number(bucket.balance)) ? Number(bucket.balance) : 0;
    let recalculatedPaidDays, recalculatedUnpaidDays;
    if (t.paid) {
      recalculatedPaidDays = Math.max(0, Math.min(requestedDays, currentBalance));
      recalculatedUnpaidDays = +(requestedDays - recalculatedPaidDays).toFixed(3);
    } else {
      recalculatedPaidDays = 0;
      recalculatedUnpaidDays = requestedDays;
    }
    if (recalculatedPaidDays !== originallyFiledPaidDays || recalculatedUnpaidDays !== originallyFiledUnpaidDays) {
      balanceRecalculated = true;
      leaveRecord.balanceRecalculation = {
        originallyFiledPaidDays, originallyFiledUnpaidDays,
        finalPaidDays: recalculatedPaidDays, finalUnpaidDays: recalculatedUnpaidDays,
        recalculatedAt: new Date().toISOString(), recalculatedBy: actorName
      };
    }
    // Update the leave record itself to the recalculated split -- what actually gets applied
    // below (balance deduction, payroll credit) and what the record shows afterward must agree.
    leaveRecord.paidDays = recalculatedPaidDays;
    leaveRecord.unpaidDays = recalculatedUnpaidDays;
    deductDays = recalculatedPaidDays;
  }

  let balanceDeducted = 0;
  if (t && deductDays > 0) {
    employee.leaveBalances = employee.leaveBalances || {};
    const bucket = employee.leaveBalances[t.id] || { balance: 0, adjustments: [] };
    bucket.adjustments = bucket.adjustments || [];
    bucket.adjustments.unshift({
      id: Date.now(), date: new Date().toISOString().slice(0, 10), from: bucket.balance, to: +(bucket.balance - deductDays).toFixed(3),
      reason: 'Leave approved: ' + leaveRecord.s + (leaveRecord.e !== leaveRecord.s ? ' – ' + leaveRecord.e : '') + (leaveRecord.unpaidDays ? ' (' + leaveRecord.unpaidDays + ' filed as unpaid)' : ''),
      by: actorName
    });
    bucket.balance = +(bucket.balance - deductDays).toFixed(3);
    employee.leaveBalances[t.id] = bucket;
    balanceDeducted = deductDays;
  }

  // Attendance still reflects every date in the (frozen) footprint -- all of it, paid or unpaid --
  // the employee is still on approved leave for the full requested span. Half-day dates get the
  // AM/PM-aware treatment (preserve real work, full payable day when earned); whole-day dates keep
  // the exact prior behavior.
  const attendanceRecords = markAttendanceForApprovedLeave(state, leaveRecord, employee, actorName, allocation);
  const attendanceByDate = new Map(attendanceRecords.map(r => [r.date, r]));

  // Fractional payroll crediting (issues 1/2/8/9/10/19/20): walk the frozen footprint, consuming
  // the revalidated paid total in order -- a date only ever gets credited dailyRate*itsOwnFraction,
  // never a flat full day regardless of how small that fraction is.
  const paidAllocation = allocatePaidFraction(allocation, deductDays);
  const payrollAdjustments = [];
  let duplicateAdjustmentsSkipped = 0;
  let legacyAdjustmentMismatches = 0;
  if (t && t.paid) {
    for (const entry of paidAllocation) {
      if (entry.paidFraction <= 0) continue;
      const att = attendanceByDate.get(entry.date);
      // A half-day date whose other half was NOT worked needs its 0.5 leave portion credited
      // regardless of whether the pay period has closed yet -- see creditLateApprovalDay's own
      // comment for why (its attendance was just marked 'absent', which an OPEN period's own
      // future run would otherwise deduct in full). Every other case (whole-day dates, and a
      // half-day date whose other half WAS worked -- already a fully payable day with no
      // deduction to correct) keeps the original closed-period-only gate untouched.
      const requireClosedPeriod = !(entry.dayType && att && att.otherHalfWorked === false);
      const result = creditLateApprovalDay(state, employee, leaveRecord, entry.date, 'LEAVE_PAY', 'Approved Leave (' + leaveRecord.type + ')', actorName, entry.paidFraction, requireClosedPeriod);
      if (result.created) {
        payrollAdjustments.push(result.adjustment);
      } else if (result.duplicate) {
        duplicateAdjustmentsSkipped++;
        if (result.legacyMismatch) legacyAdjustmentMismatches++;
      }
    }
  }

  return {
    balanceDeducted, employee, attendanceRecords, payrollAdjustments, balanceRecalculated, duplicateAdjustmentsSkipped,
    allocationDerivedAtApproval, scheduleChangedSinceFiling, legacyAdjustmentMismatches
  };
}

// The leave-decision response used to hand back the ENTIRE finalized employee record (everything
// but the password hash) so an approver's UI could refresh the leave balance it just changed --
// but an employee-role manager holding only `leave_approve` has no business receiving that
// employee's salary, government IDs, bank details, or any other compensation/personal field just
// because they approved a leave request. This is the one thing finalizeLeaveApproval's
// side-effect actually changes on the employee record that the approving UI needs back, and
// nothing else -- deliberately NOT reusing buildScopedStateForEmployee's own directory/self
// projections (state-serialization.js), since those are a different concern (what a whole SESSION
// may see) and don't even include leaveBalances at all. Same minimal shape for every caller,
// admin included -- nothing about finalizing a leave needs more than this, regardless of who did it.
function projectLeaveDecisionEmployeeForSession(employee) {
  if (!employee) return null;
  return { id: employee.id, leaveBalances: employee.leaveBalances || {} };
}

// The safe, minimal projection of an attendance record touched by leave finalization -- everything
// a leave-only approver (no att_edit, no payroll) is entitled to know: which record, whose, what
// date, its resulting status, and the half-day metadata if any. Deliberately excludes tin/tout/
// punches/ot/nd/undertimeMinutes/edits/notes -- an approver's leave_approve permission has nothing
// to do with visibility into a subordinate's raw time logs or edit history.
function projectAttendancePatchForSession(record) {
  return { id: record.id, eid: record.eid, date: record.date, status: record.status, leaveFraction: record.leaveFraction, leaveDayType: record.leaveDayType };
}

module.exports = {
  isValidIsoDate,
  countLeaveWorkingDays, leaveBalanceFor, leaveDateRange, eligibleLeaveDates, calculateLeaveRequest,
  buildLeaveDayAllocation, allocatePaidFraction,
  employeeDailyRate, payrollAlreadyClosedFor, creditLateApprovalDay, markAttendanceForApprovedLeave,
  finalizeLeaveApproval, projectLeaveDecisionEmployeeForSession, projectAttendancePatchForSession
};
