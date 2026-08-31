'use strict';

const assert = require('node:assert/strict');
const core = require('../public/timekeeping-core.js');

let nextId = 4;
const records = [
  { id: 1, eid: 7, date: '2026-08-01', tin: '08:00', tout: '', status: 'present', notes: 'Bundy' },
  { id: 2, eid: 7, date: '2026-08-01', tin: '', tout: '18:00', status: 'present', notes: 'Manual' },
  { id: 3, eid: 8, date: '2026-08-01', tin: '08:15', tout: '16:30', status: 'late', ot: 0, nd: 0 }
];

const merged = core.upsert(records, 7, '2026-08-01', { ot: 1.5 }, () => nextId++);
assert.equal(merged.eid, 7);
assert.equal(merged.date, '2026-08-01');
assert.equal(merged.tin, '08:00');
assert.equal(merged.tout, '18:00');
assert.equal(merged.ot, 1.5);
assert.equal(core.recordsForDate(records, 7, '2026-08-01').length, 1, 'duplicates must be superseded without being deleted');

assert.equal(core.validateLinkedRecord(records, { linkedId: merged.id, employeeId: 8, requestDate: '2026-08-01' }), null, 'a request cannot update another employee');
assert.equal(core.validateLinkedRecord(records, { linkedId: merged.id, employeeId: 7, requestDate: '2026-08-02' }), null, 'a request cannot update another date');

const employee = {
  id: 8,
  shiftId: 1,
  scheduleAdjustments: [{ id: 10, from: '2026-08-01', to: '2026-08-01', start: '09:00', end: '18:00', status: 'approved' }]
};
const shifts = [{ id: 1, start: '08:00', end: '17:00', graceMinutes: 10 }];
records[2].undertimeMinutes = 30;
records[2].ot = 2;
const summary = core.periodSummary(records, employee, '2026-08-01', '2026-08-01', shifts);
assert.equal(summary.presentDays, 1);
assert.equal(summary.lateMinutes, 0, 'approved schedule adjustments must control late computation');
assert.equal(summary.undertimeMinutes, 90, 'the larger actual undertime must be used without double counting the request');
assert.equal(summary.otHours, 2);

// scheduleType 'exempted' — late/undertime/OT must be zeroed even with a real late arrival and
// early departure, but tin/tout/hoursWorked are still derived (informational).
const normalSchedule = { start: '08:00', end: '17:00', breakStart: '12:00', breakEnd: '13:00', graceMinutes: 0 };
const latePunches = [{ time: '09:00' }, { time: '16:00' }];
const normalComputed = core.computeFromPunches(latePunches, normalSchedule, false, 'normal');
assert.equal(normalComputed.lateMinutes, 60, 'sanity check: a normal schedule employee is late here');
assert.equal(normalComputed.undertimeMinutes, 60, 'sanity check: a normal schedule employee is undertime here');
const exemptedComputed = core.computeFromPunches(latePunches, normalSchedule, false, 'exempted');
assert.equal(exemptedComputed.lateMinutes, 0, 'an exempted employee must never show late minutes');
assert.equal(exemptedComputed.undertimeMinutes, 0, 'an exempted employee must never show undertime minutes');
assert.equal(exemptedComputed.ot, 0, 'an exempted employee must never show OT hours');
assert.equal(exemptedComputed.tin, '09:00', 'the actual time log is still kept, informationally');
assert.equal(exemptedComputed.tout, '16:00');
assert.equal(exemptedComputed.hoursWorked, 6, 'hoursWorked is still derived (7h span minus 1h break)');

