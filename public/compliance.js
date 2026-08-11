/*
 * SproutRipple PH compliance extension
 * Rules verified against primary PH government publications as of 2026-08-03.
 * This remains a configurable payroll engine: employers must validate company-
 * specific policies, exemptions, minimum-wage treatment, and filing formats.
 */
(function () {
  'use strict';

  var COMPLIANCE_VERSION = {
    label: 'PH statutory rules verified 03 Aug 2026',
    sss: 'Effective 01 Jan 2025 · 15% total · MSC ₱5,000–₱35,000',
    philhealth: 'CY 2025 schedule · 5% total · ₱10,000–₱100,000 MBS',
    pagibig: 'Effective 01 Feb 2024 · MFS ₱10,000',
    bir: 'RR 11-2018 annualization · RR 29-2025 de minimis · 1601-C 2018 ENCS'
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

  // Routes a decision through the employee's configured multi-layer approval chain
  // (Company Settings > Approval Layers) instead of a single flat status flip. Employees
  // with no configured chain (no immediateHeadEid hierarchy set up) fall back to the old
  // behavior — any user who can see the pending queue can act directly.
  function applyAttendanceDecision(row, decision) {
    var emp = USERS.find(function (u) { return u.id === row.eid; });
    var chain = (emp && typeof getApprovalChain === 'function') ? getApprovalChain(emp.eid) : [];
    var currentLayer = row.approvalLayer || 1;
    var layerEntry = chain.find(function (c) { return c.layer === currentLayer; });
    var isDesignatedApprover = layerEntry && user && layerEntry.approver.id === user.id;
    var isAdmin = user && (isAdminUser(user) || isPlatformAdmin);
    if (layerEntry && !isDesignatedApprover && !isAdmin) {
      return { ok: false, message: 'Only '+layerEntry.approver.name+' (Layer '+currentLayer+' approver) can act on this record.' };
    }
    var actor = user ? user.name : 'Administrator';
    if (decision === 'rejected') {
      row.approvalStatus = 'rejected'; row.reviewedBy = actor; row.reviewedAt = new Date().toISOString();
      row.approvalHistory = (row.approvalHistory || []).concat([{ layer: currentLayer, decision: 'rejected', by: actor, at: new Date().toISOString() }]);
      return { ok: true, message: 'Attendance rejected.', decision: 'rejected' };
    }
    row.approvalHistory = (row.approvalHistory || []).concat([{ layer: currentLayer, decision: 'approved', by: actor, at: new Date().toISOString() }]);
    if (layerEntry && currentLayer < chain.length) {
      row.approvalLayer = currentLayer + 1;
      return { ok: true, message: 'Approved at Layer '+currentLayer+'. Routed to Layer '+(currentLayer+1)+' ('+chain[currentLayer].approver.name+').', decision: 'approved' };
    }
    row.approvalStatus = 'approved'; row.reviewedBy = actor; row.reviewedAt = new Date().toISOString();
    return { ok: true, message: 'Attendance approved.', decision: 'approved' };
  }

  window.actAttendance = function (id, decision) {
    var row = ATT.find(function (a) { return a.id === id; });
    if (!row) return;
    var result = applyAttendanceDecision(row, decision);
    if (!result.ok) { toast(result.message, 'warning'); return; }
    queueSync('Attendance');
    toast(result.message, result.decision === 'approved' ? 'success' : 'warning');
    render();
  };

  window.approveAllAttendance = function () {
    var pending = attendanceRecords().filter(function (a) { return a.approvalStatus === 'pending'; });
    var acted = 0;
    pending.forEach(function (a) { if (applyAttendanceDecision(a, 'approved').ok) acted++; });
    if (acted) queueSync('Attendance');
    toast(acted ? acted+' attendance record(s) approved.' : 'No pending attendance you can approve.', acted ? 'success' : 'info');
    render();
  };

  // Admin-only escape hatch: skip any remaining approval layers (e.g. an approver is
  // unavailable) rather than leaving payroll blocked on a stuck chain.
  window.forceApproveAttendance = function (id) {
    if (!(user && (isAdminUser(user) || isPlatformAdmin))) return;
    var row = ATT.find(function (a) { return a.id === id; });
    if (!row) return;
    if (!confirm('Force-approve this record, skipping any remaining approval layers?')) return;
    var actor = user.name;
    row.approvalStatus = 'approved'; row.reviewedBy = actor+' (forced)'; row.reviewedAt = new Date().toISOString();
    row.approvalHistory = (row.approvalHistory || []).concat([{ layer: row.approvalLayer || 1, decision: 'force-approved', by: actor, at: new Date().toISOString() }]);
    queueSync('Attendance');
    toast('Force-approved.', 'success');
    render();
  };

  window.pgAttendance = pgAttendance = function () {
    var isA = isAdminUser(user) || isPlatformAdmin || canAccess('att_edit');
    var tabs = isA ? ['Pending Approval','My Records','Time Logs','File Attendance','Attendance Report'] : ['My Records','File Attendance'];
    var body = '';

    if (isA && tab === 0) {
      var pending = attendanceRecords().filter(function (a) { return a.approvalStatus === 'pending'; }).sort(function (a,b) {
        return (b.date+b.id).localeCompare(a.date+a.id);
      });
      var isAdminView = isAdminUser(user) || isPlatformAdmin;
      body = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'+
        '<div><div class="card-title">Attendance approval queue</div><div class="card-sub">Routed through each employee\'s configured approval layers (Company Settings &gt; Approval Layers). Only approved records are included in payroll.</div></div>'+
        '<button class="btn btn-sm btn-success" onclick="approveAllAttendance()" '+(!pending.length?'disabled':'')+'>Approve all I can ('+pending.length+')</button></div>'+
        '<div style="overflow-x:auto"><table><thead><tr><th>Employee</th><th>Date</th><th>In / Out</th><th>Work status</th><th>OT</th><th>ND</th><th>Filed by</th><th>Reason</th><th>Awaiting</th><th>Actions</th></tr></thead><tbody>'+
        (pending.length ? pending.map(function (a) {
          var emp = USERS.find(function (u) { return u.id === a.eid; });
          var chain = (emp && typeof getApprovalChain === 'function') ? getApprovalChain(emp.eid) : [];
          var currentLayer = a.approvalLayer || 1;
          var layerEntry = chain.find(function (c) { return c.layer === currentLayer; });
          var awaiting = layerEntry ? 'Layer '+currentLayer+' · '+esc(layerEntry.approver.name) : 'Any approver';
          return '<tr><td><div class="emp-cell"><div class="avatar sm">'+ini(emp ? emp.name : '?')+'</div><div><div style="font-weight:600">'+esc(emp ? emp.name : '?')+'</div><div style="font-size:10px;color:var(--txt3)">'+esc(emp ? emp.eid : '')+'</div></div></div></td>'+
            '<td class="mono">'+a.date+'</td><td class="mono">'+(a.tin || '—')+' – '+(a.tout || '—')+'</td>'+
            '<td><span class="badge b-'+a.status+'">'+esc(a.status)+'</span></td><td>'+(a.ot || '—')+'</td><td>'+(a.nd || '—')+'</td>'+
            '<td style="font-size:11px;color:var(--txt3)">'+esc(a.filedBy || 'Employee')+'</td>'+
            '<td style="font-size:11px;color:var(--txt3);max-width:220px">'+esc(a.notes || '—')+'</td>'+
            '<td style="font-size:11px">'+awaiting+(chain.length?' <span style="color:var(--txt3)">('+currentLayer+'/'+chain.length+')</span>':'')+'</td>'+
            '<td><div class="action-row"><button class="btn btn-sm btn-success" onclick="actAttendance('+a.id+',\'approved\')">Approve</button>'+
            '<button class="btn btn-sm btn-danger" onclick="actAttendance('+a.id+',\'rejected\')">Reject</button>'+
            (isAdminView ? '<button class="btn btn-sm" onclick="forceApproveAttendance('+a.id+')" title="Skip remaining approval layers">Force Approve</button>' : '')+
            '</div></td></tr>';
        }).join('') : '<tr><td colspan="10" class="empty-state">No pending attendance records.</td></tr>')+
        '</tbody></table></div>';
    } else if ((!isA && tab === 0) || (isA && tab === 1)) {
      var mine = attendanceRecords().filter(function (a) { return a.eid === user.id; }).slice().reverse();
      body = '<div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Work status</th><th>Approval</th><th>OT</th><th>ND</th><th>Notes</th><th></th></tr></thead><tbody>'+
        (mine.length ? mine.map(function (a) {
          return '<tr><td class="mono">'+a.date+'</td><td class="mono">'+(a.tin || '—')+'</td><td class="mono">'+(a.tout || '—')+'</td>'+
            '<td><span class="badge b-'+a.status+'">'+esc(a.status)+'</span></td><td>'+approvalBadge(a.approvalStatus)+'</td>'+
            '<td>'+(a.ot || '—')+'</td><td>'+(a.nd || '—')+'</td><td style="color:var(--txt3)">'+esc(a.notes || '—')+'</td>'+
            '<td style="white-space:nowrap">'+((a.edits && a.edits.length) ? '<button class="btn btn-sm" onclick="openAttHistory('+a.eid+',\''+a.date+'\')" title="View edit history">🕘 '+a.edits.length+'</button>' : '')+'</td></tr>';
        }).join('') : '<tr><td colspan="9" class="empty-state">No attendance records.</td></tr>')+'</tbody></table></div>';
    } else if (isA && tab === 2) {
      body = renderTimeLogsTab();
    } else if (isA && tab === 4) {
      body = renderAttendanceReportTab();
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
      '<div class="tabs">'+tabs.map(function (t,i) { return '<div class="tab'+(tab===i?' active':'')+'" onclick="goTab('+i+')">'+t+(i===0&&isA?redBubble(pendingCount):'')+'</div>'; }).join('')+'</div>'+
      '<div class="card">'+body+'</div>';
  };

  // Attendance Report / Time Logs share this whole filter+search+detail-view+export engine,
  // each keyed by its own namespace ('attReport' / 'timeLogs') so switching tabs never clobbers
  // the other tab's in-progress filter. A payroll-ready Excel export — a Summary sheet with one
  // totals row per employee (days present/absent, late, undertime, OT, ND, rest day/holiday
  // hours, hours worked), computed via the exact same TimekeepingCore.periodSummary() payroll
  // itself uses so the numbers here never drift from what actually gets paid — plus a Detailed
  // sheet with a day-by-day breakdown per employee, for whoever needs to see the logs behind the
  // totals.
  function attReportFilter(ns) {
    if (!window._attReportFilters) window._attReportFilters = {};
    if (!window._attReportFilters[ns]) {
      // Blank by default on both tabs — nothing renders until the user actually picks a range
      // and/or searches for someone, rather than dumping today's (or everyone's) data unasked.
      window._attReportFilters[ns] = { periodId:'custom', from:'', to:'', empSearch:'' };
    }
    return window._attReportFilters[ns];
  }
  window.setAttReportFilter = function (ns, key, value) {
    attReportFilter(ns)[key] = value;
    render();
  };
  // Bound to onblur, not onchange: a native date input fires 'change' as soon as day/month/year
  // all look plausible, then AGAIN each time a later year digit refines it — while the user is
  // still mid-keystroke on the year. Reacting to that (rebuilding the tab's HTML, which destroys
  // and recreates this exact <input>) mid-edit corrupts whatever partial year they were typing —
  // it looked like typing "stopped after the first digit." Committing only once focus actually
  // leaves the field sidesteps this entirely; the user is done editing by then either way.
  window.setAttReportDateFilter = function (ns, key, value) {
    attReportFilter(ns)[key] = value;
    render();
  };
  // Same multi-value search as the Employee list (tokenizeSearch/filterEmps, index.html) — typing
  // narrows live, and pasting a column of names/EIDs straight from Excel (newline/tab/comma
  // separated) works the same way it does there, so this doesn't need its own bespoke picker.
  window.setAttReportEmpSearch = function (ns, val) {
    attReportFilter(ns).empSearch = val;
    render();
    refocusSearch(ns+'-emp-search');
  };
  window.onAttReportSearchPaste = function (ns, event) {
    event.preventDefault();
    var raw = (event.clipboardData || window.clipboardData).getData('text');
    var el = event.target, s = el.selectionStart||0, e2 = el.selectionEnd||0;
    var current = attReportFilter(ns).empSearch||'';
    setAttReportEmpSearch(ns, current.slice(0,s)+raw+current.slice(e2));
  };
  window.removeAttReportSearchTerm = function (ns, i) {
    var terms = tokenizeSearch(attReportFilter(ns).empSearch||'');
    terms.splice(i,1);
    setAttReportEmpSearch(ns, terms.join('\n'));
  };
  function attReportMatchedEmps(ns) {
    var allEmps = USERS.filter(function (u) { return u.role === 'employee'; });
    var q = (attReportFilter(ns).empSearch||'').trim();
    return (q ? filterEmps(allEmps, q) : allEmps).sort(function (a,b) { return (a.name||'').localeCompare(b.name||''); });
  }
  function attReportRange(ns) {
    var f = attReportFilter(ns);
    if (f.periodId && f.periodId !== 'custom') {
      var period = PAY_PERIODS.find(function (p) { return String(p.id) === String(f.periodId); });
      if (period) return { from: period.attendanceFrom || period.from, to: period.attendanceTo || period.to, label: period.label };
    }
    return { from: f.from, to: f.to, label: null };
  }
  // opts.showMatchList: render the "type a name to peek at their daily detail" list (Attendance
  // Report only — Time Logs already shows every matching record in its own table, so a second
  // preview list there would just be a redundant read of the same data).
  // opts.rangeOptional: Time Logs treats an empty range as "no date filter" rather than an error.
  function renderAttReportFilterUI(ns, opts) {
    opts = opts || {};
    var f = attReportFilter(ns);
    var periods = PAY_PERIODS.slice().sort(function (a,b) { return (b.from||'').localeCompare(a.from||''); });
    var usingCustom = !f.periodId || f.periodId === 'custom';
    var range = attReportRange(ns);
    var allEmpsCount = USERS.filter(function (u) { return u.role === 'employee'; }).length;
    var searchVal = f.empSearch||'';
    var terms = tokenizeSearch(searchVal);
    var matched = attReportMatchedEmps(ns);
    var periodId = ns+'-period', dateFromId = ns+'-date-from', dateToId = ns+'-date-to', searchId = ns+'-emp-search', dlId = ns+'-download';
    // A plain tabindex sequence turned out not to be reliable here: once focus is inside a native
    // <input type="date">, Chrome's internal month/day/year segment navigation can hand focus off
    // to the next DOM-order element on exit rather than respecting another element's explicit
    // tabindex — so Tab from "From" was landing in the sidebar instead of "To". Driving the whole
    // sequence explicitly from a shared keydown handler sidesteps the browser's own tab-order
    // logic entirely: Tab always jumps to the next field ID we name, Shift+Tab to the previous.
    var seq = usingCustom ? [periodId, dateFromId, dateToId, searchId, dlId] : [periodId, searchId, dlId];
    function navAttr(id) {
      var i = seq.indexOf(id);
      return ' onkeydown="attReportTabNav(event,\''+(i+1<seq.length?seq[i+1]:'')+'\',\''+(i>0?seq[i-1]:'')+'\')"';
    }
    return '<div class="field"><label>Pay Period</label><select id="'+periodId+'"'+navAttr(periodId)+' onchange="setAttReportFilter(\''+ns+'\',\'periodId\', this.value)">'+
        '<option value="custom" '+(usingCustom?'selected':'')+'>Custom date range…</option>'+
        periods.map(function (p) { return '<option value="'+p.id+'" '+(String(f.periodId)===String(p.id)?'selected':'')+'>'+esc(p.label)+'</option>'; }).join('')+
      '</select></div>'+
      (usingCustom ?
        '<div class="form-row">'+
          '<div class="field"><label>From</label><input id="'+dateFromId+'"'+navAttr(dateFromId)+' type="date" value="'+(f.from||'')+'" onblur="setAttReportDateFilter(\''+ns+'\',\'from\', this.value)"/></div>'+
          '<div class="field"><label>To</label><input id="'+dateToId+'"'+navAttr(dateToId)+' type="date" value="'+(f.to||'')+'" onblur="setAttReportDateFilter(\''+ns+'\',\'to\', this.value)"/></div>'+
        '</div>'
        : '')+
      '<div class="field"><label>Employee(s)</label>'+
        '<div style="position:relative;display:flex;align-items:center">'+
          '<input id="'+searchId+'"'+navAttr(searchId)+' class="finput" placeholder="Search by name, ID, dept, position… or paste multiple from Excel (one per line) — leave blank for all employees" '+
          'value="'+esc(searchVal.replace(/[\n\r]+/g,' | ').replace(/\t+/g,' '))+'" oninput="setAttReportEmpSearch(\''+ns+'\', this.value)" onpaste="onAttReportSearchPaste(\''+ns+'\', event)"/>'+
          (searchVal?'<button onclick="setAttReportEmpSearch(\''+ns+'\', \'\')" style="position:absolute;right:10px;background:none;border:none;cursor:pointer;color:var(--txt3);font-size:18px;line-height:1" title="Clear search">×</button>':'')+
        '</div>'+
        (terms.length>1?
          '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:7px;padding:7px 10px;background:var(--accent-bg);border-radius:8px">'+
            '<span style="font-size:11px;font-weight:600;color:var(--accent-txt);margin-right:2px">Searching '+terms.length+' terms:</span>'+
            terms.map(function (t,i) { return '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--accent);color:#fff;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:500">'+esc(t)+
              '<span onclick="removeAttReportSearchTerm(\''+ns+'\','+i+')" style="cursor:pointer;opacity:.8;font-size:13px;line-height:1">×</span></span>'; }).join('')+
          '</div>' : '')+
        '<div style="font-size:11px;color:var(--txt3);margin-top:5px">'+(searchVal.trim()?matched.length+' of '+allEmpsCount+' employee(s) matched':'All '+allEmpsCount+' employees will be included')+'</div>'+
      '</div>'+
      (range.from && range.to ?
        '<div style="padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--txt3);margin-bottom:12px">Report range: <strong style="color:var(--txt)">'+range.from+' to '+range.to+'</strong>'+(range.label?' ('+esc(range.label)+')':'')+'</div>'
        : (opts.rangeOptional
            ? '<div style="padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--txt3);margin-bottom:12px">No date filter — showing logs from every date. Pick a pay period or range to narrow it down, or to download a report.</div>'
            : '<div style="padding:9px 12px;background:var(--amber-bg);border-radius:8px;font-size:12px;color:var(--amber-txt);margin-bottom:12px">Select a pay period or a custom date range.</div>'))+
      (opts.showMatchList && range.from && range.to && searchVal.trim() && matched.length ? renderAttReportMatchList(matched, range, ns) : '')+
      '<button id="'+dlId+'" class="btn btn-primary"'+navAttr(dlId)+' onclick="downloadAttendanceReport(\''+ns+'\')" '+(!range.from||!range.to?'disabled title="Select a pay period or date range first"':'')+'>⬇ Download Attendance Report (Excel)</button>';
  }
  // Drives Tab/Shift+Tab through this form's own fields explicitly by element ID, instead of
  // relying on the browser's native tab order (see renderAttReportFilterUI's comment on why).
  //
  // Why this can't just call el.focus() directly: the date fields commit on blur
  // (setAttReportDateFilter -> render()), which rebuilds this whole tab's HTML via innerHTML.
  // Calling focus() on the "next" element while the "current" one is still focused fires that
  // element's blur handler first — which tears down and replaces the entire DOM subtree
  // (including the very node we just grabbed a reference to) before the focus() call can land,
  // so focus silently falls back to <body>. Blurring the current field ourselves FIRST — letting
  // any render() it triggers finish completely — and only then looking the target up fresh by ID
  // avoids that race. This has to stay synchronous (no setTimeout/rAF): a backgrounded/headless
  // page throttles deferred timers, which made an earlier setTimeout-based version of this
  // intermittently skip the very next field.
  window.attReportTabNav = function (event, nextId, prevId) {
    if (event.key !== 'Tab') return;
    var targetId = event.shiftKey ? prevId : nextId;
    if (!targetId) return; // first/last field in the sequence — let the browser do its normal thing
    event.preventDefault();
    var current = event.target;
    if (current && typeof current.blur === 'function') current.blur();
    var el = document.getElementById(targetId);
    if (el) el.focus();
  };
  function renderAttendanceReportTab() {
    var range = attReportRange('attReport');
    return '<div class="card-title" style="margin-bottom:6px">Attendance Report</div>'+
      '<div class="card-sub" style="margin-bottom:14px">Export a payroll-ready attendance report for one pay period (or a custom date range) — a per-employee summary plus the full daily breakdown behind it.</div>'+
      renderAttReportFilterUI('attReport', { showMatchList:true })+
      '<div style="margin-top:10px;padding:10px 12px;background:var(--amber-bg);border-radius:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">'+
        '<div style="font-size:12px;color:var(--amber-txt);flex:1;min-width:200px">Find every scheduled work day in this range with no time log at all (no biometric, Web Bundy, or manual entry), and mark it LWOP.</div>'+
        '<button class="btn btn-sm btn-amber" onclick="flagMissingLogsAsLWOP(\'attReport\')" '+(!range.from||!range.to?'disabled title="Select a pay period or date range first"':'')+'>🔍 Flag Missing Logs as LWOP</button>'+
      '</div>';
  }
  // The 4th automatic attendance rule ("kulang ang time logs -> automatic LWOP") can't run off a
  // punch event like the other three (computeFromPunches has nothing to compute from when there
  // are literally zero punches for the day) — it needs a day to have fully passed with nothing
  // recorded at all, which only an explicit, reviewable sweep over a date range can determine
  // safely. Skips rest days, days with no shift configured (nothing to be late/absent against),
  // and days covered by an approved leave request — and never touches a day that already has a
  // record, however that record got there.
  window.flagMissingLogsAsLWOP = function (ns) {
    if (!(isAdminUser(user) || isPlatformAdmin || canAccess('att_edit'))) return;
    var range = attReportRange(ns);
    if (!range.from || !range.to) { toast('Select a pay period or date range first.', 'warning'); return; }
    var shifts = COMPANY.shifts || [];
    var emps = attReportMatchedEmps(ns).filter(function (u) { return u.active !== false; });
    var dates = leaveDateRange(range.from, range.to);
    var candidates = [];
    emps.forEach(function (emp) {
      dates.forEach(function (date) {
        if (emp.hired && date < emp.hired) return;
        if (TimekeepingCore.isRestDay(emp, date, shifts)) return;
        if (!TimekeepingCore.scheduleForDate(emp, date, shifts)) return;
        var onLeave = LEAVES.some(function (l) { return l.eid === emp.id && l.status === 'approved' && date >= l.s && date <= l.e; });
        if (onLeave) return;
        if (attendanceRecord(emp.id, date)) return;
        candidates.push({ emp: emp, date: date });
      });
    });
    if (!candidates.length) { toast('No missing logs found in this range for the matched employees.', 'info'); return; }
    if (!confirm('Found '+candidates.length+' scheduled work day(s) with no time log at all, from '+range.from+' to '+range.to+'.\n\nMark all of these LWOP (Leave Without Pay / Absent)? Nothing existing is touched — each gets a clearly-labeled new record you can review or edit afterward.')) return;
    candidates.forEach(function (c) {
      upsertAttendance(c.emp.id, c.date, { tin:'', tout:'', status:'absent', ot:0, nd:0, notes:'LWOP — no time log on record for this scheduled work day', source:'attendance-policy', approvalStatus:'approved', filedBy:'Attendance Policy' });
    });
    queueSync('Attendance');
    toast(candidates.length+' day(s) marked LWOP for missing time logs.', 'success');
    render();
  };
  // Time Logs: the same filter/search engine as Attendance Report, but for browsing and editing
  // the underlying records directly instead of only exporting them.
  var ATT_SOURCE_LABEL = { 'zkteco-import':'Biometric (ZKTeco)', 'zkteco-realtime':'Biometric (ZKTeco)', 'web-bundy':'Web Bundy (GPS)', 'bulk-import':'Bulk Import', 'admin-entry':'Admin Entry', 'employee-entry':'Employee Entry', 'admin-edit':'Admin Edit', 'leave-approval':'Leave Approval' };
  // Time Logs is the raw punch-event view — every individual clock in/out, from every source
  // (Web Bundy's GPS taps, biometric/ZKTeco device imports, manual entries alike) — as distinct
  // from Attendance Report's per-employee daily SUMMARY (one row/day, in/out/status/OT/ND as
  // payroll sees it). BUNDY_LOGS is already one row per punch; each ATT record (raw, including
  // ones later merged into another record for the same day — see Time Logs' own "all logs"
  // fix) is split into its own Clock In row and Clock Out row so a tin/tout pair reads the same
  // way a single device punch would.
  // Shared by the on-screen Time Logs table and its Excel export, so the two never drift apart:
  // every individual punch for the given employees within range (or ever, if range is blank),
  // plus a synthetic "no logs" placeholder for anyone in matchedEmps who has none, so a matched
  // employee never just disappears from either view.
  function collectTimeLogPunches(matchedEmps, range) {
    var matchedIds = {};
    matchedEmps.forEach(function (u) { matchedIds[u.id] = true; });
    function passFilter(eid, date) {
      if (range.from && range.to && !(date>=range.from && date<=range.to)) return false;
      return matchedIds[eid];
    }
    var punches = [];
    BUNDY_LOGS.forEach(function (b) {
      if (!passFilter(b.eid, b.date)) return;
      var hasCoords = b.lat != null && b.lng != null;
      punches.push({ eid:b.eid, empName:b.empName, date:b.date, time:b.time, type:b.type==='in'?'Clock In':'Clock Out',
        source:'Web Bundy (GPS)',
        location: b.address || (hasCoords ? b.lat+', '+b.lng : ''), lat:b.lat, lng:b.lng, withinZone:b.withinZone,
        detail: (b.zoneResult && b.zoneResult.zone) ? b.zoneResult.zone.name : '', approvalStatus:null });
    });
    ATT.forEach(function (a) {
      if (!passFilter(a.eid, a.date)) return;
      var emp = USERS.find(function (u) { return u.id === a.eid; });
      var source = ATT_SOURCE_LABEL[a.source] || (a.source ? a.source : 'Manual');
      var detail = a.superseded ? 'Merged into another record for this day' : (a.notes||'');
      if (a.tin) punches.push({ eid:a.eid, empName:emp?emp.name:'?', date:a.date, time:a.tin, type:'Clock In', source:source, detail:detail, approvalStatus:a.approvalStatus, recEid:a.eid, recDate:a.date, edits:a.edits });
      if (a.tout) punches.push({ eid:a.eid, empName:emp?emp.name:'?', date:a.date, time:a.tout, type:'Clock Out', source:source, detail:detail, approvalStatus:a.approvalStatus, recEid:a.eid, recDate:a.date, edits:a.edits });
    });
    punches.sort(function (x,y) { return (y.date+(y.time||'')).localeCompare(x.date+(x.time||'')); });
    var hasPunches = {};
    punches.forEach(function (p) { hasPunches[p.eid] = true; });
    matchedEmps.filter(function (u) { return !hasPunches[u.id]; })
      .sort(function (a,b) { return (a.name||'').localeCompare(b.name||''); })
      .forEach(function (u) { punches.push({ eid:u.id, empName:u.name, noLogs:true }); });
    return punches;
  }
  function renderTimeLogsTab() {
    var ns = 'timeLogs';
    var range = attReportRange(ns);
    var f = attReportFilter(ns);
    var searchVal = (f.empSearch||'').trim();
    var isFiltered = !!searchVal;
    // Nothing renders until someone is actually searched for — this is a lookup tool, not a feed
    // that dumps every employee's punches the moment the tab opens. Each matched employee gets a
    // row per punch they actually have in range, PLUS an explicit "no logs recorded" row if they
    // have none — so a searched-for employee never just silently vanishes from the results when
    // their range happens to be empty; that reads as "search is broken," not "no data."
    var matched = isFiltered ? attReportMatchedEmps(ns) : [];
    var punches = isFiltered ? collectTimeLogPunches(matched, range) : [];
    var tbody;
    if (!isFiltered) {
      tbody = '<tr><td colspan="9" class="empty-state">Search for an employee above to see their time logs.</td></tr>';
    } else if (!matched.length) {
      tbody = '<tr><td colspan="9" class="empty-state">No employees match this search.</td></tr>';
    } else {
      tbody = punches.map(function (p) {
        if (p.noLogs) {
          return '<tr><td><div class="emp-cell"><div class="avatar sm">'+ini(p.empName||'?')+'</div>'+esc(p.empName||'?')+'</div></td>'+
            '<td colspan="7" style="color:var(--txt3);font-style:italic">No logs recorded'+(range.from&&range.to?' in this range':'')+'.</td>'+
            '<td></td></tr>';
        }
        var hasCoords = p.lat != null && p.lng != null;
        var locationCell = hasCoords
          ? '<a href="https://www.google.com/maps?q='+p.lat+','+p.lng+'" target="_blank" rel="noopener" title="Open in Google Maps">'+esc(p.location||(p.lat+', '+p.lng))+'</a>'
          : esc(p.location||'—');
        var zoneBadge = p.withinZone===false ? ' <span class="badge b-absent" style="font-size:9px">⚠ Out</span>'
          : p.withinZone===true ? ' <span class="badge b-approved" style="font-size:9px">✓ In zone</span>' : '';
        return '<tr><td><div class="emp-cell"><div class="avatar sm">'+ini(p.empName||'?')+'</div>'+esc(p.empName||'?')+'</div></td>'+
          '<td class="mono">'+p.date+'</td><td class="mono">'+esc(p.time||'—')+'</td>'+
          '<td><span class="badge '+(p.type==='Clock In'?'b-present':'b-absent')+'">'+p.type+'</span></td>'+
          '<td style="font-size:11px;color:var(--txt3)">'+esc(p.source)+'</td>'+
          '<td style="font-size:11px;color:var(--txt3);max-width:200px">'+locationCell+zoneBadge+'</td>'+
          '<td style="font-size:11px;color:var(--txt3);max-width:200px">'+esc(p.detail||'—')+'</td>'+
          '<td>'+(p.approvalStatus?approvalBadge(p.approvalStatus):'—')+'</td>'+
          '<td style="white-space:nowrap">'+(p.recEid?'<button class="btn btn-sm" onclick="openEditAttRow('+p.recEid+',\''+p.recDate+'\')" title="Edit this record">✎ Edit</button> ':'')+
          '<button class="btn btn-sm" onclick="openAttReportDetailModal(\''+ns+'\','+p.eid+')" title="This employee\'s full daily breakdown">👁 View</button>'+
          ((p.edits && p.edits.length) ? ' <button class="btn btn-sm" onclick="openAttHistory('+p.recEid+',\''+p.recDate+'\')" title="View edit history">🕘 '+p.edits.length+'</button>' : '')+'</td></tr>';
      }).join('');
    }
    return '<div class="card-title" style="margin-bottom:6px">Time Logs</div>'+
      '<div class="card-sub" style="margin-bottom:14px">Every individual clock in/out event recorded — Web Bundy (GPS), biometric device imports, and manual entries alike. Search for an employee to see theirs. For the payroll-facing daily summary per employee, use Attendance Report instead.</div>'+
      renderAttReportFilterUI(ns, { showMatchList:false, rangeOptional:true })+
      '<div style="display:flex;justify-content:flex-end;margin:14px 0 10px"><button class="btn btn-sm" onclick="openBulkAttendance()">📂 Bulk Import Time Logs</button></div>'+
      '<div style="overflow-x:auto"><table><thead><tr><th>Employee</th><th>Date</th><th>Time</th><th>Punch</th><th>Source</th><th>Location</th><th>Details</th><th>Approval</th><th>Actions</th></tr></thead><tbody>'+tbody+'</tbody></table></div>';
  }
  // Lets an admin inspect an employee's daily breakdown right in the app — the same numbers as
  // the Excel Detailed sheet — without having to download and open a spreadsheet just to check
  // one person's attendance.
  function renderAttReportMatchList(matched, range, ns) {
    var shown = matched.slice(0, 50);
    return '<div class="field"><label>Matched Employees'+(matched.length>shown.length?' (showing first 50 of '+matched.length+')':'')+'</label>'+
      '<div style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">'+
      '<table style="margin:0"><tbody>'+
      shown.map(function (u) {
        var hasPending = attendanceRecords().some(function (a) { return a.eid===u.id && a.date>=range.from && a.date<=range.to && a.approvalStatus==='pending'; });
        return '<tr><td style="font-size:12px">'+esc(u.name)+' <span style="color:var(--txt3);font-size:11px">('+esc(u.eid||'—')+')</span>'+(hasPending?redBubble(1):'')+'</td>'+
          '<td style="text-align:right;white-space:nowrap"><button class="btn btn-sm" onclick="openAttReportDetailModal(\''+ns+'\','+u.id+')">👁 View Detailed</button></td></tr>';
      }).join('')+
      '</tbody></table></div></div>';
  }
  window.openAttReportDetailModal = function (ns, empId) {
    if (!(isAdminUser(user) || isPlatformAdmin || canAccess('att_edit'))) return;
    var range = attReportRange(ns);
    if (!range.from || !range.to) { toast('Select a pay period or a date range first.', 'warning'); return; }
    var emp = USERS.find(function (u) { return u.id === empId; });
    if (!emp) return;
    var shifts = COMPANY.shifts || [], holidays = COMPANY.holidays || [];
    var summary = TimekeepingCore.periodSummary(ATT, emp, range.from, range.to, shifts, holidays);
    var byDate = {};
    summary.records.forEach(function (r) { byDate[r.date] = r; });
    var hoursWorked = 0;
    summary.records.forEach(function (r) {
      var a = hhmmToMinutesLocal(r.tin), b = hhmmToMinutesLocal(r.tout);
      if (a == null || b == null) return;
      if (b <= a) b += 24*60;
      hoursWorked += (b-a)/60;
    });
    var days = [];
    leaveDateRange(range.from, range.to).forEach(function (date) {
      var rec = byDate[date];
      var dow = ATT_REPORT_DOW[new Date(date+'T00:00:00Z').getUTCDay()];
      var sched = TimekeepingCore.scheduleForDate(emp, date, shifts);
      var isRest = TimekeepingCore.isRestDay(emp, date, shifts);
      var shiftLabel = isRest ? 'Rest Day' : (sched ? (sched.start+' – '+sched.end) : 'No shift assigned');
      if (!rec) { days.push({ date:date, dow:dow, shift:shiftLabel, tin:'—', tout:'—', status:isRest?'Rest Day':'No Record', approval:'', late:0, undertime:0, ot:0, nd:0, rdh:0, notes:'' }); return; }
      var lu = dailyLateUndertime(emp, rec, shifts);
      days.push({ date:date, dow:dow, shift:shiftLabel, tin:rec.tin||'—', tout:rec.tout||'—',
        status:ATT_REPORT_STATUS_LABEL[rec.status]||rec.status||'—', approval:approvalBadgeText(rec.approvalStatus),
        late:lu.late, undertime:lu.undertime, ot:rec.ot||0, nd:rec.nd||0, rdh:rec.restDayHolidayHours||0, notes:rec.notes||'' });
    });
    modal = { type:'attReportDetail', ns:ns, emp:{ id:emp.id, name:emp.name, eid:emp.eid, dept:emp.dept, pos:emp.pos },
      range:range, summary:{ presentDays:summary.presentDays, absentDays:summary.absentDays, lateMinutes:summary.lateMinutes,
        undertimeMinutes:summary.undertimeMinutes, otHours:summary.otHours, ndHours:summary.ndHours,
        restDayHolidayHours:summary.restDayHolidayHours, hoursWorked:+hoursWorked.toFixed(2) }, days:days };
    render();
  };
  function hhmmToMinutesLocal(v) {
    var parts = String(v || '').split(':');
    if (parts.length !== 2) return null;
    var h = Number(parts[0]), m = Number(parts[1]);
    return Number.isFinite(h) && Number.isFinite(m) ? h*60+m : null;
  }
  var ATT_REPORT_DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var ATT_REPORT_STATUS_LABEL = { present:'Present', late:'Late', absent:'Absent', leave:'On Leave' };
  // Every rest-day/holiday premium code TimekeepingCore.classifyHolidayPremium() can actually
  // produce (see its PH DOLE combinations), each broken into its own Summary column — rather
  // than one lumped "Rest Day/Holiday Hours" figure — so nothing worked on a holiday or rest day
  // is hidden inside a single number. Order matches roughly increasing premium rate.
  var ATT_REPORT_HOLIDAY_CODES = ['RDH_GENERIC','SH_8','SH_RD_8','RH_8','RH_RD_8','DH_8'];
  var ATT_REPORT_HOLIDAY_LABEL = { RDH_GENERIC:'Rest Day', SH_8:'Special Holiday', SH_RD_8:'Special Holiday+RD', RH_8:'Regular Holiday', RH_RD_8:'Regular Holiday+RD', DH_8:'Double Holiday' };
  // Mirrors TimekeepingCore.periodSummary()'s own per-record late/undertime formula exactly, so
  // a per-day figure here always sums to that function's authoritative period total in Summary —
  // periodSummary computes this internally but only returns the aggregate, not the per-day split.
  function dailyLateUndertime(emp, rec, shifts) {
    var sched = TimekeepingCore.scheduleForDate(emp, rec.date, shifts);
    var actualIn = hhmmToMinutesLocal(rec.tin), actualOut = hhmmToMinutesLocal(rec.tout);
    var shiftIn = sched && hhmmToMinutesLocal(sched.start), shiftOut = sched && hhmmToMinutesLocal(sched.end);
    var late = actualIn != null && shiftIn != null ? Math.max(0, actualIn - shiftIn - Number(sched.graceMinutes||0)) : 0;
    var undertime = actualOut != null && shiftOut != null ? Math.max(0, shiftOut - actualOut) : 0;
    return { late: rec.lateMinutes != null ? rec.lateMinutes : late, undertime: Math.max(Number(rec.undertimeMinutes||0), undertime) };
  }
  // Time Logs' download button shares the Attendance Report/Time Logs filter engine's UI (same
  // renderAttReportFilterUI, same button), but the two tabs mean completely different things by
  // "report": Attendance Report is the payroll-facing daily SUMMARY (periodSummary totals); Time
  // Logs is the raw punch-by-punch list the on-screen table shows. Downloading from Time Logs has
  // to produce the latter, not the former, or the file just doesn't match what the tab is showing.
  function downloadTimeLogsReport(emps, range) {
    var punches = collectTimeLogPunches(emps, range);
    var rows = [
      ['TIME LOGS — SproutRipple PH'],
      ['Period: '+(range.from&&range.to?range.from+' to '+range.to:'All dates')],
      ['Generated: '+today()+' by '+(user&&user.name||'')],
      [],
      ['Employee','EID','Date','Time','Punch','Source','Location','Details','Approval']
    ];
    punches.forEach(function (p) {
      var emp = USERS.find(function (u) { return u.id === p.eid; });
      if (p.noLogs) {
        rows.push([p.empName||'', emp?emp.eid||'':'', '', '', '', '', '', 'No logs recorded'+(range.from&&range.to?' in this range':'')+'.', '']);
        return;
      }
      var location = p.location ? p.location+(p.withinZone===false?' (outside zone)':p.withinZone===true?' (in zone)':'') : '—';
      rows.push([p.empName||'', emp?emp.eid||'':'', p.date||'', p.time||'', p.type||'', p.source||'', location, p.detail||'', p.approvalStatus?approvalBadgeText(p.approvalStatus):'—']);
    });
    try {
      var data = buildXLSX([
        { name:'Time Logs', rows:rows, colWidths:[26,14,14,10,12,20,26,26,14],
          textColIndices:new Set([1]), titleRows:new Set([0,1,2]), headerRows:new Set([4]),
          borderRows:(function(){var s=new Set();for(var r=4;r<rows.length;r++)s.add(r);return s;})(), freezeRow:5 }
      ]);
      var blob = new Blob([data], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url;
      a.download = 'time_logs_'+(range.from&&range.to?range.from+'_to_'+range.to:'all_dates')+'.xlsx'; a.click();
      URL.revokeObjectURL(url);
      toast('Time logs downloaded.', 'success');
    } catch (ex) {
      toast('Download failed: '+ex.message, 'warning'); console.error('[time-logs]', ex);
    }
  }
  window.downloadAttendanceReport = function (ns) {
    ns = ns || 'attReport';
    if (!(isAdminUser(user) || isPlatformAdmin || canAccess('att_edit'))) return;
    var range = attReportRange(ns);
    if (!range.from || !range.to) { toast('Select a pay period or a custom date range.', 'warning'); return; }
    if (range.to < range.from) { toast('"To" date must be on or after "From" date.', 'warning'); return; }
    var emps = attReportMatchedEmps(ns);
    if (!emps.length) { toast('No employees match this search.', 'warning'); return; }
    if (ns === 'timeLogs') { downloadTimeLogsReport(emps, range); return; }

    var shifts = COMPANY.shifts || [], holidays = COMPANY.holidays || [];
    var summaryHeaderRow = ['EID','Employee Name','Department','Position','Days Present','Days Absent','Late (min)','Undertime (min)','OT Hours','ND Hours']
      .concat(ATT_REPORT_HOLIDAY_CODES.map(function (c) { return ATT_REPORT_HOLIDAY_LABEL[c]+' (hrs)'; }))
      .concat(['Hours Worked','Needs Review']);
    var summaryRows = [
      ['ATTENDANCE REPORT — SproutRipple PH'],
      ['Period: '+range.from+' to '+range.to+(range.label?' ('+range.label+')':'')],
      ['Generated: '+today()+' by '+(user&&user.name||'')],
      [],
      summaryHeaderRow
    ];
    var detailedRows = [];
    var detailBlocks = []; // {headerRow, totalsRow} per employee, 0-based row indices into detailedRows

    emps.forEach(function (emp) {
      var summary = TimekeepingCore.periodSummary(ATT, emp, range.from, range.to, shifts, holidays);
      var byDate = {};
      summary.records.forEach(function (r) { byDate[r.date] = r; });
      var hoursWorked = 0, needsReview = false;
      summary.records.forEach(function (r) {
        if (r.approvalStatus === 'pending') needsReview = true;
        var a = hhmmToMinutesLocal(r.tin), b = hhmmToMinutesLocal(r.tout);
        if (a == null || b == null) return;
        if (b <= a) b += 24*60;
        hoursWorked += (b-a)/60;
      });
      var byCode = summary.restDayHolidayHoursByCode || {};

      summaryRows.push([emp.eid||'', emp.name||'', emp.dept||'', emp.pos||'', summary.presentDays, summary.absentDays, summary.lateMinutes, summary.undertimeMinutes, summary.otHours, summary.ndHours]
        .concat(ATT_REPORT_HOLIDAY_CODES.map(function (c) { return byCode[c] || 0; }))
        .concat([+hoursWorked.toFixed(2), needsReview?'Yes — pending approval in range':'No']));

      detailedRows.push(['Employee:', emp.name||'', 'EID:', emp.eid||'']);
      detailedRows.push(['Department:', emp.dept||'—', 'Position:', emp.pos||'—']);
      detailedRows.push(['Period:', range.from+' to '+range.to, 'Days Present:', summary.presentDays, 'Days Absent:', summary.absentDays]);
      var detailHeaderRowIdx = detailedRows.length;
      detailedRows.push(['Date','Day','Shift','Time In','Time Out','Status','Approval','Late (min)','Undertime (min)','OT (hrs)','ND (hrs)','Rest Day/Holiday (hrs)','Notes']);
      var totOt=0, totNd=0, totRdh=0;
      leaveDateRange(range.from, range.to).forEach(function (date) {
        var rec = byDate[date];
        var dow = ATT_REPORT_DOW[new Date(date+'T00:00:00Z').getUTCDay()];
        var sched = TimekeepingCore.scheduleForDate(emp, date, shifts);
        var isRest = TimekeepingCore.isRestDay(emp, date, shifts);
        var shiftLabel = isRest ? 'Rest Day' : (sched ? (sched.start+' – '+sched.end) : 'No shift assigned');
        if (!rec) {
          detailedRows.push([date, dow, shiftLabel, '—', '—', isRest?'Rest Day':'No Record', '—', 0, 0, 0, 0, 0, '']);
          return;
        }
        var lu = dailyLateUndertime(emp, rec, shifts);
        totOt += Number(rec.ot||0); totNd += Number(rec.nd||0); totRdh += Number(rec.restDayHolidayHours||0);
        detailedRows.push([date, dow, shiftLabel, rec.tin||'—', rec.tout||'—', ATT_REPORT_STATUS_LABEL[rec.status]||rec.status||'—', approvalBadgeText(rec.approvalStatus), lu.late, lu.undertime, rec.ot||0, rec.nd||0, rec.restDayHolidayHours||0, rec.notes||'']);
      });
      var totalsRowIdx = detailedRows.length;
      detailedRows.push(['','','','','','','Totals for period:', summary.lateMinutes, summary.undertimeMinutes, +totOt.toFixed(2), +totNd.toFixed(2), +totRdh.toFixed(2), +hoursWorked.toFixed(2)+' hrs worked']);
      detailedRows.push([]);
      detailBlocks.push({ headerRow: detailHeaderRowIdx, totalsRow: totalsRowIdx });
    });

    var detailHeaderRows = new Set(), detailBorderRows = new Set(), detailTitleRows = new Set();
    detailBlocks.forEach(function (block) {
      detailTitleRows.add(block.headerRow-3).add(block.headerRow-2).add(block.headerRow-1);
      detailHeaderRows.add(block.headerRow);
      for (var r = block.headerRow; r <= block.totalsRow; r++) detailBorderRows.add(r);
    });

    try {
      var data = buildXLSX([
        { name:'Summary', rows:summaryRows, colWidths:[14,30,20,26,11,11,10,14,9,9,15,22,25,22,25,20,13,34],
          textColIndices:new Set([0]), titleRows:new Set([0,1,2]), headerRows:new Set([4]), borderRows:(function(){var s=new Set();for(var r=4;r<summaryRows.length;r++)s.add(r);return s;})(), freezeRow:5 },
        // Column widths here have to satisfy double duty: the same column holds a short "Day"
        // abbreviation in the daily rows AND a full employee name / department / date-range
        // string in the per-employee header rows above it (col B), same story for col C (shift
        // label vs. position title) — sized to the wider of the two uses so neither gets cut off.
        { name:'Detailed', rows:detailedRows, colWidths:[14,30,22,26,14,12,20,12,16,10,10,22,34],
          textColIndices:new Set([0]), titleRows:detailTitleRows, headerRows:detailHeaderRows, borderRows:detailBorderRows }
      ]);
      var blob = new Blob([data], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'attendance_report_'+range.from+'_to_'+range.to+'.xlsx'; a.click();
      URL.revokeObjectURL(url);
      toast('Attendance report downloaded.', 'success');
    } catch (ex) {
      toast('Download failed: '+ex.message, 'warning'); console.error('[attendance-report]', ex);
    }
  };
  function approvalBadgeText(status) { return status ? (status.charAt(0).toUpperCase()+status.slice(1)) : 'Approved'; }

  window.submitAtt = submitAtt = function (isA) {
    var eid = isA ? parseInt(document.getElementById('ae').value, 10) : user.id;
    var date = document.getElementById('adate').value;
    if (!date) { toast('Select a date.', 'warning'); return; }
    var duplicate = attendanceRecord(eid,date);
    // computedAttendancePatch (index.html) folds tin/tout into the permanent punch log and
    // auto-derives late/undertime/OT/ND/attendance-policy (half day, LWOP) from them, the same
    // way biometric and Web Bundy punches already do -- filing or correcting a record by hand
    // shouldn't be the one path where none of that gets computed.
    var patch = computedAttendancePatch(eid, date,
      document.getElementById('atin').value, document.getElementById('atout').value, document.getElementById('ast').value,
      parseFloat(document.getElementById('aot').value) || 0, parseFloat(document.getElementById('and').value) || 0,
      document.getElementById('anotes').value.trim(), 'manual');
    upsertAttendance(eid,date,Object.assign(patch, {
      approvalStatus:isA ? 'approved' : 'pending',
      filedBy:user.name, filedAt:new Date().toISOString(),
      reviewedBy:isA ? user.name : '', reviewedAt:isA ? new Date().toISOString() : ''
    }));
    queueSync('Attendance');
    toast(isA ? (duplicate?'Authoritative attendance updated and approved.':'Attendance saved and approved.') : (duplicate?'Attendance update submitted for approval.':'Attendance submitted for approval.'), 'success');
    tab = isA ? 2 : 0;
    render();
  };

  function statutoryFactor(grp, period) {
    return PayrollRuleEngine.statutoryFactor(grp,period || {});
  }

  window.buildDraftRow = buildDraftRow = function (emp, grp, period) {
    var from = period && (period.attendanceFrom || period.from) || document.getElementById('pf') && document.getElementById('pf').value || today();
    var to = period && (period.attendanceTo || period.to) || document.getElementById('pt') && document.getElementById('pt').value || today();
    var logs = approvedAttendance(emp.id, from, to);
    var baseBasic = computeBasicByPayType(emp, grp, period);
    var monthlyRate = Number(emp.salaryPM) || 0;
    var dailyDivisor = Number(emp.dailyDivisor || COMPANY.dailyDivisor || 22);
    var dailyRate = monthlyRate && dailyDivisor ? monthlyRate / dailyDivisor : Number(emp.rate) || 0;
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
      return s + (Number(l.monthly) || 0) * PayrollRuleEngine.frequencyFactor(grp);
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
    if (!(isAdminUser(user) || canAccess('payroll_approve'))) { toast('You do not have payroll approval permission.', 'error'); return; }
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
    if (type === 'BIR') {
      var selectedMonth = window._bir1601CMonth || (latestApprovedRun() ? BIR1601CCore.runMonth(latestApprovedRun()) : reportingMonthFromDate(today()));
      var report = BIR1601CCore.aggregate(selectedMonth, PAYROLLS, FINAL_PAY_LIST);
      if (!report.entries.length) { toast('No approved payroll or released final pay is reportable for '+displayReportingMonth(selectedMonth)+'.', 'warning'); return; }
      var birRows = [
        ['BIR FORM 1601-C MONTHLY REMITTANCE WORKSHEET'],
        ['Item 1 - For the Month (MM/YYYY)', selectedMonth.slice(5,7)+'/'+selectedMonth.slice(0,4)],
        ['Basis','Approved/locked payroll and released final pay paid during the selected month'],
        [],
        ['1601-C Item','Description','Amount'],
        ['14','Total Amount of Compensation',report.totalCompensation],
        ['17','Non-Taxable 13th Month and Other Benefits',report.annualBenefitExempt],
        ['18','De Minimis Benefits',report.deMinimis],
        ['19','Mandatory employee SSS/PHIC/HDMF shares and union dues',report.mandatoryContributions],
        ['20','Other Non-Taxable Compensation',report.otherNonTaxable],
        ['21','Total Non-Taxable Compensation',report.totalNonTaxable],
        ['22','Total Taxable Compensation',report.taxableCompensation],
        ['23','Taxable Compensation not subject to withholding (annual compensation <= P250,000)',report.taxableNotSubjectToWithholding],
        ['24','Net Taxable Compensation',Math.max(0,report.taxableCompensation-report.taxableNotSubjectToWithholding)],
        ['25','Total Taxes Withheld',report.totalTaxesWithheld],
        ['Annualization control','Tax refunded to employees',report.annualizationRefunds],
        ['26','Adjustments from prior month(s)',report.annualizationRefunds?'-'+report.annualizationRefunds:'Enter approved BIR adjustment, if any'],
        ['27','Tax Required to be Remitted',report.taxRequiredForRemittance],
        ['Control','Excess annualization credit for review/carry-forward',report.excessAnnualizationCredit],
        [],
        ['Source','Release Date','Employee No.','Employee','TIN','Gross Compensation','13th Month/Other Benefits - Exempt','13th Month/Other Benefits - Taxable Excess','Mandatory Contributions','Other Non-Taxable','Taxable Compensation','Tax Withheld','Tax Refund','Net Tax']
      ];
      report.entries.forEach(function (entry) {
        var employee = USERS.find(function (u) { return u.id === entry.employeeId; }) || {};
        birRows.push([entry.source,entry.releaseDate,entry.employeeNo,entry.employeeName,employee.tin||'',entry.gross,entry.annualBenefitExempt,entry.annualBenefitTaxable,entry.mandatory,entry.otherNonTaxable,entry.taxable,entry.tax,entry.taxRefund,entry.netTax]);
      });
      birRows.push([],['CONTROL NOTE','Items 18, 23 and prior-month adjustments still require review against employee-level classifications and annualized records before filing the official return. Item 17 is sourced from the payroll benefit-bucket classification.']);
      downloadCsv('BIR_1601C_Worksheet_'+selectedMonth+'.csv', birRows);
      toast('1601-C worksheet generated for '+displayReportingMonth(selectedMonth)+' from '+report.regularRunCount+' payroll run(s) and '+report.finalPayCount+' final pay release(s).', 'success');
      return;
    }
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
    var approvedRuns = PAYROLLS.filter(function (r) { return r.status === 'approved' || r.status === 'locked'; });
    var taxYear = approvedRuns.reduce(function (year,r) { return Math.max(year,Number(r.taxYear||String(r.bir1601CMonth||r.releaseDate||r.to||'').slice(0,4))||0); },0)||new Date().getFullYear();
    var runs = approvedRuns.filter(function(r){return Number(r.taxYear||String(r.bir1601CMonth||r.releaseDate||r.to||'').slice(0,4))===taxYear;});
    if (!emp || !runs.length) { toast('No approved payroll data available.', 'warning'); return; }
    var items = [];
    runs.forEach(function (r) {
      var item = r.items.find(function (i) { return i.empId === empId; });
      if (item) items.push({run:r,item:item});
    });
    var profile=employeeTaxRecord(emp,taxYear,false)||{};
    var rows = [['BIR 2316 DATA WORKSHEET'],['Employee',emp.name],['TIN',emp.tin||''],['Year',taxYear],
      [],['PREVIOUS EMPLOYER CONSOLIDATION'],['Previous Employer',profile.previousEmployerName||''],['Previous Employer TIN',profile.previousEmployerTin||''],['Employment From',profile.previousEmploymentFrom||''],['Employment To',profile.previousEmploymentTo||''],['Previous Non-Taxable 13th Month & Other Benefits',Number(profile.previousEmployerNonTaxableBenefits||0)],['Previous Taxable 13th Month & Other Benefits',Number(profile.previousEmployerTaxableBenefits||0)],['Previous Employer Total Taxable Compensation',Number(profile.previousEmployerTaxable||0)],['Previous Employer Tax Withheld',Number(profile.previousEmployerTaxWithheld||0)],['BIR 2316 / Source Reference',profile.sourceReference||''],
      [],['CURRENT EMPLOYER PAYROLL DETAIL'],['Period From','Period To','Gross Compensation','13th/Other Benefits Exempt','13th/Other Benefits Taxable','SSS','PhilHealth','Pag-IBIG','Taxable Compensation','Tax Withheld']];
    items.forEach(function (x) {
      rows.push([x.run.from,x.run.to,x.item.gross,x.item.annualBenefitExempt||0,x.item.annualBenefitTaxable||0,x.item.sss,x.item.ph,x.item.pi,x.item.taxableCompensation,x.item.tax]);
    });
    rows.push([],['TOTAL','',
      items.reduce(function (s,x) { return s+x.item.gross; },0),
      items.reduce(function (s,x) { return s+(x.item.annualBenefitExempt||0); },0),
      items.reduce(function (s,x) { return s+(x.item.annualBenefitTaxable||0); },0),
      items.reduce(function (s,x) { return s+x.item.sss; },0),
      items.reduce(function (s,x) { return s+x.item.ph; },0),
      items.reduce(function (s,x) { return s+x.item.pi; },0),
      items.reduce(function (s,x) { return s+(x.item.taxableCompensation||0); },0),
      items.reduce(function (s,x) { return s+x.item.tax; },0)]);
    rows.push([],['ANNUAL BENEFIT CONTROL'],['Combined non-taxable benefit used',Number(profile.previousEmployerNonTaxableBenefits||0)+items.reduce(function(s,x){return s+Number(x.item.annualBenefitExempt||0);},0)],['Remaining from P90,000',Math.max(0,90000-Number(profile.previousEmployerNonTaxableBenefits||0)-items.reduce(function(s,x){return s+Number(x.item.annualBenefitExempt||0);},0))],[],['Note','Worksheet for review and official form preparation; not a substitute for the signed BIR Form 2316.']);
    downloadCsv('BIR_2316_Worksheet_'+emp.eid+'.csv', rows);
    toast('BIR 2316 worksheet generated.', 'success');
  };

  function downloadPdf(filename,bytes) {
    var blob=new Blob([bytes],{type:'application/pdf'}),link=document.createElement('a');
    link.href=URL.createObjectURL(blob);link.download=filename;document.body.appendChild(link);link.click();
    setTimeout(function(){URL.revokeObjectURL(link.href);link.remove();},1000);
  }

  window.generateOfficial1601CPDF = async function () {
    var selectedMonth=window._bir1601CMonth||(latestApprovedRun()?BIR1601CCore.runMonth(latestApprovedRun()):reportingMonthFromDate(today()));
    var report=BIR1601CCore.aggregate(selectedMonth,PAYROLLS,FINAL_PAY_LIST),missing=[];
    if(!report.entries.length){toast('No approved payroll or released final pay is reportable for '+displayReportingMonth(selectedMonth)+'.','warning');return;}
    if(!String(COMPANY.registeredName||COMPANY.name||'').trim())missing.push('registered employer name');
    if(!String(COMPANY.taxIdentificationNo||'').trim())missing.push('employer TIN');
    if(!String(COMPANY.rdo||'').trim())missing.push('employer RDO code');
    if(!String(COMPANY.registeredAddress||'').trim())missing.push('registered address');
    if(missing.length){toast('Complete Company Settings → BIR Employer Information: '+missing.join(', ')+'.','warning',7500);return;}
    try{
      toast('Generating official BIR Form 1601-C PDF…','info');
      var data=BIR1601CPdf.buildData({company:COMPANY,report:report,month:selectedMonth});
      var response=await fetch('/forms/bir-form-1601c-jan-2018.pdf');if(!response.ok)throw new Error('Official BIR template could not be loaded.');
      var bytes=await BIR1601CPdf.render(await response.arrayBuffer(),data,window.PDFLib);
      downloadPdf('BIR_1601C_'+selectedMonth+'.pdf',bytes);
      toast('Official BIR Form 1601-C draft generated. Review the return, adjustment schedule, payment details, and signatures before filing.','success',7500);
    }catch(error){toast('BIR 1601-C PDF could not be generated: '+error.message,'error',7000);}
  };

  window.generateOfficial2316PDF = async function (empId) {
    var emp=USERS.find(function(u){return u.id===empId;}),year=Number(window._bir2316Year||new Date().getFullYear());
    if(!emp){toast('Employee was not found.','warning');return;}
    var profile=employeeTaxRecord(emp,year,false)||{},missing=[];
    if(!String(COMPANY.taxIdentificationNo||'').trim())missing.push('Employer TIN');
    if(!String(COMPANY.registeredAddress||'').trim())missing.push('Registered address');
    if(missing.length){toast('Complete Company Settings → BIR Employer Information: '+missing.join(', ')+'.','warning',7000);return;}
    if(!String(emp.tin||'').trim())missing.push('Employee TIN');
    if(!String(emp.rdo||'').trim())missing.push('Employee RDO code');
    if(!String(emp.permanentAddress||emp.city||'').trim())missing.push('Employee registered address');
    if(profile.hasPreviousEmployer){if(!String(profile.previousEmployerName||'').trim())missing.push('Previous employer name');if(!String(profile.previousEmployerTin||'').trim())missing.push('Previous employer TIN');if(!String(profile.previousEmployerAddress||'').trim())missing.push('Previous employer address');}
    if(missing.length){toast('Complete the employee Tax & YTD / Personal records before generating: '+missing.join(', ')+'.','warning',7500);return;}
    var approved=PAYROLLS.filter(function(run){return run.status==='approved'||run.status==='locked';});
    var finalPayRuns=FINAL_PAY_LIST.filter(function(record){return record.status==='released'&&Number(record.taxYear)===year;}).map(function(record){return{id:'FP-'+record.id,status:'locked',type:'final-pay',taxYear:record.taxYear,from:record.releaseDate,to:record.releaseDate,releaseDate:record.releaseDate,bir1601CMonth:record.bir1601CMonth,items:[{empId:record.empId,eid:record.eid,name:record.employeeName,gross:record.grossFP,taxableCompensation:record.taxableCompensation,annualBenefitExempt:record.annualBenefitExempt,annualBenefitTaxable:record.annualBenefitTaxable,sss:0,ph:0,pi:0,tax:record.taxWithheld,taxRefund:record.taxRefund,annualTax:record.annualTax,calculationTrace:[]}]};});
    var runs=approved.concat(finalPayRuns).filter(function(run){return Number(run.taxYear||String(run.bir1601CMonth||run.releaseDate||run.to||'').slice(0,4))===year&&(run.items||[]).some(function(item){return item.empId===empId;});});
    if(!runs.length){toast('No approved/locked payroll or released final pay for '+year+'.','warning');return;}
    try{
      toast('Generating official BIR Form 2316 PDF…','info');
      var data=BIR2316Pdf.buildData({employee:emp,company:COMPANY,profile:profile,year:year,runs:runs,taxDueFunction:function(value){return birTaxByFreq(value,'annual',year+'-12-31');}});
      var response=await fetch('/forms/bir-form-2316-sep-2021.pdf');if(!response.ok)throw new Error('Official BIR template could not be loaded.');
      var bytes=await BIR2316Pdf.render(await response.arrayBuffer(),data,window.PDFLib);
      downloadPdf('BIR_2316_'+String(emp.eid||emp.id).replace(/[^A-Za-z0-9_-]/g,'_')+'_'+year+'.pdf',bytes);
      toast('Official BIR Form 2316 generated. Review and complete the required signatures before issuance.','success',6500);
    }catch(error){toast('BIR 2316 PDF could not be generated: '+error.message,'error',7000);}
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
    if (!run && !FINAL_PAY_LIST.some(function (record) { return record.status === 'released'; })) return '<div class="empty-state"><div class="ei">📋</div>Approve and lock a payroll run or release a final pay to generate statutory reports.</div>';
    var defaultBirMonth = run ? BIR1601CCore.runMonth(run) : reportingMonthFromDate(today());
    if (!window._bir1601CMonth) window._bir1601CMonth = defaultBirMonth;
    var birSummary = BIR1601CCore.aggregate(window._bir1601CMonth, PAYROLLS, FINAL_PAY_LIST);
    var cards = [
      {type:'SSS',name:'SSS R3 Worksheet',detail:'Employee and employer shares · '+COMPLIANCE_VERSION.sss,color:'blue'},
      {type:'PHIC',name:'PhilHealth RF-1 Worksheet',detail:COMPLIANCE_VERSION.philhealth,color:'green'},
      {type:'HDMF',name:'Pag-IBIG MCRF Worksheet',detail:COMPLIANCE_VERSION.pagibig,color:'amber'},
      {type:'BIR',name:'Official BIR Form 1601-C',detail:COMPLIANCE_VERSION.bir,color:'red'}
    ];
    return '<div style="padding:9px 12px;background:var(--green-bg);color:var(--green-txt);border-radius:8px;margin-bottom:12px;font-size:12px">'+
      (run?'Latest approved payroll <strong>'+run.from+' – '+run.to+'</strong> · '+esc(run.complianceVersion || COMPLIANCE_VERSION.label):'Released final-pay records are available for statutory reporting.')+'</div>'+
      '<div class="card" style="margin-bottom:.75rem;border-left:3px solid var(--red)"><div style="display:flex;gap:12px;align-items:end;justify-content:space-between;flex-wrap:wrap"><div><div class="card-title">BIR 1601-C reporting month</div><div class="card-sub">Manually selected in the payroll calendar or final-pay release; independent from attendance and payment dates.</div></div><div style="min-width:210px"><label style="font-size:11px;font-weight:700">For the Month</label><input type="month" class="finput" value="'+window._bir1601CMonth+'" onchange="window._bir1601CMonth=this.value;render()"/></div></div><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:10px;font-size:11px"><div><span style="color:var(--txt3)">Approved payroll runs</span><div style="font-weight:800">'+birSummary.regularRunCount+'</div></div><div><span style="color:var(--txt3)">Released final pays</span><div style="font-weight:800">'+birSummary.finalPayCount+'</div></div><div><span style="color:var(--txt3)">Tax withheld</span><div class="mono" style="font-weight:800;color:var(--red)">'+fmt(birSummary.totalTaxesWithheld)+'</div></div><div><span style="color:var(--txt3)">Tax refunds</span><div class="mono" style="font-weight:800;color:var(--green)">'+fmt(birSummary.annualizationRefunds)+'</div></div><div><span style="color:var(--txt3)">Net remittance</span><div class="mono" style="font-weight:800;color:var(--red)">'+fmt(birSummary.taxRequiredForRemittance)+'</div></div></div></div>'+
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem">'+cards.map(function (c) {
        return '<div class="card" style="margin:0;border-left:3px solid var(--'+c.color+')"><div class="card-title">'+c.name+'</div>'+
          '<div class="card-sub" style="min-height:34px;margin:5px 0 10px">'+c.detail+'</div>'+
          (c.type==='BIR'?'<div style="display:flex;gap:6px"><button class="btn btn-sm btn-primary" style="flex:1;justify-content:center" onclick="generateOfficial1601CPDF()">Generate official PDF</button><button class="btn btn-sm" style="flex:1;justify-content:center" onclick="generateGovtReport(\'BIR\')">CSV worksheet</button></div>':'<button class="btn btn-sm" style="width:100%;justify-content:center" onclick="generateGovtReport(\''+c.type+'\')">Download CSV worksheet</button>')+'</div>';
      }).join('')+'</div>'+
      '<div class="card" style="margin-top:.75rem;margin-bottom:0"><div style="display:flex;gap:12px;align-items:end;justify-content:space-between;flex-wrap:wrap"><div><div class="card-title">Official BIR Form 2316</div>'+ 
      '<div class="card-sub">Plots approved payroll and previous-employer data directly on the September 2021 (ENCS) government form. Review and signatures remain required.</div></div><div style="min-width:130px"><label style="font-size:11px;font-weight:700">Tax Year</label><input type="number" min="2000" max="2099" class="finput" value="'+Number(window._bir2316Year||new Date().getFullYear())+'" onchange="window._bir2316Year=Number(this.value);render()"/></div></div>'+ 
      '<div style="display:grid;gap:5px">'+USERS.filter(function (u) { return u.role === 'employee'; }).map(function (e) {
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 9px;border:1px solid var(--border);border-radius:7px">'+
          '<div><div style="font-weight:600;font-size:12px">'+esc(e.name)+'</div><div style="font-size:10px;color:var(--txt3)">TIN '+esc(e.tin||'Not set')+'</div></div>'+
          '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button class="btn btn-sm btn-primary" onclick="generateOfficial2316PDF('+e.id+')">Generate official PDF</button><button class="btn btn-sm" onclick="generate2316Worksheet('+e.id+')">CSV worksheet</button></div></div>';
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
