/*
 * SproutRipple PH compliance extension
 * Rules verified against primary PH government publications as of 2026-07-28.
 * This remains a configurable payroll engine: employers must validate company-
 * specific policies, exemptions, minimum-wage treatment, and filing formats.
 */
(function () {
  'use strict';

  var COMPLIANCE_VERSION = {
    label: 'PH statutory rules verified 28 Jul 2026',
    sss: 'Effective 01 Jan 2025 · 15% total · MSC ₱5,000–₱35,000',
    philhealth: 'CY 2025 schedule · 5% total · ₱10,000–₱100,000 MBS',
    pagibig: 'Effective 01 Feb 2024 · MFS ₱10,000',
    bir: 'RR 11-2018 Annex E · 2023 onwards'
  };

  /* Correct the BIR Annex E tables (effective 2023 onwards). */
  GOVT_RATES.bir.brackets = [
    {from:0,      to:20833,     base:0,         rate:0},
    {from:20833,  to:33332,     base:0,         rate:15},
    {from:33333,  to:66666,     base:1875,      rate:20},
    {from:66667,  to:166666,    base:8541.80,   rate:25},
    {from:166667, to:666666,    base:33541.80,  rate:30},
    {from:666667, to:999999999, base:183541.80, rate:35}
  ];
  GOVT_RATES.bir.tables = {
    annual: [
      {from:0,       to:250000,    base:0,       rate:0},
      {from:250000,  to:400000,    base:0,       rate:15},
      {from:400000,  to:800000,    base:22500,   rate:20},
      {from:800000,  to:2000000,   base:102500,  rate:25},
      {from:2000000, to:8000000,   base:402500,  rate:30},
      {from:8000000, to:999999999, base:2202500, rate:35}
    ],
    monthly: [
      {from:0,      to:20833,     base:0,         rate:0},
      {from:20833,  to:33332,     base:0,         rate:15},
      {from:33333,  to:66666,     base:1875,      rate:20},
      {from:66667,  to:166666,    base:8541.80,   rate:25},
      {from:166667, to:666666,    base:33541.80,  rate:30},
      {from:666667, to:999999999, base:183541.80, rate:35}
    ],
    'semi-monthly': [
      {from:0,      to:10417,     base:0,        rate:0},
      {from:10417,  to:16666,     base:0,        rate:15},
      {from:16667,  to:33332,     base:937.50,   rate:20},
      {from:33333,  to:83332,     base:4270.70,  rate:25},
      {from:83333,  to:333332,    base:16770.70, rate:30},
      {from:333333, to:999999999, base:91770.70, rate:35}
    ],
    weekly: [
      {from:0,      to:4808,      base:0,        rate:0},
      {from:4808,   to:7691,      base:0,        rate:15},
      {from:7692,   to:15384,     base:432.60,   rate:20},
      {from:15385,  to:38461,     base:1971.20,  rate:25},
      {from:38462,  to:153845,    base:7740.45,  rate:30},
      {from:153846, to:999999999, base:42355.65, rate:35}
    ],
    daily: [
      {from:0,     to:685,       base:0,       rate:0},
      {from:685,   to:1095,      base:0,       rate:15},
      {from:1096,  to:2191,      base:61.65,   rate:20},
      {from:2192,  to:5478,      base:280.85,  rate:25},
      {from:5479,  to:21917,     base:1102.60, rate:30},
      {from:21918, to:999999999, base:6034.30, rate:35}
    ]
  };

  /* Use the official SSS schedule rows so half-step MSC rounding is exact. */
  function getSssRow(ms) {
    var salary = Math.max(0, Number(ms) || 0);
    return (GOVT_RATES.sss.fullTable || []).find(function (row) {
      return salary >= row.salFrom && salary <= row.salTo;
    }) || GOVT_RATES.sss.fullTable[GOVT_RATES.sss.fullTable.length - 1];
  }
  window.sssContrib = sssContrib = function (ms) {
    var row = getSssRow(ms);
    return row ? +(row.ee || 0).toFixed(2) : 0;
  };
  window.mpfContrib = mpfContrib = function (ms) {
    var row = getSssRow(ms);
    return row ? +(row.mpfEE || 0).toFixed(2) : 0;
  };
  window.totalSSS = totalSSS = function (ms) {
    return +(sssContrib(ms) + mpfContrib(ms)).toFixed(2);
  };
  window.sssErShare = sssErShare = function (ms) {
    var row = getSssRow(ms);
    return row ? +((row.er || 0) + (row.ec || 0)).toFixed(2) : 0;
  };
  window.mpfErShare = mpfErShare = function (ms) {
    var row = getSssRow(ms);
    return row ? +(row.mpfER || 0).toFixed(2) : 0;
  };
  window.totalSssEr = totalSssEr = function (ms) {
    return +(sssErShare(ms) + mpfErShare(ms)).toFixed(2);
  };
  window.piErShare = piErShare = function (ms) {
    var r = GOVT_RATES.pagibig;
    var salary = Math.max(0, Number(ms) || 0);
    var tier = (r.tiers || []).find(function (t) {
      return salary >= t.salFrom && salary <= t.salTo;
    });
    if (!tier) return 0;
    return +Math.min(Math.min(salary, r.maxFundSalary) * tier.erRate / 100, tier.maxER).toFixed(2);
  };

  /* Existing seed/device records are treated as approved source records. */
  ATT.forEach(function (a) {
    if (!a.approvalStatus) a.approvalStatus = 'approved';
    if (!a.source) a.source = 'system';
    if (!a.filedBy) a.filedBy = 'System import';
  });

  function approvalBadge(status) {
    var map = {approved:'b-approved', pending:'b-pending', rejected:'b-rejected'};
    return '<span class="badge '+(map[status] || 'b-info')+'">'+esc(status || 'pending')+'</span>';
  }

  function attendanceLateMinutes(a) {
    if (!a.tin || a.status !== 'late') return 0;
    var bits = a.tin.split(':').map(Number);
    if (bits.length !== 2 || bits.some(isNaN)) return 0;
    return Math.max(0, bits[0] * 60 + bits[1] - 8 * 60);
  }

  function approvedAttendance(empId, from, to) {
    return attendanceRecords().filter(function (a) {
      return a.eid === empId && a.date >= from && a.date <= to && a.approvalStatus === 'approved';
    });
  }

  function periodPendingAttendance(empIds, from, to) {
    return attendanceRecords().filter(function (a) {
      return empIds.indexOf(a.eid) >= 0 && a.date >= from && a.date <= to && a.approvalStatus === 'pending';
    });
  }

  window.actAttendance = function (id, decision) {
    var row = ATT.find(function (a) { return a.id === id; });
    if (!row) return;
    row.approvalStatus = decision;
    row.reviewedBy = user ? user.name : 'Administrator';
    row.reviewedAt = new Date().toISOString();
    queueSync('Attendance');
    toast('Attendance '+decision+'.', decision === 'approved' ? 'success' : 'warning');
    render();
  };

  window.approveAllAttendance = function () {
    var pending = attendanceRecords().filter(function (a) { return a.approvalStatus === 'pending'; });
    pending.forEach(function (a) {
      a.approvalStatus = 'approved';
      a.reviewedBy = user ? user.name : 'Administrator';
      a.reviewedAt = new Date().toISOString();
    });
    if (pending.length) queueSync('Attendance');
    toast(pending.length ? pending.length+' attendance record(s) approved.' : 'No pending attendance.', pending.length ? 'success' : 'info');
    render();
  };

  window.pgAttendance = pgAttendance = function () {
    var isA = user.role === 'admin' || isPlatformAdmin || canAccess('att_edit');
    var tabs = isA ? ['Pending Approval','My Records','All Employees','File Attendance'] : ['My Records','File Attendance'];
    var body = '';

    if (isA && tab === 0) {
      var pending = attendanceRecords().filter(function (a) { return a.approvalStatus === 'pending'; }).sort(function (a,b) {
        return (b.date+b.id).localeCompare(a.date+a.id);
      });
      body = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'+
        '<div><div class="card-title">Attendance approval queue</div><div class="card-sub">Only approved records are included in payroll.</div></div>'+
        '<button class="btn btn-sm btn-success" onclick="approveAllAttendance()" '+(!pending.length?'disabled':'')+'>Approve all ('+pending.length+')</button></div>'+
        '<div style="overflow-x:auto"><table><thead><tr><th>Employee</th><th>Date</th><th>In / Out</th><th>Work status</th><th>OT</th><th>ND</th><th>Filed by</th><th>Actions</th></tr></thead><tbody>'+
        (pending.length ? pending.map(function (a) {
          var emp = USERS.find(function (u) { return u.id === a.eid; });
          return '<tr><td><div class="emp-cell"><div class="avatar sm">'+ini(emp ? emp.name : '?')+'</div><div><div style="font-weight:600">'+esc(emp ? emp.name : '?')+'</div><div style="font-size:10px;color:var(--txt3)">'+esc(emp ? emp.eid : '')+'</div></div></div></td>'+
            '<td class="mono">'+a.date+'</td><td class="mono">'+(a.tin || '—')+' – '+(a.tout || '—')+'</td>'+
            '<td><span class="badge b-'+a.status+'">'+esc(a.status)+'</span></td><td>'+(a.ot || '—')+'</td><td>'+(a.nd || '—')+'</td>'+
            '<td style="font-size:11px;color:var(--txt3)">'+esc(a.filedBy || 'Employee')+'</td>'+
            '<td><div class="action-row"><button class="btn btn-sm btn-success" onclick="actAttendance('+a.id+',\'approved\')">Approve</button>'+
            '<button class="btn btn-sm btn-danger" onclick="actAttendance('+a.id+',\'rejected\')">Reject</button></div></td></tr>';
        }).join('') : '<tr><td colspan="8" class="empty-state">No pending attendance records.</td></tr>')+
        '</tbody></table></div>';
    } else if ((!isA && tab === 0) || (isA && tab === 1)) {
      var mine = attendanceRecords().filter(function (a) { return a.eid === user.id; }).slice().reverse();
      body = '<div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Work status</th><th>Approval</th><th>OT</th><th>ND</th><th>Notes</th></tr></thead><tbody>'+
        (mine.length ? mine.map(function (a) {
          return '<tr><td class="mono">'+a.date+'</td><td class="mono">'+(a.tin || '—')+'</td><td class="mono">'+(a.tout || '—')+'</td>'+
            '<td><span class="badge b-'+a.status+'">'+esc(a.status)+'</span></td><td>'+approvalBadge(a.approvalStatus)+'</td>'+
            '<td>'+(a.ot || '—')+'</td><td>'+(a.nd || '—')+'</td><td style="color:var(--txt3)">'+esc(a.notes || '—')+'</td></tr>';
        }).join('') : '<tr><td colspan="8" class="empty-state">No attendance records.</td></tr>')+'</tbody></table></div>';
    } else if (isA && tab === 2) {
      body = '<div style="overflow-x:auto"><table><thead><tr><th>Employee</th><th>Date</th><th>In</th><th>Out</th><th>Work status</th><th>Approval</th><th>OT</th><th>ND</th><th>Reviewed by</th></tr></thead><tbody>'+
        attendanceRecords().slice().reverse().map(function (a) {
          var emp = USERS.find(function (u) { return u.id === a.eid; });
          return '<tr><td><div class="emp-cell"><div class="avatar sm">'+ini(emp ? emp.name : '?')+'</div>'+esc(emp ? emp.name : '?')+'</div></td>'+
            '<td class="mono">'+a.date+'</td><td class="mono">'+(a.tin || '—')+'</td><td class="mono">'+(a.tout || '—')+'</td>'+
            '<td><span class="badge b-'+a.status+'">'+esc(a.status)+'</span></td><td>'+approvalBadge(a.approvalStatus)+'</td>'+
            '<td>'+(a.ot || '—')+'</td><td>'+(a.nd || '—')+'</td><td style="font-size:11px;color:var(--txt3)">'+esc(a.reviewedBy || '—')+'</td></tr>';
        }).join('')+'</tbody></table></div>';
    } else {
      body = (isA ? '<div class="field"><label>Employee</label><select id="ae">'+USERS.filter(function (u) { return u.role === 'employee'; }).map(function (u) {
        return '<option value="'+u.id+'">'+esc(u.name)+'</option>';
      }).join('')+'</select></div>' : '')+
        '<div class="form-row"><div class="field"><label>Date</label><input type="date" id="adate" value="'+today()+'"/></div>'+
        '<div class="field"><label>Status</label><select id="ast"><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option><option value="leave">On Leave</option></select></div></div>'+
        '<div class="form-row"><div class="field"><label>Time In</label><input type="time" id="atin" value="08:00"/></div><div class="field"><label>Time Out</label><input type="time" id="atout" value="17:00"/></div></div>'+
        '<div class="form-row"><div class="field"><label>Overtime Hours</label><input type="number" id="aot" value="0" min="0" max="12" step=".25"/></div>'+
        '<div class="field"><label>Night Differential Hours</label><input type="number" id="and" value="0" min="0" max="12" step=".25"/></div></div>'+
        '<div class="field"><label>Notes</label><input type="text" id="anotes" placeholder="Reason, work performed, or correction details"/></div>'+
        '<div style="padding:9px 12px;background:var(--accent-bg);border-radius:8px;color:var(--accent-txt);font-size:12px;margin-bottom:12px">'+
        (isA ? 'Administrator entries are approved immediately and recorded in the audit trail.' : 'Your entry will be routed for approval before it can affect payroll.')+'</div>'+
        '<button class="btn btn-primary" onclick="submitAtt('+isA+')">Submit Attendance</button>';
    }

    var pendingCount = attendanceRecords().filter(function (a) { return a.approvalStatus === 'pending'; }).length;
    return '<div class="page-header"><div><div class="page-title">Attendance</div><div class="page-sub">Approval-controlled time records · '+pendingCount+' pending</div></div></div>'+
      '<div class="tabs">'+tabs.map(function (t,i) { return '<div class="tab'+(tab===i?' active':'')+'" onclick="goTab('+i+')">'+t+(i===0&&isA&&pendingCount?' ('+pendingCount+')':'')+'</div>'; }).join('')+'</div>'+
      '<div class="card">'+body+'</div>';
  };

  window.submitAtt = submitAtt = function (isA) {
    var eid = isA ? parseInt(document.getElementById('ae').value, 10) : user.id;
    var date = document.getElementById('adate').value;
    if (!date) { toast('Select a date.', 'warning'); return; }
    var duplicate = attendanceRecord(eid,date);
    upsertAttendance(eid,date,{
      tin:document.getElementById('atin').value, tout:document.getElementById('atout').value,
      status:document.getElementById('ast').value,
      ot:parseFloat(document.getElementById('aot').value) || 0,
      nd:parseFloat(document.getElementById('and').value) || 0,
      notes:document.getElementById('anotes').value.trim(),
      approvalStatus:isA ? 'approved' : 'pending',
      filedBy:user.name, filedAt:new Date().toISOString(), source:'manual',
      reviewedBy:isA ? user.name : '', reviewedAt:isA ? new Date().toISOString() : ''
    });
    queueSync('Attendance');
    toast(isA ? (duplicate?'Authoritative attendance updated and approved.':'Attendance saved and approved.') : (duplicate?'Attendance update submitted for approval.':'Attendance submitted for approval.'), 'success');
    tab = isA ? 2 : 0;
    render();
  };

  function statutoryFactor(grp, period) {
    if (!shouldDeductStatutory(grp, period)) return 0;
    if ((grp.statutoryTiming || '') !== 'every-cutoff') return 1;
    if (grp.freq === 'semi-monthly') return 0.5;
    if (grp.freq === 'weekly') return 12 / 52;
    if (grp.freq === 'bi-weekly') return 12 / 26;
    return 1;
  }

  window.buildDraftRow = buildDraftRow = function (emp, grp, period) {
    var from = period && (period.attendanceFrom || period.from) || document.getElementById('pf') && document.getElementById('pf').value || today();
    var to = period && (period.attendanceTo || period.to) || document.getElementById('pt') && document.getElementById('pt').value || today();
    var logs = approvedAttendance(emp.id, from, to);
    var baseBasic = computeBasicByPayType(emp, grp, period);
    var dailyRate = Number(emp.rate) || 0;
    var absentDays = logs.filter(function (a) { return a.status === 'absent'; }).length;
    var lateMinutes = logs.reduce(function (sum, a) { return sum + attendanceLateMinutes(a); }, 0);
    var otHours = logs.reduce(function (sum, a) { return sum + (Number(a.ot) || 0); }, 0);
    var ndHours = logs.reduce(function (sum, a) { return sum + (Number(a.nd) || 0); }, 0);
    var absenceDed = +(absentDays * dailyRate).toFixed(2);
    var lateDed = +(lateMinutes * dailyRate / 8 / 60).toFixed(2);
    var ot = +(dailyRate / 8 * 1.25 * otHours).toFixed(2);
    var nd = +(dailyRate / 8 * 0.10 * ndHours).toFixed(2);
    var basic = +Math.max(0, baseBasic - absenceDed - lateDed).toFixed(2);
    var gross = +(basic + ot + nd).toFixed(2);
    var pm = emp.salaryPM || emp.rate * (emp.dailyDivisor || COMPANY.dailyDivisor || 22);
    var ms = +pm.toFixed(2);
    var factor = statutoryFactor(grp, period);
    var sss = +(totalSSS(ms) * factor).toFixed(2);
    var ph = +(phContrib(ms) * factor).toFixed(2);
    var pi = +(piContrib(ms) * factor).toFixed(2);
    var taxFreq = grp.taxMethod || 'monthly';
    var taxableCompensation = Math.max(0, gross - sss - ph - pi);
    var tax = +birTaxByFreq(taxableCompensation, taxFreq).toFixed(2);
    var loan = +(LOANS.filter(function (l) { return l.eid === emp.id && l.status === 'active'; }).reduce(function (s,l) {
      return s + (Number(l.monthly) || 0) * (grp.freq === 'semi-monthly' ? 0.5 : 1);
    }, 0)).toFixed(2);
    var totalDed = +(sss + ph + pi + tax + loan).toFixed(2);
    var net = +Math.max(0, gross - totalDed).toFixed(2);
    return {
      empId:emp.id, name:emp.name, eid:emp.eid, pos:emp.pos, payType:emp.payType,
      basic:basic, baseBasic:+baseBasic.toFixed(2), absenceDed:absenceDed, lateDed:lateDed,
      absentDays:absentDays, lateMinutes:lateMinutes, pr:logs.filter(function (a) { return a.status === 'present' || a.status === 'late'; }).length,
      ot:ot, nd:nd, otH:otHours, ndH:ndHours, gross:gross,
      sss:sss, ph:ph, pi:pi, tax:tax, loan:loan, totalDed:totalDed, net:net,
      applyStatutory:factor > 0, statutoryFactor:factor, taxFreq:taxFreq, taxableCompensation:taxableCompensation,
      ms:ms, attendanceFrom:from, attendanceTo:to, attendanceApproved:logs.length, _edited:false
    };
  };

  window.previewPayroll = previewPayroll = function () {
    var from = document.getElementById('pf') && document.getElementById('pf').value;
    var to = document.getElementById('pt') && document.getElementById('pt').value;
    if (!from || !to) { toast('Please select a pay period.', 'warning'); return; }
    var grpId = window._prGroup || PAYROLL_GROUPS[0].id;
    var grp = PAYROLL_GROUPS.find(function (g) { return g.id === grpId; }) || PAYROLL_GROUPS[0];
    var period = PAY_PERIODS.find(function (p) { return p.id === window._prPeriod; }) || null;
    var emps = USERS.filter(function (u) { return u.role === 'employee' && document.getElementById('pe'+u.id) && document.getElementById('pe'+u.id).checked; });
    if (!emps.length) { toast('Select at least one employee.', 'warning'); return; }
    var pending = periodPendingAttendance(emps.map(function (e) { return e.id; }), from, to);
    if (pending.length) {
      toast('Payroll blocked: '+pending.length+' attendance record(s) still need approval.', 'warning', 5500);
      return;
    }
    PAYROLL_DRAFT = {};
    emps.forEach(function (emp) { PAYROLL_DRAFT[emp.id] = buildDraftRow(emp, grp, period); });
    window._prPreview = true;
    render();
    toast('Preview ready from approved attendance and current PH statutory tables.', 'info');
  };

  window.runPayroll = runPayroll = function () {
    var from = document.getElementById('pf') && document.getElementById('pf').value;
    var to = document.getElementById('pt') && document.getElementById('pt').value;
    if (!from || !to || !Object.keys(PAYROLL_DRAFT).length) { toast('Preview payroll before submitting it.', 'warning'); return; }
    var groupId = window._prGroup || PAYROLL_GROUPS[0].id;
    var grp = PAYROLL_GROUPS.find(function (g) { return g.id === groupId; }) || PAYROLL_GROUPS[0];
    if (PAYROLLS.some(function (r) { return r.groupId === groupId && r.from === from && r.to === to && r.status === 'pending_approval'; })) {
      toast('A payroll for this group and period is already awaiting approval.', 'warning');
      return;
    }
    var items = Object.values(PAYROLL_DRAFT).map(function (d) {
      var adjItems = PAYROLL_ADJ.filter(function (x) { return x.empId === d.empId && x.status === 'approved'; });
      var adjTotal = adjItems.reduce(function (s,x) { return s + Number(x.amount || 0); }, 0);
      return Object.assign({}, d, {
        adjustments:adjTotal,
        adjustmentIds:adjItems.map(function (x) { return x.id; }),
        net:+Math.max(0, d.net + adjTotal).toFixed(2)
      });
    });
    var run = {
      id:nPay++, from:from, to:to, items:items, on:today(), groupId:groupId, groupName:grp.name || 'Standard',
      periodId:window._prPeriod !== 'custom' ? window._prPeriod : null,
      status:'pending_approval', preparedBy:user.name, preparedAt:new Date().toISOString(),
      complianceVersion:COMPLIANCE_VERSION.label
    };
    PAYROLLS.push(run);
    PAYROLL_AUDIT.push({runId:run.id, action:'submitted', by:user.name, at:new Date().toISOString()});
    PAY_OVERRIDES = {};
    PAYROLL_DRAFT = {};
    window._prPreview = false;
    queueSync('Payroll_Runs','Payroll_Items');
    toast('Payroll submitted for approval · '+items.length+' employees · Net '+fmt(items.reduce(function (s,i) { return s+i.net; },0)), 'success', 5000);
    tab = 0;
    render();
  };

  window.approvePayroll = function (runId) {
    var run = PAYROLLS.find(function (r) { return r.id === runId; });
    if (!run || run.status !== 'pending_approval') return;
    if (!(user.role === 'admin' || canAccess('payroll_approve'))) { toast('You do not have payroll approval permission.', 'error'); return; }
    run.status = 'approved';
    run.approvedBy = user.name;
    run.approvedAt = new Date().toISOString();
    run.lockedAt = run.approvedAt;
    run.items.forEach(function (item) {
      (item.adjustmentIds || []).forEach(function (id) {
        var adj = PAYROLL_ADJ.find(function (a) { return a.id === id; });
        if (adj) adj.status = 'applied';
      });
    });
    var period = PAY_PERIODS.find(function (p) { return p.id === run.periodId; });
    if (period) {
      period.status = 'closed';
      period.runId = run.id;
      period.lockedBy = user.email || user.name;
      period.lockedAt = today();
    }
    PAYROLL_AUDIT.push({runId:run.id, action:'approved_and_locked', by:user.name, at:run.approvedAt});
    queueSync('Payroll_Runs','Payroll_Items','Payroll_Audit');
    toast('Payroll approved and locked. Reports are now available.', 'success');
    render();
  };

  window.rejectPayroll = function (runId) {
    var run = PAYROLLS.find(function (r) { return r.id === runId; });
    if (!run || run.status !== 'pending_approval') return;
    run.status = 'rejected';
    run.rejectedBy = user.name;
    run.rejectedAt = new Date().toISOString();
    PAYROLL_AUDIT.push({runId:run.id, action:'rejected', by:user.name, at:run.rejectedAt});
    queueSync('Payroll_Runs','Payroll_Audit');
    toast('Payroll returned for correction.', 'warning');
    render();
  };

  function payrollApprovalQueue() {
    var pending = PAYROLLS.filter(function (r) { return r.status === 'pending_approval'; }).slice().reverse();
    return '<div class="card" style="margin-top:1rem;border-left:3px solid var(--amber)">'+
      '<div class="card-hd"><div><div class="card-title">Payroll approval queue</div><div class="card-sub">Approval locks the run, closes the pay period, and enables statutory reports.</div></div>'+
      '<span class="badge b-pending">'+pending.length+' pending</span></div>'+
      (pending.length ? '<div style="overflow-x:auto"><table><thead><tr><th>Period</th><th>Group</th><th>Prepared by</th><th>Employees</th><th>Gross</th><th>Net</th><th>Actions</th></tr></thead><tbody>'+
        pending.map(function (r) {
          return '<tr><td class="mono">'+r.from+' – '+r.to+'</td><td>'+esc(r.groupName)+'</td><td>'+esc(r.preparedBy || '—')+'</td>'+
            '<td>'+r.items.length+'</td><td class="mono">'+fmt(r.items.reduce(function (s,i) { return s+i.gross; },0))+'</td>'+
            '<td class="mono" style="font-weight:700;color:var(--green)">'+fmt(r.items.reduce(function (s,i) { return s+i.net; },0))+'</td>'+
            '<td><div class="action-row"><button class="btn btn-sm btn-success" onclick="approvePayroll('+r.id+')">Approve & lock</button>'+
            '<button class="btn btn-sm btn-danger" onclick="rejectPayroll('+r.id+')">Return</button></div></td></tr>';
        }).join('')+'</tbody></table></div>' : '<div class="empty-state" style="padding:1.5rem">No payroll runs awaiting approval.</div>')+'</div>';
  }

  var basePgPayroll = pgPayroll;
  window.pgPayroll = pgPayroll = function () {
    var html = basePgPayroll();
    html = html.replace('✓ Finalize Payroll', 'Submit for Approval');
    html = html.replace('Philippine Payroll Management', 'Approval-controlled Philippine payroll · '+COMPLIANCE_VERSION.label);
    if (tab === 0) html += payrollApprovalQueue();
    if (tab === 1) {
      var p = PAY_PERIODS.find(function (x) { return x.id === window._prPeriod; });
      var from = p ? (p.attendanceFrom || p.from) : today();
      var to = p ? (p.attendanceTo || p.to) : today();
      var groupId = window._prGroup || (PAYROLL_GROUPS[0] && PAYROLL_GROUPS[0].id);
      var ids = USERS.filter(function (u) { return u.role === 'employee' && u.payGroupId === groupId; }).map(function (u) { return u.id; });
      var pending = periodPendingAttendance(ids, from, to).length;
      html = html.replace('<!-- Info strip -->',
        '<div style="padding:9px 12px;border-radius:8px;margin-bottom:10px;background:'+(pending?'var(--amber-bg)':'var(--green-bg)')+';color:'+(pending?'var(--amber-txt)':'var(--green-txt)')+';font-size:12px;font-weight:600">'+
        (pending ? '⚠ '+pending+' attendance record(s) must be approved before previewing payroll.' : '✓ Attendance approval gate clear for this payroll group and period.')+'</div><!-- Info strip -->');
    }
    return html;
  };

  function csvCell(value) {
    var s = value == null ? '' : String(value);
    if (/^[=+\-@]/.test(s)) s = "'"+s;
    return '"'+s.replace(/"/g, '""')+'"';
  }

  function downloadCsv(filename, rows) {
    var content = '\uFEFF'+rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob([content], {type:'text/csv;charset=utf-8'});
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 500);
  }

  function latestApprovedRun() {
    return PAYROLLS.slice().reverse().find(function (r) { return r.status === 'approved' || r.status === 'locked'; });
  }

  window.generateGovtReport = function (type) {
    var run = latestApprovedRun();
    if (!run) { toast('Approve and lock a payroll run before generating reports.', 'warning'); return; }
    var headers, rows, filename;
    if (type === 'SSS') {
      headers = ['Employee No.','Employee','SSS No.','Monthly Salary Credit','SSS EE','MPF EE','SSS ER incl. EC','MPF ER','Total'];
      rows = run.items.map(function (i) {
        var e = USERS.find(function (u) { return u.id === i.empId; }) || {};
        return [i.eid,i.name,e.sss||'',i.ms,sssContrib(i.ms),mpfContrib(i.ms),sssErShare(i.ms),mpfErShare(i.ms),
          totalSSS(i.ms)+totalSssEr(i.ms)];
      });
      filename = 'SSS_R3_'+run.from+'_'+run.to+'.csv';
    } else if (type === 'PHIC') {
      headers = ['Employee No.','Employee','PhilHealth No.','Monthly Basic Salary','Employee Share','Employer Share','Total Premium'];
      rows = run.items.map(function (i) {
        var e = USERS.find(function (u) { return u.id === i.empId; }) || {};
        return [i.eid,i.name,e.ph||'',i.ms,phContrib(i.ms),phErShare(i.ms),phContrib(i.ms)+phErShare(i.ms)];
      });
      filename = 'PhilHealth_RF1_'+run.from+'_'+run.to+'.csv';
    } else if (type === 'HDMF') {
      headers = ['Employee No.','Employee','Pag-IBIG MID','Monthly Compensation','Employee Share','Employer Share','Total'];
      rows = run.items.map(function (i) {
        var e = USERS.find(function (u) { return u.id === i.empId; }) || {};
        return [i.eid,i.name,e.pi||'',i.ms,piContrib(i.ms),piErShare(i.ms),piContrib(i.ms)+piErShare(i.ms)];
      });
      filename = 'PagIBIG_MCRF_'+run.from+'_'+run.to+'.csv';
    } else {
      headers = ['Employee No.','Employee','TIN','Gross Compensation','Mandatory Contributions','Taxable Compensation','Tax Withheld'];
      rows = run.items.map(function (i) {
        var e = USERS.find(function (u) { return u.id === i.empId; }) || {};
        return [i.eid,i.name,e.tin||'',i.gross,(i.sss||0)+(i.ph||0)+(i.pi||0),i.taxableCompensation||0,i.tax||0];
      });
      filename = 'BIR_1601C_Worksheet_'+run.from+'_'+run.to+'.csv';
    }
    var totals = rows.reduce(function (acc,row) {
      row.forEach(function (v,idx) { if (typeof v === 'number') acc[idx] = (acc[idx] || 0) + v; });
      return acc;
    }, []);
    rows.push(headers.map(function (_,idx) { return idx === 1 ? 'TOTAL' : (totals[idx] || ''); }));
    downloadCsv(filename, [headers].concat(rows));
    toast(type+' report generated from approved payroll.', 'success');
  };

  window.generate2316Worksheet = function (empId) {
    var emp = USERS.find(function (u) { return u.id === empId; });
    var runs = PAYROLLS.filter(function (r) { return r.status === 'approved' || r.status === 'locked'; });
    if (!emp || !runs.length) { toast('No approved payroll data available.', 'warning'); return; }
    var items = [];
    runs.forEach(function (r) {
      var item = r.items.find(function (i) { return i.empId === empId; });
      if (item) items.push({run:r,item:item});
    });
    var rows = [['BIR 2316 DATA WORKSHEET'],['Employee',emp.name],['TIN',emp.tin||''],['Year',new Date().getFullYear()],
      [],['Period From','Period To','Gross Compensation','SSS','PhilHealth','Pag-IBIG','Taxable Compensation','Tax Withheld']];
    items.forEach(function (x) {
      rows.push([x.run.from,x.run.to,x.item.gross,x.item.sss,x.item.ph,x.item.pi,x.item.taxableCompensation,x.item.tax]);
    });
    rows.push([],['TOTAL','',
      items.reduce(function (s,x) { return s+x.item.gross; },0),
      items.reduce(function (s,x) { return s+x.item.sss; },0),
      items.reduce(function (s,x) { return s+x.item.ph; },0),
      items.reduce(function (s,x) { return s+x.item.pi; },0),
      items.reduce(function (s,x) { return s+(x.item.taxableCompensation||0); },0),
      items.reduce(function (s,x) { return s+x.item.tax; },0)]);
    rows.push([],['Note','Worksheet for review and official form preparation; not a substitute for the signed BIR Form 2316.']);
    downloadCsv('BIR_2316_Worksheet_'+emp.eid+'.csv', rows);
    toast('BIR 2316 worksheet generated.', 'success');
  };

  window.generateBankFile = function (bank) {
    var run = latestApprovedRun();
    if (!run) { toast('Approve and lock payroll before generating a bank file.', 'warning'); return; }
    var rows = [['Bank','Account Number','Account Name','Employee No.','Amount','Reference']];
    run.items.forEach(function (i) {
      var e = USERS.find(function (u) { return u.id === i.empId; }) || {};
      if ((e.bank || '').toLowerCase() === bank.toLowerCase()) rows.push([e.bank,e.bankAccount||'',i.name,i.eid,i.net,'PAY-'+run.id]);
    });
    if (rows.length === 1) { toast('No employees in this run use '+bank+'.', 'info'); return; }
    downloadCsv(bank.replace(/\s+/g,'_')+'_Payroll_'+run.from+'_'+run.to+'.csv', rows);
    toast(bank+' disbursement file generated.', 'success');
  };

  window.renderGovtReports = renderGovtReports = function () {
    var run = latestApprovedRun();
    if (!run) return '<div class="empty-state"><div class="ei">📋</div>Approve and lock a payroll run to generate statutory reports.</div>';
    var cards = [
      {type:'SSS',name:'SSS R3 Worksheet',detail:'Employee and employer shares · '+COMPLIANCE_VERSION.sss,color:'blue'},
      {type:'PHIC',name:'PhilHealth RF-1 Worksheet',detail:COMPLIANCE_VERSION.philhealth,color:'green'},
      {type:'HDMF',name:'Pag-IBIG MCRF Worksheet',detail:COMPLIANCE_VERSION.pagibig,color:'amber'},
      {type:'BIR',name:'BIR 1601-C Worksheet',detail:COMPLIANCE_VERSION.bir,color:'red'}
    ];
    return '<div style="padding:9px 12px;background:var(--green-bg);color:var(--green-txt);border-radius:8px;margin-bottom:12px;font-size:12px">'+
      'Generating from approved payroll <strong>'+run.from+' – '+run.to+'</strong> · '+esc(run.complianceVersion || COMPLIANCE_VERSION.label)+'</div>'+
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem">'+cards.map(function (c) {
        return '<div class="card" style="margin:0;border-left:3px solid var(--'+c.color+')"><div class="card-title">'+c.name+'</div>'+
          '<div class="card-sub" style="min-height:34px;margin:5px 0 10px">'+c.detail+'</div>'+
          '<button class="btn btn-sm" style="width:100%;justify-content:center" onclick="generateGovtReport(\''+c.type+'\')">Download CSV worksheet</button></div>';
      }).join('')+'</div>'+
      '<div class="card" style="margin-top:.75rem;margin-bottom:0"><div class="card-title">BIR 2316 annual data worksheets</div>'+
      '<div class="card-sub" style="margin-bottom:10px">Consolidates approved payroll data for official Form 2316 preparation and sign-off.</div>'+
      '<div style="display:grid;gap:5px">'+USERS.filter(function (u) { return u.role === 'employee'; }).map(function (e) {
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 9px;border:1px solid var(--border);border-radius:7px">'+
          '<div><div style="font-weight:600;font-size:12px">'+esc(e.name)+'</div><div style="font-size:10px;color:var(--txt3)">TIN '+esc(e.tin||'Not set')+'</div></div>'+
          '<button class="btn btn-sm" onclick="generate2316Worksheet('+e.id+')">Download worksheet</button></div>';
      }).join('')+'</div></div>';
  };

  window.renderBankFile = renderBankFile = function () {
    var run = latestApprovedRun();
    if (!run) return '<div class="empty-state"><div class="ei">🏦</div>Approve and lock payroll before generating disbursement files.</div>';
    var banks = ['UnionBank','BDO','BPI','Metrobank','Security Bank','Land Bank','PNB'];
    return '<div style="font-size:13px;color:var(--txt2);margin-bottom:10px">Approved payroll: <strong>'+run.from+' – '+run.to+'</strong></div>'+
      '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem">'+banks.map(function (b) {
        var count = run.items.filter(function (i) {
          var e = USERS.find(function (u) { return u.id === i.empId; }) || {};
          return (e.bank || '').toLowerCase() === b.toLowerCase();
        }).length;
        return '<div class="card" style="margin:0"><div class="card-title">🏦 '+b+'</div><div class="card-sub">'+count+' employee(s)</div>'+
          '<button class="btn btn-sm btn-primary" style="margin-top:9px;width:100%;justify-content:center" onclick="generateBankFile(\''+b+'\')">Generate CSV</button></div>';
      }).join('')+'</div>';
  };

  /* Mark previously finalized demo runs as approved if any are restored later. */
  PAYROLLS.forEach(function (r) {
    if (!r.status) r.status = 'approved';
  });

  render();
}());
