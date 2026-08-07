(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TimekeepingCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function active(record) {
    return !!record && record.superseded !== true && record.active !== false;
  }

  function recordsForDate(records, employeeId, date) {
    return (records || []).filter(function (record) {
      return active(record) && record.eid === employeeId && record.date === date;
    });
  }

  function recordRank(record) {
    var score = 0;
    if (record.tin) score += 2;
    if (record.tout) score += 2;
    if (record.approvalStatus === 'approved') score += 4;
    if (record.source === 'web-bundy' || record.source === 'zkteco-realtime' || record.source === 'zkteco-import') score += 1;
    return score;
  }

  function canonicalRecord(records, employeeId, date) {
    var matches = recordsForDate(records, employeeId, date);
    matches.sort(function (left, right) {
      var rank = recordRank(right) - recordRank(left);
      if (rank) return rank;
      return Number(left.id || 0) - Number(right.id || 0);
    });
    return matches[0] || null;
  }

  function appendUniqueNote(target, note) {
    if (!note) return target || '';
    var notes = String(target || '').split(' · ').filter(Boolean);
    if (notes.indexOf(note) < 0) notes.push(note);
    return notes.join(' · ');
  }

  function consolidate(records, employeeId, date) {
    var matches = recordsForDate(records, employeeId, date);
    if (!matches.length) return null;
    var primary = canonicalRecord(records, employeeId, date);
    var mergedIds = Array.isArray(primary.mergedRecordIds) ? primary.mergedRecordIds.slice() : [];
    matches.forEach(function (record) {
      if (record === primary) return;
      if (!primary.tin && record.tin) primary.tin = record.tin;
      if (!primary.tout && record.tout) primary.tout = record.tout;
      primary.ot = Math.max(Number(primary.ot || 0), Number(record.ot || 0));
      primary.nd = Math.max(Number(primary.nd || 0), Number(record.nd || 0));
      primary.undertimeMinutes = Math.max(Number(primary.undertimeMinutes || 0), Number(record.undertimeMinutes || 0));
      primary.notes = appendUniqueNote(primary.notes, record.notes);
      if (mergedIds.indexOf(record.id) < 0) mergedIds.push(record.id);
      record.superseded = true;
      record.active = false;
      record.supersededBy = primary.id;
    });
    if (mergedIds.length) primary.mergedRecordIds = mergedIds;
    return primary;
  }

  function upsert(records, employeeId, date, patch, nextId) {
    var record = consolidate(records, employeeId, date);
    if (!record) {
      record = { id: nextId(), eid: employeeId, date: date, tin: '', tout: '', status: 'present', ot: 0, nd: 0, notes: '' };
      records.push(record);
    }
    Object.keys(patch || {}).forEach(function (key) {
      if (typeof patch[key] !== 'undefined') record[key] = patch[key];
    });
    record.eid = employeeId;
    record.date = date;
    record.active = true;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  function validateLinkedRecord(records, request) {
    if (!request || request.linkedId == null) return null;
    return (records || []).find(function (record) {
      return active(record) && record.id === request.linkedId && record.eid === request.employeeId && record.date === request.requestDate;
    }) || null;
  }

  function canonicalRecords(records) {
    var seen = {};
    return (records || []).filter(active).filter(function (record) {
      var key = record.eid + '|' + record.date;
      if (seen[key] || canonicalRecord(records, record.eid, record.date) !== record) return false;
      seen[key] = true;
      return true;
    });
  }

  function minutes(value) {
    var parts = String(value || '').split(':');
    if (parts.length !== 2) return null;
    var hour = Number(parts[0]);
    var minute = Number(parts[1]);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  }

  function scheduleForDate(employee, date, shifts) {
    var assigned = (shifts || []).find(function (item) { return employee && item.id === employee.shiftId; });
    var approved = (employee && employee.scheduleAdjustments || []).filter(function (adjustment) {
      return adjustment.status === 'approved' && adjustment.from <= date && adjustment.to >= date;
    });
    if (approved.length) {
      var latest = approved[approved.length - 1];
      return { start: latest.start, end: latest.end, graceMinutes: Number(assigned && assigned.graceMinutes || 0), source: 'schedule-adjustment' };
    }
    return assigned ? { start: assigned.start, end: assigned.end, graceMinutes: Number(assigned.graceMinutes || 0), source: 'assigned-shift' } : null;
  }

  function timeToMinutes(value) {
    var parts = String(value || '').split(':');
    if (parts.length < 2) return null;
    var hour = Number(parts[0]);
    var minute = Number(parts[1]);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  }

  function addDaysToDateStr(dateStr, days) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Determine which "shift day" a punch belongs to, using the employee's assigned shift
  // start/end plus a configurable buffer window, so a punch near midnight (e.g. the tail
  // end of an overnight shift) lands on the correct day instead of splitting by raw
  // calendar date. Returns null if the punch falls outside every candidate shift's window
  // — the caller should treat that as needing manual confirmation rather than guess.
  function resolveShiftDay(employee, punchDate, punchTime, shifts, bufferBeforeMinutes, bufferAfterMinutes) {
    var punchMin = timeToMinutes(punchTime);
    if (punchMin == null) return null;
    var before = Number(bufferBeforeMinutes) || 0;
    var after = Number(bufferAfterMinutes) || 0;
    var best = null;
    [-1, 0, 1].forEach(function (offset) {
      var day = addDaysToDateStr(punchDate, offset);
      var sched = scheduleForDate(employee, day, shifts);
      if (!sched) return;
      var shiftStart = timeToMinutes(sched.start);
      var shiftEnd = timeToMinutes(sched.end);
      if (shiftStart == null || shiftEnd == null) return;
      if (shiftEnd <= shiftStart) shiftEnd += 24 * 60; // this shift crosses midnight
      var dayOffsetMin = offset * 24 * 60;
      var windowStart = dayOffsetMin + shiftStart - before;
      var windowEnd = dayOffsetMin + shiftEnd + after;
      if (punchMin >= windowStart && punchMin <= windowEnd) {
        var dist = Math.min(Math.abs(punchMin - (dayOffsetMin + shiftStart)), Math.abs(punchMin - (dayOffsetMin + shiftEnd)));
        if (!best || dist < best.dist) best = { day: day, dist: dist };
      }
    });
    return best ? best.day : null;
  }

  function periodSummary(records, employee, from, to, shifts) {
    var rows = canonicalRecords(records).filter(function (record) {
      return record.eid === employee.id && record.date >= from && record.date <= to && record.approvalStatus !== 'rejected';
    });
    var summary = { records: rows, presentDays: 0, lateMinutes: 0, undertimeMinutes: 0, absentDays: 0, otHours: 0, ndHours: 0, restDayHolidayHours: 0 };
    rows.forEach(function (record) {
      if (record.status === 'present' || record.status === 'late') summary.presentDays += 1;
      if (record.status === 'absent') summary.absentDays += 1;
      summary.otHours += Number(record.ot || 0);
      summary.ndHours += Number(record.nd || 0);
      summary.restDayHolidayHours += Number(record.restDayHolidayHours || 0);
      var schedule = scheduleForDate(employee, record.date, shifts);
      var actualIn = minutes(record.tin);
      var actualOut = minutes(record.tout);
      var shiftIn = schedule && minutes(schedule.start);
      var shiftOut = schedule && minutes(schedule.end);
      var calculatedLate = actualIn != null && shiftIn != null ? Math.max(0, actualIn - shiftIn - Number(schedule.graceMinutes || 0)) : 0;
      var calculatedUndertime = actualOut != null && shiftOut != null ? Math.max(0, shiftOut - actualOut) : 0;
      summary.lateMinutes += Number(record.lateMinutes != null ? record.lateMinutes : calculatedLate);
      summary.undertimeMinutes += Math.max(Number(record.undertimeMinutes || 0), calculatedUndertime);
    });
    Object.keys(summary).forEach(function (key) {
      if (key !== 'records' && typeof summary[key] === 'number') summary[key] = Math.round(summary[key] * 100) / 100;
    });
    return summary;
  }

  return {
    active: active,
    recordsForDate: recordsForDate,
    canonicalRecord: canonicalRecord,
    canonicalRecords: canonicalRecords,
    consolidate: consolidate,
    upsert: upsert,
    validateLinkedRecord: validateLinkedRecord,
    scheduleForDate: scheduleForDate,
    resolveShiftDay: resolveShiftDay,
    periodSummary: periodSummary
  };
});