// periodSummary must not recompute late/undertime from the schedule for an exempted employee
// either — the record itself already carries stored zeros, and the schedule-vs-actual fallback
// used for pre-engine records must not silently reintroduce them.
const exemptedEmployee = { id: 9, shiftId: 1 };
const exemptedRecords = [{ id: 20, eid: 9, date: '2026-08-01', tin: '09:00', tout: '16:00', status: 'present', lateMinutes: 0, undertimeMinutes: 0, ot: 0 }];
const baselineSummary = core.periodSummary(exemptedRecords, exemptedEmployee, '2026-08-01', '2026-08-01', shifts);
assert.equal(baselineSummary.lateMinutes, 50, 'sanity check: without scheduleType, periodSummary recomputes late minutes from schedule vs actual');
assert.equal(baselineSummary.undertimeMinutes, 60, 'sanity check: without scheduleType, periodSummary recomputes undertime from schedule vs actual');
exemptedEmployee.scheduleType = 'exempted';
const exemptedSummary2 = core.periodSummary(exemptedRecords, exemptedEmployee, '2026-08-01', '2026-08-01', shifts);
assert.equal(exemptedSummary2.lateMinutes, 0, 'periodSummary must not recompute late minutes for an exempted employee');
assert.equal(exemptedSummary2.undertimeMinutes, 0, 'periodSummary must not recompute undertime for an exempted employee');

// scheduleType 'flexDay' — never late (no fixed shift start to compare against), and
// Undertime/OT compare net worked hours against a flat 8-hour daily requirement instead of a
// fixed shift end time.
const shortDayPunches = [{ time: '10:00' }, { time: '15:00' }]; // 5h span, no break punches/schedule break -> 5h net, 3h short of 8
const flexDayShort = core.computeFromPunches(shortDayPunches, normalSchedule, false, 'flexDay');
assert.equal(flexDayShort.lateMinutes, 0, 'flexDay is never late, even starting well after a shift-style schedule start');
assert.equal(flexDayShort.hoursWorked, 4, '5h span minus the 1h scheduled break (10-15 overlaps 12-13) = 4h net');
assert.equal(flexDayShort.undertimeMinutes, 240, 'undertime = 8h requirement - 4h net = 4h = 240 min');
assert.equal(flexDayShort.ot, 0);

const longDayPunches = [{ time: '07:00' }, { time: '18:00' }]; // 11h span - 1h break = 10h net, 2h over 8
const flexDayLong = core.computeFromPunches(longDayPunches, normalSchedule, false, 'flexDay');
assert.equal(flexDayLong.lateMinutes, 0);
assert.equal(flexDayLong.hoursWorked, 10);
assert.equal(flexDayLong.undertimeMinutes, 0, 'no undertime once net hours meet or exceed the 8h requirement');
assert.equal(flexDayLong.ot, 2, 'OT = 10h net - 8h requirement = 2h');

// periodSummary must trust the stored (flexDay-computed) fields too, not re-derive late/undertime
// from schedule.start/end the way it would for a normal-schedule employee.
const flexDayEmployee = { id: 11, shiftId: 1, scheduleType: 'flexDay' };
const flexDayRecords = [{ id: 21, eid: 11, date: '2026-08-01', tin: '10:00', tout: '15:00', status: 'present', lateMinutes: 0, undertimeMinutes: 240, ot: 0 }];
const flexDaySummary = core.periodSummary(flexDayRecords, flexDayEmployee, '2026-08-01', '2026-08-01', shifts);
assert.equal(flexDaySummary.lateMinutes, 0, 'periodSummary must not recompute late minutes for a flexDay employee from schedule.start');
assert.equal(flexDaySummary.undertimeMinutes, 240, 'periodSummary must keep the stored flexDay undertime, not the schedule-vs-actual figure');

// scheduleType 'flexWeek' — per day, never late and never shows Undertime/OT (settled weekly
// instead), even with a real late arrival/early departure.
const flexWeekDayComputed = core.computeFromPunches(latePunches, normalSchedule, false, 'flexWeek');
assert.equal(flexWeekDayComputed.lateMinutes, 0);
assert.equal(flexWeekDayComputed.undertimeMinutes, 0, 'flexWeek never shows undertime per day -- only once the week is settled');
assert.equal(flexWeekDayComputed.ot, 0, 'flexWeek never shows OT per day -- only once the week is settled');
assert.equal(flexWeekDayComputed.tin, '09:00', 'the actual time log is still kept per day');
assert.equal(flexWeekDayComputed.hoursWorked, 6);

