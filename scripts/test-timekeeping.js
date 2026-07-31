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

console.log('Timekeeping core tests passed.');
