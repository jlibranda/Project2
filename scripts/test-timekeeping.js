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

console.log('Timekeeping core tests passed.');