// weekStartForDate: 2026-08-03 is a Monday, 2026-08-09 the following Sunday.
assert.equal(core.weekStartForDate('2026-08-06', 'mon'), '2026-08-03', 'a Thursday belongs to the Monday-starting week');
assert.equal(core.weekStartForDate('2026-08-09', 'mon'), '2026-08-03', 'Sunday still belongs to the same Monday-starting week');
assert.equal(core.weekStartForDate('2026-08-03', 'mon'), '2026-08-03', 'Monday itself is its own week start');
assert.equal(core.weekStartForDate('2026-08-06', 'sun'), '2026-08-02', 'with Sunday as the configured week start, Thursday belongs to the week starting the previous Sunday');

// flexWeekRequiredMinutes: a 5-day (Mon-Fri) personal schedule requires 5 x 8h = 2400 min/week;
// a 6-day (Mon-Sat) one requires 6 x 8h = 2880 min/week.
const workDay = { restDay: false, start: '08:00', end: '17:00', breakStart: '12:00', breakEnd: '13:00' };
const restDay = { restDay: true, start: '', end: '', breakStart: '', breakEnd: '' };
const fiveDayEmployee = {
  id: 12, scheduleType: 'flexWeek',
  personalSchedule: { mon: workDay, tue: workDay, wed: workDay, thu: workDay, fri: workDay, sat: restDay, sun: restDay }
};
const sixDayEmployee = {
  id: 13, scheduleType: 'flexWeek',
  personalSchedule: { mon: workDay, tue: workDay, wed: workDay, thu: workDay, fri: workDay, sat: workDay, sun: restDay }
};
assert.equal(core.flexWeekRequiredMinutes(fiveDayEmployee, '2026-08-03', shifts), 2400, '5-day workweek: 5 x 8h = 40h = 2400 min');
assert.equal(core.flexWeekRequiredMinutes(sixDayEmployee, '2026-08-03', shifts), 2880, '6-day workweek: 6 x 8h = 48h = 2880 min');

// periodSummary settles a flexWeek employee's Undertime/OT once, for the whole week, only once
// the period's `to` covers that week's last day (2026-08-09) -- never partially, never twice.
const weekDates = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];
const shortWeekRecords = weekDates.map((d, i) => ({ id: 200 + i, eid: 12, date: d, tin: '08:00', tout: '15:30', status: 'present', lateMinutes: 0, undertimeMinutes: 0, ot: 0, hoursWorked: 7.5 }));
const midWeekSummary = core.periodSummary(shortWeekRecords, fiveDayEmployee, '2026-08-01', '2026-08-07', shifts, [], 'mon');
assert.equal(midWeekSummary.undertimeMinutes, 0, 'a week not yet concluded within [from,to] must not be settled yet');
assert.equal(midWeekSummary.otHours, 0);
const fullWeekSummary = core.periodSummary(shortWeekRecords, fiveDayEmployee, '2026-08-01', '2026-08-09', shifts, [], 'mon');
assert.equal(fullWeekSummary.undertimeMinutes, 150, '5 x 7.5h = 37.5h net vs 40h required = 2.5h = 150 min undertime');
assert.equal(fullWeekSummary.otHours, 0);
assert.equal(fullWeekSummary.lateMinutes, 0, 'flexWeek is never late even when settled');

const longWeekRecords = weekDates.map((d, i) => ({ id: 300 + i, eid: 12, date: d, tin: '07:00', tout: '16:48', status: 'present', lateMinutes: 0, undertimeMinutes: 0, ot: 0, hoursWorked: 8.8 }));
const otWeekSummary = core.periodSummary(longWeekRecords, fiveDayEmployee, '2026-08-01', '2026-08-09', shifts, [], 'mon');
assert.equal(otWeekSummary.undertimeMinutes, 0);
assert.equal(otWeekSummary.otHours, 4, '5 x 8.8h = 44h net vs 40h required = 4h OT');

