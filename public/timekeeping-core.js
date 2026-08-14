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

  // Punches are the permanent source-of-truth log: every raw scan/clock event ever received
  // for a day, from every source (ZKTeco realtime push, ZKTeco pull-and-import, Web Bundy).
  // This merge is additive-only — union by (time, source, kind), never truncate or replace —
  // so no caller can accidentally lose a punch just by passing a shorter or older list.
  function mergePunches(existing, incoming) {
    var list = Array.isArray(existing) ? existing.slice() : [];
    var seen = {};
    list.forEach(function (p) { seen[p.time + '|' + p.source + '|' + (p.kind || '')] = true; });
    (incoming || []).forEach(function (p) {
      if (!p || !p.time) return;
      var key = p.time + '|' + p.source + '|' + (p.kind || '');
      if (seen[key]) return;
      seen[key] = true;
      list.push(p);
    });
    list.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
    return list;
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
      primary.punches = mergePunches(primary.punches, record.punches);
      primary.notes = appendUniqueNote(primary.notes, record.notes);
      if (mergedIds.indexOf(record.id) < 0) mergedIds.push(record.id);
      record.superseded = true;
      record.active = false;
      record.supersededBy = primary.id;
    });
    if (mergedIds.length) primary.mergedRecordIds = mergedIds;
    return primary;
  }

  // Fields worth calling out in the edit trail — the ones that change what a record actually
  // means (time worked, pay-affecting hours, status), not bookkeeping fields like source/notes.
  var AUDITED_FIELDS = ['tin', 'tout', 'status', 'ot', 'nd', 'undertimeMinutes', 'restDayHolidayHours'];

  function diffForAudit(record, patch) {
    var changes = {};
    AUDITED_FIELDS.forEach(function (key) {
      if (typeof patch[key] !== 'undefined' && patch[key] !== record[key]) {
        changes[key] = { from: record[key], to: patch[key] };
      }
    });
    return changes;
  }

  // editedBy is optional — omit it for system-driven writes (ZKTeco import's own record of
  // origin already covers those) and pass it for anything a person did through the UI, so
  // corrections to an existing record leave a "who changed what, from what, to what" trail.
  function upsert(records, employeeId, date, patch, nextId, editedBy) {
    var record = consolidate(records, employeeId, date);
    var isNew = !record;
    if (!record) {
      record = { id: nextId(), eid: employeeId, date: date, tin: '', tout: '', status: 'present', ot: 0, nd: 0, notes: '', punches: [] };
      records.push(record);
    }
    // punches is append-only: a patch can only ever grow it (via mergePunches), never replace
    // it with a shorter list — so no write path here can silently drop a previously-captured log.
    var effectivePatch = patch || {};
    if (effectivePatch.punches) {
      effectivePatch = Object.assign({}, effectivePatch, { punches: mergePunches(record.punches, effectivePatch.punches) });
    }
    if (!isNew && editedBy) {
      var changes = diffForAudit(record, effectivePatch);
      if (Object.keys(changes).length) {
        record.edits = record.edits || [];
        record.edits.unshift({ at: new Date().toISOString(), by: editedBy, changes: changes });
      }
    }
    Object.keys(effectivePatch).forEach(function (key) {
      if (typeof effectivePatch[key] !== 'undefined') record[key] = effectivePatch[key];
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

  // Tolerates HH:MM:SS the same way timeToMinutes() below does — some device firmware reports
  // seconds in ATTLOG timestamps, and a stricter parts.length!==2 check here used to silently
  // return null for those, zeroing out periodSummary's lateMinutes/undertimeMinutes totals (the
  // Excel Summary sheet) even when the per-record fields it falls back to were computed fine.
  function minutes(value) {
    var parts = String(value || '').split(':');
    if (parts.length < 2) return null;
    var hour = Number(parts[0]);
    var minute = Number(parts[1]);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  }

  var SHIFT_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  // JS Date#getUTCDay() is 0=Sunday..6=Saturday; this maps that index straight to our keys.
  var GETDAY_TO_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // Older shifts are a single flat {start,end,breakMinutes} applied every day. Normalizing
  // to the newer per-day {schedule:{mon:{...},...,sun:{...}}} shape here means every other
  // function only ever has to handle one shape.
  function normalizeShift(shift) {
    if (!shift) return null;
    if (shift.schedule) return shift;
    var day = { restDay: false, start: shift.start || '', end: shift.end || '', breakStart: '', breakEnd: '' };
    var schedule = {};
    SHIFT_DAY_KEYS.forEach(function (k) { schedule[k] = Object.assign({}, day); });
    return Object.assign({}, shift, { schedule: schedule });
  }

  // A schedule adjustment covering this date, if any — newer adjustments carry a per-day
  // override list (days[], one entry per date in the request, each independently a work day
  // or a rest day); older ones are a single flat start/end applied across their whole date
  // range. Both shapes coexist in saved data, so every reader has to handle both.
  function scheduleAdjustmentForDate(employee, date) {
    var approved = (employee && employee.scheduleAdjustments || []).filter(function (adjustment) {
      return adjustment.status === 'approved' && adjustment.from <= date && adjustment.to >= date;
    });
    if (!approved.length) return null;
    var latest = approved[approved.length - 1];
    var dayOverride = latest.days && latest.days.find(function (d) { return d.date === date; });
    return { adjustment: latest, day: dayOverride || null };
  }

  // A personal schedule (employee.personalSchedule, same {mon:{...},...,sun:{...}} shape as
  // a shift's normalized schedule) is an optional, permanent per-employee override of the
  // shared shift template's day pattern — lets one employee's hours/rest-day differ from
  // everyone else assigned to the same shift without forking a new template just for them.
  // It sits between Schedule Adjustment (temporary, still wins) and the shared shift
  // template (the fallback default when no personal schedule is set).
  function scheduleForDate(employee, date, shifts) {
    var assigned = (shifts || []).find(function (item) { return employee && item.id === employee.shiftId; });
    var found = scheduleAdjustmentForDate(employee, date);
    if (found) {
      if (found.day) {
        if (found.day.isRestDay) return null;
        return { start: found.day.start, end: found.day.end, breakStart: found.day.breakStart || '', breakEnd: found.day.breakEnd || '', graceMinutes: Number(assigned && assigned.graceMinutes || 0), source: 'schedule-adjustment' };
      }
      if (found.adjustment.start && found.adjustment.end) {
        return { start: found.adjustment.start, end: found.adjustment.end, graceMinutes: Number(assigned && assigned.graceMinutes || 0), source: 'schedule-adjustment' };
      }
    }
    var dayKey = GETDAY_TO_KEY[new Date(date + 'T00:00:00Z').getUTCDay()];
    if (employee && employee.personalSchedule) {
      var personalDay = employee.personalSchedule[dayKey];
      if (!personalDay || personalDay.restDay || !personalDay.start || !personalDay.end) return null;
      return { start: personalDay.start, end: personalDay.end, breakStart: personalDay.breakStart || '', breakEnd: personalDay.breakEnd || '', graceMinutes: Number(assigned && assigned.graceMinutes || 0), source: 'personal-schedule' };
    }
    if (!assigned) return null;
    var normalized = normalizeShift(assigned);
    var day = normalized.schedule[dayKey];
    if (!day || day.restDay || !day.start || !day.end) return null; // rest day / not configured — no shift expected
    return { start: day.start, end: day.end, breakStart: day.breakStart || '', breakEnd: day.breakEnd || '', graceMinutes: Number(normalized.graceMinutes || 0), source: 'assigned-shift' };
  }

  // True only when this weekday is explicitly marked as a rest day on the employee's
  // personal schedule (if set) or assigned shift, OR a per-day schedule adjustment
  // explicitly makes it one — unlike scheduleForDate()'s null return, this never conflates
  // "no shift assigned at all" with "designated rest day" (matters for holiday-pay math,
  // where those two cases lead to different pay rules). An approved per-day adjustment
  // overrides everything else in both directions: it can turn a normal rest day into a work
  // day, or vice versa.
  function isRestDay(employee, date, shifts) {
    var found = scheduleAdjustmentForDate(employee, date);
    if (found && found.day) return !!found.day.isRestDay;
    var dayKey = GETDAY_TO_KEY[new Date(date + 'T00:00:00Z').getUTCDay()];
    if (employee && employee.personalSchedule) {
      var personalDay = employee.personalSchedule[dayKey];
      return !!(personalDay && personalDay.restDay);
    }
    var assigned = (shifts || []).find(function (item) { return employee && item.id === employee.shiftId; });
    if (!assigned) return false;
    var normalized = normalizeShift(assigned);
    var day = normalized.schedule[dayKey];
    return !!(day && day.restDay);
  }

  // Maps a holiday calendar entry + whether the date was the employee's rest day to the
  // matching Overtime & Premium Rates code (see OT_RATES in index.html), so payroll can look
  // up the admin-configured percentage instead of a single flat premium for all holiday work.
  // Special Working Holidays intentionally return null — DOLE doesn't mandate extra pay for
  // those, they're just a normal working day.
  function classifyHolidayPremium(employee, date, shifts, holidays) {
    var holiday = (holidays || []).find(function (h) { return h.date === date; });
    if (!holiday || holiday.type === 'special-working') return null;
    if (holiday.type === 'double') return 'DH_8';
    var restDay = isRestDay(employee, date, shifts);
    if (holiday.type === 'regular') return restDay ? 'RH_RD_8' : 'RH_8';
    if (holiday.type === 'special-non-working') return restDay ? 'SH_RD_8' : 'SH_8';
    return null;
  }

  function timeToMinutes(value) {
    var parts = String(value || '').split(':');
    if (parts.length < 2) return null;
    var hour = Number(parts[0]);
    var minute = Number(parts[1]);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  }

  // A native <input type="time"> always returns a clean 24-hour "HH:MM" value with no separate
  // AM/PM to lose -- so a shift saved with End="06:00" really did have its AM/PM segment left on
  // AM at the moment it was set, most often because it was meant to be 6:00 PM (18:00) for a
  // same-day shift. Rather than silently treating every End <= Start as an overnight shift (the
  // old behavior), catch the specific case where reinterpreting a morning End time as its PM
  // equivalent produces a sane same-day shift length, and return the corrected value -- otherwise
  // (End is already PM, or the PM reinterpretation doesn't fit before Start) return null,
  // leaving a genuine overnight shift like 22:00-06:00 untouched.
  function autoCorrectShiftEndAmPm(start, end) {
    var startMin = timeToMinutes(start), endMin = timeToMinutes(end);
    if (startMin == null || endMin == null || endMin > startMin) return null;
    if (endMin >= 12 * 60) return null;
    var pmEndMin = endMin + 12 * 60;
    var pmSpan = pmEndMin - startMin;
    if (pmSpan <= 0 || pmSpan > 16 * 60) return null;
    var hh = Math.floor(pmEndMin / 60), mm = pmEndMin % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
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

  // Philippine night-shift differential (Labor Code Art. 86) applies to hours actually worked
  // between 22:00 and 06:00. Expressed as two 8h windows on a 48h timeline anchored to the
  // punch day's midnight, so a single overlap check correctly covers both a shift that starts
  // in the evening and crosses into the window, and one that starts before dawn and is already
  // inside it when it begins.
  var NIGHT_WINDOWS = [[22 * 60, 30 * 60], [22 * 60 - 1440, 30 * 60 - 1440]];
  function intervalNightMinutes(startMin, endMin) {
    if (startMin == null || endMin == null || endMin <= startMin) return 0;
    var total = 0;
    NIGHT_WINDOWS.forEach(function (w) {
      var s = Math.max(startMin, w[0]);
      var e = Math.min(endMin, w[1]);
      if (e > s) total += (e - s);
    });
    return total;
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  // Derives a day's attendance facts — time in/out, late, undertime, OT, night differential,
  // rest-day/holiday hours — from its FULL raw punch log plus that day's schedule. Pure and
  // side-effect-free like the rest of this module: callers apply the returned patch through
  // upsert(), which is what actually writes it down (and never lets it shrink the punch log).
  //
  // Multiple punches between the first (time in) and last (time out) of the day are treated as
  // break out/in pairs when there's an even number of them (consecutive pairing); an odd count
  // can't be paired unambiguously, so it falls back to the shift's configured break window
  // instead of guessing which punch is the stray one.
  function computeFromPunches(punches, schedule, isRestDayOrHoliday) {
    var valid = (punches || []).filter(function (p) { return p && p.time; });
    if (!valid.length) return null;
    var sorted = valid.slice().sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });

    // Prefer the device's own in/out toggle (kind) when any punch carries one — this is also
    // what correctly orders an overnight shift, since a plain time-of-day string sort can't
    // tell that 22:00 came before 06:00 the next day (there's no date on a punch, only a
    // time). Only fall back to earliest/latest-by-time when no punch is tagged at all.
    var insSorted = valid.filter(function (p) { return p.kind === 'in'; }).map(function (p) { return p.time; }).sort();
    var outsSorted = valid.filter(function (p) { return p.kind === 'out'; }).map(function (p) { return p.time; }).sort();
    var hasKindTags = insSorted.length > 0 || outsSorted.length > 0;
    var tin = hasKindTags && insSorted.length ? insSorted[0] : sorted[0].time;
    var tout = hasKindTags && outsSorted.length ? outsSorted[outsSorted.length - 1]
      : (sorted.length > 1 ? sorted[sorted.length - 1].time : '');
    if (tout === tin) tout = sorted.length > 1 ? sorted[sorted.length - 1].time : '';

    var tinMin = timeToMinutes(tin);
    var toutMin = tout ? timeToMinutes(tout) : null;
    var overnight = toutMin != null && toutMin <= tinMin;
    var toutMinAbs = toutMin != null ? (overnight ? toutMin + 1440 : toutMin) : null;

    // Punches strictly between tin and tout are break candidates — only attempted when the
    // shift doesn't cross midnight, since without a date on each punch there's no reliable way
    // to chronologically order "inner" punches around a wraparound (an overnight shift falls
    // straight through to the schedule's configured break window below instead of guessing).
    var inner = !overnight ? sorted.filter(function (p) { return p.time !== tin && p.time !== tout; }) : [];
    var breakMinutes = 0;
    var breakSpans = [];
    if (inner.length && inner.length % 2 === 0) {
      for (var i = 0; i < inner.length; i += 2) {
        var bs = timeToMinutes(inner[i].time);
        var be = timeToMinutes(inner[i + 1].time);
        if (be <= bs) be += 1440;
        breakMinutes += (be - bs);
        breakSpans.push([bs, be]);
      }
    } else if (schedule && schedule.breakStart && schedule.breakEnd && tinMin != null && toutMinAbs != null) {
      var schedBreakStart = timeToMinutes(schedule.breakStart);
      var schedBreakEnd = timeToMinutes(schedule.breakEnd);
      if (schedBreakEnd <= schedBreakStart) schedBreakEnd += 1440;
      if (schedBreakStart >= tinMin && schedBreakEnd <= toutMinAbs) {
        breakMinutes = schedBreakEnd - schedBreakStart;
        breakSpans.push([schedBreakStart, schedBreakEnd]);
      }
    }

    var grossMinutes = toutMinAbs != null ? Math.max(0, toutMinAbs - tinMin) : null;
    var hoursWorked = grossMinutes != null ? round2((grossMinutes - breakMinutes) / 60) : null;

    var shiftStart = schedule ? timeToMinutes(schedule.start) : null;
    var shiftEnd = schedule ? timeToMinutes(schedule.end) : null;
    if (shiftStart != null && shiftEnd != null && shiftEnd <= shiftStart) shiftEnd += 1440;
    var grace = schedule ? Number(schedule.graceMinutes || 0) : 0;

    var lateMinutes = !isRestDayOrHoliday && shiftStart != null && tinMin != null ? Math.max(0, tinMin - shiftStart - grace) : 0;
    var undertimeMinutes = !isRestDayOrHoliday && shiftEnd != null && toutMinAbs != null ? Math.max(0, shiftEnd - toutMinAbs) : 0;
    var otMinutes = !isRestDayOrHoliday && shiftEnd != null && toutMinAbs != null ? Math.max(0, toutMinAbs - shiftEnd) : 0;

    var nightGross = toutMinAbs != null ? intervalNightMinutes(tinMin, toutMinAbs) : 0;
    var nightBreak = 0;
    breakSpans.forEach(function (span) { nightBreak += intervalNightMinutes(span[0], span[1]); });
    var ndHours = round2((nightGross - nightBreak) / 60);

    return {
      tin: tin,
      tout: tout,
      lateMinutes: lateMinutes,
      undertimeMinutes: undertimeMinutes,
      ot: round2(otMinutes / 60),
      nd: ndHours,
      restDayHolidayHours: isRestDayOrHoliday && hoursWorked != null ? hoursWorked : 0,
      breakMinutes: breakMinutes,
      hoursWorked: hoursWorked,
      stillClockedIn: !tout,
      // A punch pair missing either half (no time in, or clocked in but never clocked out) can't
      // establish that a full day was actually worked -- callers should treat this as Absent
      // rather than Late/Present, whatever the raw late-minutes math on the half that IS present
      // happens to say.
      incomplete: !tin || !tout
    };
  }

  // Layers employer-configured attendance policy (Company Settings > Attendance Formula and
  // Overtime Table > Attendance Policy Rules) on top of the objective facts computeFromPunches
  // already derived. Kept as a separate step on purpose: computeFromPunches stays pure
  // timekeeping math, this is where configurable business rules (which an employer can turn
  // off or retune) get applied. A day marked LWOP here is meant to be recorded as status
  // 'absent' by the caller — LWOP is an unpaid day, exactly what the existing 'absent' payroll
  // deduction already means — with a note explaining why so it reads differently from a
  // manually-filed absence.
  function applyAttendancePolicy(computed, schedule, policy) {
    if (!computed || !policy || policy.active === false) return computed;
    var result = Object.assign({}, computed);
    var notes = [];

    if (policy.deductLateFromOT && result.ot > 0 && result.lateMinutes > 0) {
      var otMinutes = Math.round(result.ot * 60);
      var deduct = Math.min(otMinutes, result.lateMinutes);
      result.ot = round2((otMinutes - deduct) / 60);
      if (deduct > 0) { result.lateDeductedFromOtMinutes = deduct; notes.push(deduct + ' min late deducted from OT'); }
    }

    var halfDayThreshold = Number(policy.lateHalfDayMinutes);
    if (halfDayThreshold > 0 && result.lateMinutes >= halfDayThreshold) {
      result.halfDay = true;
      var shiftStart = schedule ? timeToMinutes(schedule.start) : null;
      var shiftEndRaw = schedule ? timeToMinutes(schedule.end) : null;
      var shiftMinutes = shiftStart != null && shiftEndRaw != null
        ? (shiftEndRaw <= shiftStart ? shiftEndRaw + 1440 - shiftStart : shiftEndRaw - shiftStart) : null;
      if (shiftMinutes) {
        var halfMinutes = Math.round(shiftMinutes / 2);
        if (Number(result.undertimeMinutes || 0) < halfMinutes) result.undertimeMinutes = halfMinutes;
      }
      notes.push('Half day — late ' + result.lateMinutes + ' min (policy threshold ' + halfDayThreshold + ' min)');
    }

    var minHours = Number(policy.minHoursFullDay);
    if (minHours > 0 && !result.stillClockedIn && result.hoursWorked != null && result.hoursWorked < minHours) {
      result.lwop = true;
      notes.push('LWOP — only ' + result.hoursWorked + 'h worked (below ' + minHours + 'h minimum)');
    }

    if (notes.length) result.policyNotes = notes;
    return result;
  }

  function periodSummary(records, employee, from, to, shifts, holidays) {
    var rows = canonicalRecords(records).filter(function (record) {
      return record.eid === employee.id && record.date >= from && record.date <= to && record.approvalStatus !== 'rejected';
    });
    var summary = { records: rows, presentDays: 0, lateMinutes: 0, undertimeMinutes: 0, absentDays: 0, otHours: 0, ndHours: 0, restDayHolidayHours: 0, restDayHolidayHoursByCode: {} };
    rows.forEach(function (record) {
      if (record.status === 'present' || record.status === 'late') summary.presentDays += 1;
      if (record.status === 'absent') summary.absentDays += 1;
      summary.otHours += Number(record.ot || 0);
      summary.ndHours += Number(record.nd || 0);
      var rdhHours = Number(record.restDayHolidayHours || 0);
      summary.restDayHolidayHours += rdhHours;
      if (rdhHours) {
        // A specific holiday-pay rate code when this date is a configured holiday, otherwise
        // 'RDH_GENERIC' — plain (non-holiday) rest-day work, kept at the old flat rate.
        var code = classifyHolidayPremium(employee, record.date, shifts, holidays) || 'RDH_GENERIC';
        summary.restDayHolidayHoursByCode[code] = (summary.restDayHolidayHoursByCode[code] || 0) + rdhHours;
      }
      var schedule = scheduleForDate(employee, record.date, shifts);
      var actualIn = minutes(record.tin);
      var actualOut = minutes(record.tout);
      var shiftIn = schedule && minutes(schedule.start);
      var shiftOut = schedule && minutes(schedule.end);
      var calculatedLate = actualIn != null && shiftIn != null ? Math.max(0, actualIn - shiftIn - Number(schedule.graceMinutes || 0)) : 0;
      var calculatedUndertime = actualOut != null && shiftOut != null ? Math.max(0, shiftOut - actualOut) : 0;
      // Max of stored vs. recomputed, same as undertime below -- a record can carry an explicit
      // lateMinutes:0 that predates this engine and was simply never computed, which a plain
      // "use it if it's not null" check can't distinguish from a real zero.
      summary.lateMinutes += Math.max(Number(record.lateMinutes || 0), calculatedLate);
      summary.undertimeMinutes += Math.max(Number(record.undertimeMinutes || 0), calculatedUndertime);
    });
    Object.keys(summary).forEach(function (key) {
      if (key !== 'records' && typeof summary[key] === 'number') summary[key] = Math.round(summary[key] * 100) / 100;
    });
    Object.keys(summary.restDayHolidayHoursByCode).forEach(function (code) {
      summary.restDayHolidayHoursByCode[code] = Math.round(summary.restDayHolidayHoursByCode[code] * 100) / 100;
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
    mergePunches: mergePunches,
    computeFromPunches: computeFromPunches,
    applyAttendancePolicy: applyAttendancePolicy,
    autoCorrectShiftEndAmPm: autoCorrectShiftEndAmPm,
    validateLinkedRecord: validateLinkedRecord,
    scheduleForDate: scheduleForDate,
    normalizeShift: normalizeShift,
    resolveShiftDay: resolveShiftDay,
    isRestDay: isRestDay,
    classifyHolidayPremium: classifyHolidayPremium,
    periodSummary: periodSummary
  };
});
