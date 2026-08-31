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

// Exact port of countLeaveWorkingDays(startStr, endStr) in public/index.html -- calendar days in
// the inclusive range minus the employee's scheduled rest days, or every calendar day if the
// employee has no shift assigned (nothing to check rest days against).
function countLeaveWorkingDays(state, employee, startStr, endStr) {
  if (!startStr || !endStr || endStr < startStr) return 0;
  const shifts = (state.company && state.company.shifts) || [];
  let count = 0;
  let cursor = new Date(startStr + 'T00:00:00Z');
  const last = new Date(endStr + 'T00:00:00Z');
  let guard = 0;
  while (cursor <= last && guard < 3660) { // ~10 years, matches the spirit of leaveDateRange's own 366-day cap
    const ds = cursor.toISOString().slice(0, 10);
    const isRest = (employee && employee.shiftId) ? TimekeepingCore.isRestDay(employee, ds, shifts) : false;
    if (!isRest) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard++;
  }
  return count;
}

// Exact port of leaveBalanceFor(emp, typeId) in public/index.html.
function leaveBalanceFor(employee, typeId) {
  return (employee && employee.leaveBalances && employee.leaveBalances[typeId]) || { balance: 0, adjustments: [] };
}

// Exact port of leaveDateRange(s, e) in public/index.html -- every calendar date from s to e
// inclusive, capped so a bad/huge date range can't loop forever.
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
  const dayType = DAY_TYPES.has(input && input.dayType) ? input.dayType : 'whole';
  const startDate = String((input && (input.startDate ?? input.s)) || '').trim();
  let endDate = String((input && (input.endDate ?? input.e)) || '').trim();

  if (!reason) return { ok: false, error: 'Please provide a reason.' };
  if (!startDate || !DATE_RE.test(startDate)) return { ok: false, error: 'A valid start date is required.' };
  if (dayType !== 'whole') endDate = startDate; // half-day always locks end to start, exact client rule
  if (!endDate || !DATE_RE.test(endDate)) return { ok: false, error: 'A valid end date is required.' };
  if (endDate < startDate) return { ok: false, error: 'End date cannot be before start date.' };

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

  return {
    ok: true,
    record: {
      type, s: startDate, e: endDate, reason,
      days, paidDays, unpaidDays, dayType,
      halfDayLabel: HALF_DAY_LABELS[dayType] || ''
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

// Exact port of creditLateApprovalDay(empId, date, payItemCode, label) in public/index.html,
// operating on `state.payrollAdjustments` instead of the client's PAYROLL_ADJ global. Returns the
// created adjustment record (a live reference into state.payrollAdjustments) iff a credit was
// actually created (period already closed, and the employee has a nonzero daily rate), or null --
// exactly like the client version's true/false, but returning the record itself so the caller can
// hand it back to the frontend instead of the frontend staying unaware a new adjustment now exists.
function creditLateApprovalDay(state, employee, date, payItemCode, label, actorName) {
  if (!employee || !payrollAlreadyClosedFor(state, employee, date)) return null;
  const amount = employeeDailyRate(state, employee);
  if (!amount) return null;
  state.payrollAdjustments = Array.isArray(state.payrollAdjustments) ? state.payrollAdjustments : [];
  const nextId = state.payrollAdjustments.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
  const todayStr = new Date().toISOString().slice(0, 10);
  const adjustment = {
    id: nextId, empId: employee.id, adjType: label, payItemCode, category: 'earnings', taxable: true, direction: 'income',
    amount: +amount.toFixed(2),
    reason: `Late-approved ${label} for ${date} — original pay period already closed; credited automatically to the next payroll run.`,
    effectiveDate: date, payPeriodId: null, payPeriodLabel: null, addedBy: actorName, status: 'ready', processStatus: 'ready', createdAt: todayStr
  };
  state.payrollAdjustments.push(adjustment);
  return adjustment;
}

// Exact port of markAttendanceForApprovedLeave(l, emp) in public/index.html, operating on
// `state.attendance` via the same shared TimekeepingCore.consolidate/upsert helpers the client
// uses (public/timekeeping-core.js, required by both). A real punch log for the date is left
// untouched and flagged instead of overwritten; otherwise the day is marked 'leave',
// pre-approved (this already went through the leave approval chain -- it doesn't need a second
// attendance approval cycle on top), sourced and reviewed by the server, never the employee's
// original filing payload.
// Returns the array of attendance records touched (created or updated), each a live reference
// into state.attendance, so the caller can hand them back to the frontend.
function markAttendanceForApprovedLeave(state, leaveRecord, employee, actorName) {
  state.attendance = Array.isArray(state.attendance) ? state.attendance : [];
  let nextId = state.attendance.reduce((max, r) => Math.max(max, Number(r && r.id) || 0), 0) + 1;
  const now = new Date().toISOString();
  const touched = [];
  leaveDateRange(leaveRecord.s, leaveRecord.e).forEach(date => {
    const existing = TimekeepingCore.consolidate(state.attendance, employee.id, date);
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
  if (!employee) return { balanceDeducted: 0, employee: null, attendanceRecords: [], payrollAdjustments: [] };

  const leaveTypes = (state.company && state.company.leaveTypes) || [];
  const t = leaveTypes.find(x => x.name === leaveRecord.type);
  // Older records predate the paid/unpaid split -- deduct the full amount as before, same
  // fallback actLeave() itself used.
  const deductDays = leaveRecord.paidDays !== undefined ? leaveRecord.paidDays : leaveRecord.days;

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

  const attendanceRecords = markAttendanceForApprovedLeave(state, leaveRecord, employee, actorName);

  const payrollAdjustments = [];
  if (t && t.paid && deductDays > 0) {
    let credited = 0;
    for (const date of leaveDateRange(leaveRecord.s, leaveRecord.e)) {
      if (credited >= deductDays) break;
      const adjustment = creditLateApprovalDay(state, employee, date, 'LEAVE_PAY', 'Approved Leave (' + leaveRecord.type + ')', actorName);
      if (adjustment) {
        credited++;
        payrollAdjustments.push(adjustment);
      }
    }
  }

  return { balanceDeducted, employee, attendanceRecords, payrollAdjustments };
}

module.exports = {
  countLeaveWorkingDays, leaveBalanceFor, leaveDateRange, calculateLeaveRequest,
  employeeDailyRate, payrollAlreadyClosedFor, creditLateApprovalDay, markAttendanceForApprovedLeave,
  finalizeLeaveApproval
};