// flexWeekSummary now also exposes a per-week breakdown (used by Fixed Amount OT tiers, which
// must apply per settled week, not to the whole period's OT lumped together).
const twoWeekDates = [
  '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', // week 1: Mon-Fri
  '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'  // week 2: Mon-Fri
];
const twoWeekRecords = twoWeekDates.map((d, i) => ({
  id: 500 + i, eid: 12, date: d, tin: '07:00', tout: i < 5 ? '16:48' : '15:30', status: 'present',
  lateMinutes: 0, undertimeMinutes: 0, ot: 0, hoursWorked: i < 5 ? 8.8 : 7.5
}));
const twoWeekSummary = core.periodSummary(twoWeekRecords, fiveDayEmployee, '2026-08-01', '2026-08-16', shifts, [], 'mon');
assert.equal(twoWeekSummary.weeks, undefined, 'periodSummary itself keeps returning only the aggregate shape');
const twoWeekFlex = core.flexWeekSummary(twoWeekRecords, fiveDayEmployee, '2026-08-01', '2026-08-16', shifts, 'mon');
assert.equal(twoWeekFlex.weeks.length, 2, 'both fully-concluded weeks are broken out individually');
assert.equal(twoWeekFlex.weeks[0].otHours, 4, 'week 1: 5 x 8.8h = 44h vs 40h required = 4h OT');
assert.equal(twoWeekFlex.weeks[0].undertimeMinutes, 0);
assert.equal(twoWeekFlex.weeks[1].otHours, 0);
assert.equal(twoWeekFlex.weeks[1].undertimeMinutes, 150, 'week 2: 5 x 7.5h = 37.5h vs 40h required = 2.5h undertime');
assert.equal(twoWeekFlex.otHours, 4, 'aggregate total is unaffected by the added breakdown');

// A schedule type other than 'flexWeek' must still get an (empty) weeks array, not undefined,
// so callers can always safely read .weeks without a type check.
const normalFlexWeekResult = core.flexWeekSummary(records, employee, '2026-08-01', '2026-08-01', shifts, 'mon');
assert.deepEqual(normalFlexWeekResult.weeks, [], 'non-flexWeek employees get an empty weeks array, not undefined');

