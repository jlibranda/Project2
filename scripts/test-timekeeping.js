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

console.log('Timekeeping core tests passed.');