// ── Sixth-pass: half-day-leave-aware effective work segment + late/undertime overlay ─────────
// (issues 1-14, 18, 20-27). Shift 09:00-18:00, break 12:00-13:00, no grace.
const halfDaySchedule = { start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00', graceMinutes: 0 };
const halfDayHalves = core.splitScheduleIntoHalves(halfDaySchedule);
assert.deepEqual(halfDayHalves, { am: { start: '09:00', end: '12:00' }, pm: { start: '13:00', end: '18:00' } }, 'issue 3/4: an explicit break IS the AM/PM split point');

// Issue 4: no explicit break configured -- split at the true midpoint of the shift's duration,
// not a guessed fixed boundary.
const noBreakSchedule = { start: '08:00', end: '16:00', breakStart: '', breakEnd: '', graceMinutes: 0 };
assert.deepEqual(core.splitScheduleIntoHalves(noBreakSchedule), { am: { start: '08:00', end: '12:00' }, pm: { start: '12:00', end: '16:00' } }, 'issue 4: no-break schedule splits at the exact midpoint of shift duration');

// Issue 18: overnight shift (22:00-06:00, no break) -- must not treat 06:00 < 22:00 as negative,
// and must split at the true midpoint across midnight.
const overnightSchedule = { start: '22:00', end: '06:00', breakStart: '', breakEnd: '', graceMinutes: 0 };
assert.deepEqual(core.splitScheduleIntoHalves(overnightSchedule), { am: { start: '22:00', end: '02:00' }, pm: { start: '02:00', end: '06:00' } }, 'issue 18: overnight shift splits correctly across midnight');

// Issue 2: the anti-forgery gate -- only a genuinely approved half-day-leave record (all three
// fields present and correct) qualifies; any forged/partial combination must not.
assert.equal(core.isApprovedHalfDayLeaveRecord({ approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am' }), true);
assert.equal(core.isApprovedHalfDayLeaveRecord({ approvalStatus: 'pending', leaveFraction: 0.5, leaveDayType: 'half_am' }), false, 'issue 2: not-yet-approved leave metadata must not activate the overlay');
assert.equal(core.isApprovedHalfDayLeaveRecord({ approvalStatus: 'approved', leaveFraction: 1, leaveDayType: 'half_am' }), false, 'issue 2: leaveFraction must be exactly 0.5');
assert.equal(core.isApprovedHalfDayLeaveRecord({ approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'whole' }), false, 'issue 2: leaveDayType must be half_am/half_pm');
assert.equal(core.isApprovedHalfDayLeaveRecord(null), false);

const halfAmEmployee = { id: 90, shiftId: 30 };
// Per-day schedule shape (matches real production shift records) -- normalizeShift's translation
// of the older flat {start,end} shape deliberately drops breakStart/breakEnd, which would falsely
// force every one of these tests down the midpoint-fallback path instead of the break-aware one.
const halfDayShiftDay = { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' };
const halfDayShifts = [{
  id: 30, graceMinutes: 0,
  schedule: { mon: halfDayShiftDay, tue: halfDayShiftDay, wed: halfDayShiftDay, thu: halfDayShiftDay, fri: halfDayShiftDay, sat: halfDayShiftDay, sun: halfDayShiftDay }
}];
const approvedHalfAm = { approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am' };
const approvedHalfPm = { approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_pm' };

// Issue 1/3: Half AM leave -> the expected work segment is the PM half (the leave-covered AM
// half is never the "other half" an employee is expected to work).
assert.deepEqual(core.workSegmentForApprovedHalfDayLeave(halfAmEmployee, '2026-08-03', halfDayShifts, approvedHalfAm), { start: '13:00', end: '18:00', segment: 'pm' });
// Half PM leave -> the expected work segment is the AM half.
assert.deepEqual(core.workSegmentForApprovedHalfDayLeave(halfAmEmployee, '2026-08-03', halfDayShifts, approvedHalfPm), { start: '09:00', end: '12:00', segment: 'am' });
// Not an approved half-day-leave record at all -> no segment.
assert.equal(core.workSegmentForApprovedHalfDayLeave(halfAmEmployee, '2026-08-03', halfDayShifts, { approvalStatus: 'pending', leaveFraction: 0.5, leaveDayType: 'half_am' }), null);

// Issue 20: Half AM leave, perfect PM attendance (13:00-18:00) -- zero late, zero undertime.
const pmSegment = core.workSegmentForApprovedHalfDayLeave(halfAmEmployee, '2026-08-03', halfDayShifts, approvedHalfAm);
assert.deepEqual(core.attendanceAgainstSegment({ tin: '13:00', tout: '18:00' }, pmSegment, halfDaySchedule), { valid: true, lateMinutes: 0, undertimeMinutes: 0 }, 'issue 20: perfect PM attendance against Half AM leave produces zero late/undertime');

// Issue 8/22: Half AM leave, PM Time In 13:30 (30 min late), Time Out 18:00 -- late=30, NEVER a
// ~4.5h figure measured against the original 09:00 shift start.
assert.deepEqual(core.attendanceAgainstSegment({ tin: '13:30', tout: '18:00' }, pmSegment, halfDaySchedule), { valid: true, lateMinutes: 30, undertimeMinutes: 0 }, 'issue 8/22: late is measured against the PM segment start, not the full shift start');

// Issue 9/23: Half AM leave, PM Time In 13:00, Time Out 17:00 (left 1h early) -- undertime=60.
assert.deepEqual(core.attendanceAgainstSegment({ tin: '13:00', tout: '17:00' }, pmSegment, halfDaySchedule), { valid: true, lateMinutes: 0, undertimeMinutes: 60 }, 'issue 9/23: undertime is measured against the PM segment end');

// Issue 10/24: Half PM leave, AM Time In 09:30 (30 min late), Time Out 12:00 -- late=30, NOT ~6h.
const amSegment = core.workSegmentForApprovedHalfDayLeave(halfAmEmployee, '2026-08-03', halfDayShifts, approvedHalfPm);
assert.deepEqual(core.attendanceAgainstSegment({ tin: '09:30', tout: '12:00' }, amSegment, halfDaySchedule), { valid: true, lateMinutes: 30, undertimeMinutes: 0 }, 'issue 10/24: late on the AM segment is correctly measured, PM leave stays paid');

// Issue 11/25: Half PM leave, AM Time In 09:00, Time Out 11:00 (left 1h early) -- undertime=60.
assert.deepEqual(core.attendanceAgainstSegment({ tin: '09:00', tout: '11:00' }, amSegment, halfDaySchedule), { valid: true, lateMinutes: 0, undertimeMinutes: 60 }, 'issue 11/25: undertime on the AM segment is correctly measured');

// Issue 5/6/26: Half AM leave, actual punches 09:00-13:01 (the leave-covered AM window, barely
// edging one minute into the PM segment) -- must NOT qualify as valid PM-half work merely
// because the intervals technically overlap by a minute.
assert.deepEqual(core.attendanceAgainstSegment({ tin: '09:00', tout: '13:01' }, pmSegment, halfDaySchedule), { valid: false, lateMinutes: 0, undertimeMinutes: 0 }, 'issue 5/6/26: a one-minute overlap from the leave-covered side does not qualify as valid other-half work');

// Issue 6/27: Half AM leave, partial PM work 14:00-17:00 -- genuinely belongs to the PM segment
// (not a boundary-grazing overlap), so it's valid AND correctly produces both late and undertime,
// never an automatic "not worked" absence.
assert.deepEqual(core.attendanceAgainstSegment({ tin: '14:00', tout: '17:00' }, pmSegment, halfDaySchedule), { valid: true, lateMinutes: 60, undertimeMinutes: 60 }, 'issue 6/27: partial worked-half attendance is evaluated against the correct segment, producing both late and undertime');

// No attendance at all for the other half -- invalid, no late/undertime overlay contribution
// (issue 12's "uncovered other half follows existing absence rules" is enforced elsewhere, by
// leave-service.js marking the record status:'absent'; this function only reports validity).
assert.deepEqual(core.attendanceAgainstSegment({ tin: '', tout: '' }, pmSegment, halfDaySchedule), { valid: false, lateMinutes: 0, undertimeMinutes: 0 });

// Issue 1/2/7: periodSummary() end-to-end -- an approved Half AM leave record with perfect PM
// attendance must contribute ZERO late/undertime to the period summary, bypassing the stale
// full-shift-based stored lateMinutes a punch-ingestion-time computation might have left behind
// (the exact bug this pass fixes: computeFromPunches, run before the leave was ever approved,
// would have measured 13:00 against the full 09:00 shift start and stored a ~4h "late" figure).
const halfAmRecordPerfect = {
  id: 400, eid: 90, date: '2026-08-03', tin: '13:00', tout: '18:00', status: 'present',
  approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am',
  lateMinutes: 240, undertimeMinutes: 0, ot: 0, nd: 0 // stale full-shift-based stored value
};
const halfAmSummaryPerfect = core.periodSummary([halfAmRecordPerfect], halfAmEmployee, '2026-08-03', '2026-08-03', halfDayShifts);
assert.equal(halfAmSummaryPerfect.lateMinutes, 0, 'issue 7: periodSummary must not use the stale stored late figure for an approved half-day-leave record');
assert.equal(halfAmSummaryPerfect.undertimeMinutes, 0);
assert.equal(halfAmSummaryPerfect.absentDays, 0, 'issue 7: a present-status half-day-leave record with perfect other-half work is never counted absent');

// Issue 8: same record, but PM Time In is 13:30 (late) -- periodSummary must report exactly 30
// late minutes, never a stale/full-shift-based figure.
const halfAmRecordLate = { ...halfAmRecordPerfect, tin: '13:30', lateMinutes: 270 };
const halfAmSummaryLate = core.periodSummary([halfAmRecordLate], halfAmEmployee, '2026-08-03', '2026-08-03', halfDayShifts);
assert.equal(halfAmSummaryLate.lateMinutes, 30, 'issue 8: periodSummary reports exactly 30 late minutes for a Half AM record late by 30 minutes on the worked half');
assert.equal(halfAmSummaryLate.undertimeMinutes, 0);

// Issue 9: same record, but PM Time Out is 17:00 (left early) -- periodSummary must report
// exactly 60 undertime minutes.
const halfAmRecordUndertime = { ...halfAmRecordPerfect, tout: '17:00', lateMinutes: 0, undertimeMinutes: 60 };
const halfAmSummaryUndertime = core.periodSummary([halfAmRecordUndertime], halfAmEmployee, '2026-08-03', '2026-08-03', halfDayShifts);
assert.equal(halfAmSummaryUndertime.lateMinutes, 0);
assert.equal(halfAmSummaryUndertime.undertimeMinutes, 60, 'issue 9: periodSummary reports exactly 60 undertime minutes for a Half AM record short by 60 minutes on the worked half');

// A record that is NOT approved half-day leave must be completely unaffected -- normal full-shift
// late/undertime recompute still applies exactly as before this pass.
const normalHalfDayShiftRecord = { id: 401, eid: 90, date: '2026-08-04', tin: '09:20', tout: '17:45', status: 'present', lateMinutes: 0, undertimeMinutes: 0, ot: 0 };
const normalSummary = core.periodSummary([normalHalfDayShiftRecord], halfAmEmployee, '2026-08-04', '2026-08-04', halfDayShifts);
assert.equal(normalSummary.lateMinutes, 20, 'a normal (non-half-day-leave) record is completely unaffected by this pass -- still late by 20 minutes against the full shift');
assert.equal(normalSummary.undertimeMinutes, 15, 'a normal (non-half-day-leave) record is completely unaffected -- still undertime by 15 minutes against the full shift');

// ── Follow-up pass: paid/unpaid half-day leave -- unpaidLeaveDays aggregation (issues 3/4/5/6/21).
// Reuses halfAmEmployee/halfDayShifts/halfDaySchedule (shift 09:00-18:00, break 12:00-13:00) from
// the half-day-leave section above.
function unpaidLeaveScenario(date, dayType, tin, tout, status, paidLeaveFraction, unpaidLeaveFraction, absentWorkFraction) {
  return core.periodSummary([{
    id: 900, eid: 90, date, tin, tout, status,
    approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: dayType,
    paidLeaveFraction, unpaidLeaveFraction, absentWorkFraction,
    lateMinutes: 0, undertimeMinutes: 0, ot: 0
  }], halfAmEmployee, date, date, halfDayShifts);
}

// A. Fully paid Half AM + perfect PM work -- no loss anywhere.
let s = unpaidLeaveScenario('2026-08-10', 'half_am', '13:00', '18:00', 'present', 0.5, 0, 0);
assert.equal(s.unpaidLeaveDays, 0, 'A: fully paid + perfect work -> unpaidLeaveDays 0');
assert.equal(s.absentDays, 0, 'A: fully paid + perfect work -> absentDays 0');
assert.equal(s.lateMinutes, 0);
assert.equal(s.undertimeMinutes, 0);

// B. Fully unpaid Half AM + perfect PM work -- the leave half itself is the only loss.
s = unpaidLeaveScenario('2026-08-11', 'half_am', '13:00', '18:00', 'present', 0, 0.5, 0);
assert.equal(s.unpaidLeaveDays, 0.5, 'B: fully unpaid + perfect work -> unpaidLeaveDays 0.5');
assert.equal(s.absentDays, 0, 'B: fully unpaid + perfect work -> absentDays stays 0 (never a full-day absence)');

// C. 0.25 paid / 0.25 unpaid + perfect PM work.
s = unpaidLeaveScenario('2026-08-12', 'half_am', '13:00', '18:00', 'present', 0.25, 0.25, 0);
assert.equal(s.unpaidLeaveDays, 0.25, 'C: 0.25 paid / 0.25 unpaid + perfect work -> unpaidLeaveDays 0.25');
assert.equal(s.absentDays, 0);

// D. Fully paid Half AM + NO PM work -- the existing full-day absence + credit-back mechanism
// (leave-service.js) already nets this to the right payroll total; periodSummary must NOT also
// add a separate unpaidLeaveDays contribution here (double-deduction trap, issue 5).
s = unpaidLeaveScenario('2026-08-13', 'half_am', '', '', 'absent', 0.5, 0, 0.5);
assert.equal(s.unpaidLeaveDays, 0, 'D: fully paid + no work -> unpaidLeaveDays 0 (already covered by the full-day absence + credit-back)');
assert.equal(s.absentDays, 1, 'D: fully paid + no work -> absentDays stays a flat 1 (unchanged existing semantics)');

// E. Fully unpaid Half AM + NO PM work -- the full-day absence alone already deducts the entire
// day; must NOT also add unpaidLeaveDays (would double it to 1.5 days lost).
s = unpaidLeaveScenario('2026-08-14', 'half_am', '', '', 'absent', 0, 0.5, 0.5);
assert.equal(s.unpaidLeaveDays, 0, 'E: fully unpaid + no work -> unpaidLeaveDays 0 (the full-day absence alone already accounts for it)');
assert.equal(s.absentDays, 1, 'E: fully unpaid + no work -> absentDays stays a flat 1, never 1.5 days worth');

// Mirror: Half PM, fully unpaid + perfect AM work.
s = unpaidLeaveScenario('2026-08-17', 'half_pm', '09:00', '12:00', 'present', 0, 0.5, 0);
assert.equal(s.unpaidLeaveDays, 0.5, 'Half PM mirror: fully unpaid + perfect work -> unpaidLeaveDays 0.5');
assert.equal(s.absentDays, 0);

// Partial paid/unpaid + late worked half (issue 14 at the timekeeping-summary level): late/
// undertime on the genuinely-worked half must combine additively with unpaidLeaveDays, never be
// suppressed by it.
s = unpaidLeaveScenario('2026-08-18', 'half_am', '13:30', '18:00', 'present', 0.25, 0.25, 0);
assert.equal(s.unpaidLeaveDays, 0.25, 'issue 14: partial unpaid + late work -> unpaidLeaveDays 0.25');
assert.equal(s.lateMinutes, 30, 'issue 14: partial unpaid + late work -> lateMinutes 30 (measured against the PM segment, unaffected by the paid/unpaid split)');

// Partial paid/unpaid + undertime worked half (issue 15).
s = unpaidLeaveScenario('2026-08-19', 'half_am', '13:00', '17:00', 'present', 0.25, 0.25, 0);
assert.equal(s.unpaidLeaveDays, 0.25, 'issue 15: partial unpaid + undertime work -> unpaidLeaveDays 0.25');
assert.equal(s.undertimeMinutes, 60, 'issue 15: partial unpaid + undertime work -> undertimeMinutes 60');

// Issue 26: a stale status:'absent' record with genuinely valid PM punches, once the segment
// confirms valid other-half work, must be represented with absentWorkFraction:0 (as
// markAttendanceForApprovedLeave now stamps it) -- periodSummary must then treat it exactly like
// any other otherHalfWorked:true record, not as a full-day absence.
s = unpaidLeaveScenario('2026-08-20', 'half_am', '13:00', '18:00', 'present', 0.5, 0, 0);
assert.equal(s.absentDays, 0, "issue 26: a normalized (no-longer-'absent') half-day-leave record with valid other-half work never counts as a full-day absence");

console.log('Timekeeping core tests passed.');
