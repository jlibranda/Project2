/*
 * SproutRipple PH connected workforce workflows.
 * Capability patterns are independently implemented and do not reproduce
 * third-party branding, source code, or proprietary interface designs.
 */
(function () {
  'use strict';

  var RESOLUTION_CASES = [
    {
      id:1, caseNo:'CASE-2026-001', employeeId:2, category:'Attendance',
      subject:'Late record correction for May 20', description:'Traffic delay was encoded as 45 minutes; employee requests verification against biometric log.',
      priority:'normal', status:'in_review', linkedType:'attendance', linkedId:2,
      submittedBy:'Juan Dela Cruz', submittedAt:'2026-07-26T08:20:00+08:00',
      owner:'HR Operations', dueDate:'2026-07-29', resolution:''
    },
    {
      id:2, caseNo:'CASE-2026-002', employeeId:3, category:'Payslip',
      subject:'Loan deduction clarification', description:'Employee requests a breakdown of the current SSS salary-loan deduction.',
      priority:'low', status:'open', linkedType:'loan', linkedId:1,
      submittedBy:'Ana Reyes', submittedAt:'2026-07-27T10:05:00+08:00',
      owner:'Payroll Team', dueDate:'2026-07-31', resolution:''
    }
  ];
  var nextCaseId = 3;
  var PERFORMANCE_GOALS = [
    {id:1,eid:2,title:'Improve release predictability',metric:'On-time sprint delivery',target:90,progress:78,due:'2026-09-30',status:'on_track',checkIn:'2026-07-22'},
    {id:2,eid:3,title:'Increase qualified marketing leads',metric:'MQL conversion',target:80,progress:66,due:'2026-09-30',status:'at_risk',checkIn:'2026-07-18'},
    {id:3,eid:4,title:'Close monthly books faster',metric:'Days to close',target:95,progress:88,due:'2026-08-31',status:'on_track',checkIn:'2026-07-25'}
  ];
  var nextGoalId = 4;
  var JOB_REQUISITIONS = [
    {id:1,title:'Senior Frontend Engineer',dept:'Engineering',openings:2,filled:0,owner:'Maria Santos',status:'open',age:18},
    {id:2,title:'Accountant',dept:'Finance',openings:1,filled:0,owner:'Maria Santos',status:'interviewing',age:12},
    {id:3,title:'Sales Manager',dept:'Sales',openings:1,filled:0,owner:'Maria Santos',status:'open',age:25}
  ];
  var AI_HISTORY = [];

  function caseBadge(status) {
    var map={open:'b-info',in_review:'b-pending',resolved:'b-approved',rejected:'b-rejected'};
    var label={open:'Open',in_review:'In review',resolved:'Resolved',rejected:'Rejected'};
    return '<span class="badge '+(map[status]||'b-info')+'">'+(label[status]||status)+'</span>';
  }

  function priorityBadge(priority) {
    var map={urgent:'b-rejected',high:'b-pending',normal:'b-info',low:'b-active'};
    return '<span class="badge '+(map[priority]||'b-info')+'">'+esc(priority)+'</span>';
  }

  function dueState(c) {
    if (c.status==='resolved'||c.status==='rejected') return '';
    var due=new Date(c.dueDate+'T23:59:59');
    var days=Math.ceil((due-new Date())/86400000);
    return days<0?'<span style="color:var(--red);font-weight:700">Overdue</span>':
      days===0?'<span style="color:var(--amber);font-weight:700">Due today</span>':
      '<span style="color:var(--txt3)">'+days+' day'+(days!==1?'s':'')+' left</span>';
  }

  function linkedRecordText(c) {
    if (c.linkedType==='attendance') {
      var a=ATT.find(function(x){return x.id===c.linkedId;});
      return a?'Attendance · '+a.date+' · '+a.status:'Attendance record';
    }
    if (c.linkedType==='payroll') {
      var r=PAYROLLS.find(function(x){return x.id===c.linkedId;});
      return r?'Payroll · '+r.from+' – '+r.to:'Payroll run';
    }
    if (c.linkedType==='leave') {
      var l=LEAVES.find(function(x){return x.id===c.linkedId;});
      return l?'Leave · '+l.s+' – '+l.e:'Leave request';
    }
    return c.linkedType?c.linkedType.charAt(0).toUpperCase()+c.linkedType.slice(1):'General inquiry';
  }

  window.openResolutionForm=function(category,linkedType,linkedId) {
    window._resolutionForm={category:category||'Attendance',linkedType:linkedType||'',linkedId:linkedId||null};
    view='resolution';tab=user.role==='admin'?0:1;render();
  };

  window.submitResolutionCase=function() {
    var subject=(document.getElementById('case-subject')||{}).value||'';
    var description=(document.getElementById('case-description')||{}).value||'';
    var category=(document.getElementById('case-category')||{}).value||'General';
    var priority=(document.getElementById('case-priority')||{}).value||'normal';
    if(!subject.trim()||!description.trim()){toast('Subject and details are required.','warning');return;}
    var id=nextCaseId++;
    var due=new Date();due.setDate(due.getDate()+(priority==='urgent'?1:priority==='high'?2:4));
    RESOLUTION_CASES.push({
      id:id,caseNo:'CASE-'+new Date().getFullYear()+'-'+String(id).padStart(3,'0'),
      employeeId:user.role==='employee'?user.id:parseInt((document.getElementById('case-employee')||{}).value,10)||user.id,
      category:category,subject:subject.trim(),description:description.trim(),priority:priority,status:'open',
      linkedType:window._resolutionForm&&window._resolutionForm.linkedType||'',linkedId:window._resolutionForm&&window._resolutionForm.linkedId||null,
      submittedBy:user.name,submittedAt:new Date().toISOString(),owner:category==='Payroll'||category==='Payslip'?'Payroll Team':'HR Operations',
      dueDate:due.toISOString().slice(0,10),resolution:''
    });
    window._resolutionForm=null;
    toast('Case filed and routed to the correct team.','success');render();
  };

  window.startResolutionReview=function(id) {
    var c=RESOLUTION_CASES.find(function(x){return x.id===id;});if(!c)return;
    c.status='in_review';c.reviewedBy=user.name;c.reviewedAt=new Date().toISOString();
    toast(c.caseNo+' is now under review.','info');render();
  };

  window.resolveCase=function(id,decision) {
    var c=RESOLUTION_CASES.find(function(x){return x.id===id;});if(!c)return;
    var notes=prompt('Resolution notes / basis:');
    if(notes===null)return;
    if(!notes.trim()){toast('Resolution notes are required for the audit trail.','warning');return;}
    c.status=decision==='resolved'?'resolved':'rejected';
    c.resolution=notes.trim();c.resolvedBy=user.name;c.resolvedAt=new Date().toISOString();
    if(decision==='resolved'){
      if(c.linkedType==='attendance'){
        var a=ATT.find(function(x){return x.id===c.linkedId;});
        if(a){a.approvalStatus='approved';a.reviewedBy=user.name;a.reviewedAt=c.resolvedAt;}
      }else if(c.linkedType==='leave'){
        var l=LEAVES.find(function(x){return x.id===c.linkedId;});
        if(l)l.status='approved';
      }
    }
    toast(c.caseNo+' '+(decision==='resolved'?'resolved':'closed without change')+'.',decision==='resolved'?'success':'warning');render();
  };

  window.pgResolution=function() {
    var isAdmin=user.role==='admin'||isPlatformAdmin;
    var tabs=isAdmin?['Resolution Queue','All Cases','File a Case']:['My Cases','File a Case'];
    var records=isAdmin?RESOLUTION_CASES:RESOLUTION_CASES.filter(function(c){return c.employeeId===user.id;});
    var showForm=(isAdmin&&tab===2)||(!isAdmin&&tab===1)||!!window._resolutionForm;
    var body='';
    if(showForm){
      var preset=window._resolutionForm||{};
      body='<div style="max-width:760px"><div class="section-header">Request details</div>'+
        (isAdmin?'<div class="field"><label>Employee</label><select id="case-employee">'+USERS.filter(function(u){return u.role==='employee';}).map(function(e){return '<option value="'+e.id+'">'+esc(e.name)+' · '+esc(e.eid)+'</option>';}).join('')+'</select></div>':'')+
        '<div class="form-row"><div class="field"><label>Category</label><select id="case-category">'+
        ['Attendance','Leave','Payroll','Payslip','Government Contribution','Employee Record','Policy'].map(function(x){return '<option '+(preset.category===x?'selected':'')+'>'+x+'</option>';}).join('')+
        '</select></div><div class="field"><label>Priority</label><select id="case-priority"><option value="normal">Normal · 4-day SLA</option><option value="low">Low</option><option value="high">High · 2-day SLA</option><option value="urgent">Urgent · 1-day SLA</option></select></div></div>'+
        '<div class="field"><label>Subject</label><input id="case-subject" placeholder="Short description of the issue"/></div>'+
        '<div class="field"><label>Details and requested resolution</label><textarea id="case-description" rows="5" placeholder="Include dates, payroll period, expected result, and supporting details."></textarea></div>'+
        (preset.linkedType?'<div style="padding:9px 12px;background:var(--accent-bg);color:var(--accent-txt);border-radius:8px;font-size:12px;margin-bottom:12px">Linked to '+esc(preset.linkedType)+' record #'+esc(String(preset.linkedId))+'</div>':'')+
        '<div class="action-row"><button class="btn btn-primary" onclick="submitResolutionCase()">Submit case</button><button class="btn" onclick="window._resolutionForm=null;tab=0;render()">Cancel</button></div></div>';
    }else{
      var list=isAdmin&&tab===0?records.filter(function(c){return c.status==='open'||c.status==='in_review';}):records;
      body='<div style="overflow-x:auto"><table><thead><tr><th>Case</th><th>Employee</th><th>Issue</th><th>Priority</th><th>Owner / SLA</th><th>Status</th><th>Action</th></tr></thead><tbody>'+
        (list.length?list.slice().reverse().map(function(c){
          var emp=USERS.find(function(e){return e.id===c.employeeId;})||{};
          return '<tr><td><div class="mono" style="font-weight:700">'+c.caseNo+'</div><div style="font-size:10px;color:var(--txt3)">'+new Date(c.submittedAt).toLocaleDateString()+'</div></td>'+
            '<td><div style="font-weight:600">'+esc(emp.name||c.submittedBy)+'</div><div style="font-size:10px;color:var(--txt3)">'+esc(emp.eid||'')+'</div></td>'+
            '<td style="min-width:260px"><div style="font-weight:600">'+esc(c.subject)+'</div><div style="font-size:11px;color:var(--txt3);margin-top:2px">'+esc(linkedRecordText(c))+'</div>'+
            (c.resolution?'<div style="font-size:11px;color:var(--green);margin-top:4px">Resolution: '+esc(c.resolution)+'</div>':'')+'</td>'+
            '<td>'+priorityBadge(c.priority)+'</td><td><div style="font-size:12px">'+esc(c.owner)+'</div><div style="font-size:10px;margin-top:2px">'+dueState(c)+'</div></td>'+
            '<td>'+caseBadge(c.status)+'</td><td>'+(isAdmin&&(c.status==='open'||c.status==='in_review')?
              '<div class="action-row">'+(c.status==='open'?'<button class="btn btn-sm" onclick="startResolutionReview('+c.id+')">Review</button>':'')+
              '<button class="btn btn-sm btn-success" onclick="resolveCase('+c.id+',\'resolved\')">Resolve</button><button class="btn btn-sm btn-danger" onclick="resolveCase('+c.id+',\'rejected\')">Reject</button></div>':
              '<button class="btn btn-sm" onclick="openResolutionForm(\''+c.category+'\',\''+(c.linkedType||'')+'\','+(c.linkedId||'null')+')">Follow up</button>')+'</td></tr>';
        }).join(''):'<tr><td colspan="7" class="empty-state">No cases in this view.</td></tr>')+'</tbody></table></div>';
    }
    var open=records.filter(function(c){return c.status==='open';}).length;
    var review=records.filter(function(c){return c.status==='in_review';}).length;
    var resolved=records.filter(function(c){return c.status==='resolved';}).length;
    return '<div class="page-header"><div><div class="page-title">Resolution Center</div><div class="page-sub">Track attendance, leave, payroll and employee-service concerns end to end</div></div>'+
      '<button class="btn btn-primary" onclick="window._resolutionForm={};tab='+(isAdmin?2:1)+';render()">+ File a Case</button></div>'+
      '<div class="metrics" style="grid-template-columns:repeat(3,1fr)"><div class="metric"><div class="metric-label">Open</div><div class="metric-val">'+open+'</div></div>'+
      '<div class="metric"><div class="metric-label">In Review</div><div class="metric-val" style="color:var(--amber)">'+review+'</div></div>'+
      '<div class="metric"><div class="metric-label">Resolved</div><div class="metric-val" style="color:var(--green)">'+resolved+'</div></div></div>'+
      '<div class="tabs">'+tabs.map(function(t,i){return '<div class="tab'+(tab===i?' active':'')+'" onclick="window._resolutionForm=null;goTab('+i+')">'+t+'</div>';}).join('')+'</div><div class="card">'+body+'</div>';
  };

  var baseSidebar=renderSidebar;
  window.renderSidebar=renderSidebar=function(){
    var html=baseSidebar();
    var pending=RESOLUTION_CASES.filter(function(c){return c.status==='open'||c.status==='in_review';}).length;
    var link='<div class="nav-section">Service Desk</div><div class="nav-link'+(view==='resolution'?' active':'')+'" onclick="goView(\'resolution\')">'+ico('file',15)+'<span>Resolution Center</span>'+(pending?'<span class="nav-badge">'+pending+'</span>':'')+'</div>';
    return html.replace('<div class="nav-section">Payroll</div>',link+'<div class="nav-section">Payroll</div>');
  };

  var baseMySlips=pgMySlips;
  window.downloadPayslip=function(runId,empId){
    var r=PAYROLLS.find(function(x){return x.id===runId;});
    var i=r&&r.items.find(function(x){return x.empId===empId||x.eid===empId;});
    if(!r||!i){toast('Payslip not found.','warning');return;}
    var rows=[
      ['SPROUTRIPPLE PH PAYSLIP'],['Employee',i.name],['Employee No.',i.eid],['Period',r.from+' to '+r.to],['Status','Approved and released'],
      [],['EARNINGS','AMOUNT'],['Basic pay',i.basic],['Overtime',i.ot||0],['Night differential',i.nd||0],['Adjustments',i.adjustments||0],['Gross pay',i.gross],
      [],['DEDUCTIONS','AMOUNT'],['SSS',i.sss||0],['PhilHealth',i.ph||0],['Pag-IBIG',i.pi||0],['Withholding tax',i.tax||0],['Loans',i.loan||0],['Total deductions',i.totalDed||i.total||0],
      [],['NET PAY',i.net],[],['Compliance basis',r.complianceVersion||'Current configured statutory tables']
    ];
    var content='\uFEFF'+rows.map(function(row){return row.map(function(v){var s=String(v==null?'':v);return '"'+s.replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');
    var blob=new Blob([content],{type:'text/csv;charset=utf-8'});var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download='Payslip_'+i.eid+'_'+r.from+'_'+r.to+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},500);
  };
  window.openPayslipCase=function(runId,empId){openResolutionForm('Payslip','payroll',runId);};
  window.pgMySlips=pgMySlips=function(){
    var approved=PAYROLLS.filter(function(r){return r.status==='approved'||r.status==='locked';});
    var mine=approved.map(function(r){return {run:r,item:r.items.find(function(i){return i.empId===user.id||i.eid===user.id;})};}).filter(function(x){return x.item;});
    if(!mine.length)return baseMySlips();
    var ytdGross=mine.reduce(function(s,x){return s+x.item.gross;},0),ytdTax=mine.reduce(function(s,x){return s+(x.item.tax||0);},0),ytdNet=mine.reduce(function(s,x){return s+x.item.net;},0);
    return '<div class="page-header"><div><div class="page-title">My Payslips</div><div class="page-sub">Approved and released payroll statements</div></div></div>'+
      '<div class="metrics" style="grid-template-columns:repeat(3,1fr)"><div class="metric"><div class="metric-label">YTD Gross</div><div class="metric-val" style="font-size:18px">'+fmt(ytdGross)+'</div></div>'+
      '<div class="metric"><div class="metric-label">YTD Tax</div><div class="metric-val" style="font-size:18px;color:var(--red)">'+fmt(ytdTax)+'</div></div>'+
      '<div class="metric"><div class="metric-label">YTD Net</div><div class="metric-val" style="font-size:18px;color:var(--green)">'+fmt(ytdNet)+'</div></div></div>'+
      '<div class="card"><table><thead><tr><th>Period</th><th>Gross</th><th>Contributions</th><th>Tax</th><th>Net Pay</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+
      mine.slice().reverse().map(function(x){var r=x.run,i=x.item;return '<tr><td class="mono">'+r.from+' – '+r.to+'</td><td class="mono">'+fmt(i.gross)+'</td>'+
        '<td class="mono">'+fmt((i.sss||0)+(i.ph||0)+(i.pi||0))+'</td><td class="mono" style="color:var(--red)">'+fmt(i.tax||0)+'</td>'+
        '<td class="mono" style="font-weight:800;color:var(--green)">'+fmt(i.net)+'</td><td><span class="badge b-approved">Released</span></td>'+
        '<td><div class="action-row"><button class="btn btn-sm" onclick="modal={type:\'slip\',run:PAYROLLS.find(function(x){return x.id==='+r.id+'}),item:PAYROLLS.find(function(x){return x.id==='+r.id+'}).items.find(function(x){return x.empId==='+i.empId+'})};render()">View</button>'+
        '<button class="btn btn-sm" onclick="downloadPayslip('+r.id+','+i.empId+')">Download</button><button class="btn btn-sm" onclick="openPayslipCase('+r.id+','+i.empId+')">Question</button></div></td></tr>';}).join('')+
      '</tbody></table></div>';
  };

  function complianceHealth(){
    var emps=USERS.filter(function(u){return u.role==='employee'&&u.active!==false;});
    var missingGov=emps.filter(function(e){return !e.sss||!e.ph||!e.pi||!e.tin;});
    var missingBank=emps.filter(function(e){return !e.bank||!e.bankAccount;});
    var pendingAtt=ATT.filter(function(a){return a.approvalStatus==='pending';}).length;
    var pendingPay=PAYROLLS.filter(function(r){return r.status==='pending_approval';}).length;
    var score=Math.max(0,100-missingGov.length*10-missingBank.length*5-pendingAtt*3-pendingPay*8);
    return {score:score,missingGov:missingGov,missingBank:missingBank,pendingAtt:pendingAtt,pendingPay:pendingPay};
  }

  var baseGovernment=pgGovernment;
  window.pgGovernment=pgGovernment=function(){
    var html=baseGovernment();
    if(tab!==0)return html;
    var h=complianceHealth();
    var card='<div class="card" style="margin-top:1rem;border-left:3px solid '+(h.score>=90?'var(--green)':h.score>=75?'var(--amber)':'var(--red)')+'"><div class="card-hd"><div><div class="card-title">Compliance Health</div>'+
      '<div class="card-sub">Automated readiness checks for payroll and statutory reporting</div></div><div style="font-size:28px;font-weight:800;color:'+(h.score>=90?'var(--green)':h.score>=75?'var(--amber)':'var(--red)')+'">'+h.score+'%</div></div>'+
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px"><div class="metric"><div class="metric-label">Missing IDs</div><div class="metric-val" style="font-size:20px">'+h.missingGov.length+'</div></div>'+
      '<div class="metric"><div class="metric-label">Missing Bank</div><div class="metric-val" style="font-size:20px">'+h.missingBank.length+'</div></div>'+
      '<div class="metric"><div class="metric-label">Pending Time</div><div class="metric-val" style="font-size:20px">'+h.pendingAtt+'</div></div>'+
      '<div class="metric"><div class="metric-label">Payroll Approval</div><div class="metric-val" style="font-size:20px">'+h.pendingPay+'</div></div></div>'+
      '<div style="font-size:11px;color:var(--txt3);margin-top:10px">Ruleset: SSS 2025 · PhilHealth 2025 · Pag-IBIG Circular 460 · BIR Annex E 2023 onwards. Review agency advisories before every filing cycle.</div></div>';
    return html+card;
  };

  var baseReports=pgReports;
  window.loadReportTemplate=function(type){
    var templates={
      payroll:{type:'payroll',name:'Payroll Register & Variance',columns:['eid','name','period','gross','sss','ph','pi','tax','net']},
      attendance:{type:'attendance',name:'Attendance Exceptions',columns:['date','eid','name','status','tin','tout','ot','nd','notes']},
      employees:{type:'employees',name:'Employee Masterlist',columns:['activeStatus','eid','name','pos','type','bu','dept','team','salaryPM','status']}
    };
    var t=templates[type];if(!t)return;
    reportConfig.type=t.type;reportConfig.name=t.name;
    var available=(REPORT_COLS[t.type]||[]).map(function(c){return c.k;});
    reportConfig.columns=t.columns.filter(function(k){return available.indexOf(k)>=0;});
    reportConfig.filters={};toast(t.name+' loaded.','success');render();
  };
  window.pgReports=pgReports=function(){
    var quick='<div class="card" style="margin-bottom:1rem"><div class="card-hd"><div><div class="card-title">Quick Report Suite</div><div class="card-sub">Preconfigured operational and audit-ready views</div></div></div>'+
      '<div class="action-row"><button class="btn btn-sm" onclick="loadReportTemplate(\'employees\')">Employee Masterlist</button>'+
      '<button class="btn btn-sm" onclick="loadReportTemplate(\'attendance\')">Attendance Exceptions</button>'+
      '<button class="btn btn-sm" onclick="loadReportTemplate(\'payroll\')">Payroll Register & Variance</button>'+
      '<button class="btn btn-sm" onclick="goView(\'government\')">Statutory Reports</button></div></div>';
    return quick+baseReports();
  };

  window.pgAnalytics=pgAnalytics=function(){
    var emps=USERS.filter(function(u){return u.role==='employee'&&u.active!==false;});
    var approved=PAYROLLS.filter(function(r){return r.status==='approved'||r.status==='locked';});
    var last=approved[approved.length-1];
    var gross=last?last.items.reduce(function(s,i){return s+i.gross;},0):emps.reduce(function(s,e){return s+(e.salaryPM||e.rate*22);},0);
    var employerContrib=emps.reduce(function(s,e){var ms=e.salaryPM||e.rate*22;return s+totalSssEr(ms)+phErShare(ms)+piErShare(ms);},0);
    var approvedAtt=ATT.filter(function(a){return a.approvalStatus==='approved';});
    var exceptions=approvedAtt.filter(function(a){return a.status==='late'||a.status==='absent';}).length;
    var totalAtt=approvedAtt.length||1;
    var candidateActive=CANDIDATES.filter(function(c){return c.stage!=='hired'&&c.stage!=='rejected';}).length;
    var perfAvg=PERF.length?Math.round(PERF.reduce(function(s,p){return s+p.kpis.reduce(function(a,k){return a+k.s;},0)/p.kpis.length;},0)/PERF.length):0;
    var h=complianceHealth();
    var funnel=['new','screen','interview','offer','hired'].map(function(stage){return {stage:stage,count:CANDIDATES.filter(function(c){return c.stage===stage;}).length};});
    var maxF=Math.max.apply(null,funnel.map(function(x){return x.count;}))||1;
    var dept={};emps.forEach(function(e){dept[e.dept]=(dept[e.dept]||0)+1;});
    return '<div class="page-header"><div><div class="page-title">Workforce Analytics</div><div class="page-sub">HR, payroll, compliance and talent signals in one view</div></div>'+
      '<button class="btn" onclick="goView(\'reports\')">Build detailed report</button></div>'+
      '<div class="metrics" style="grid-template-columns:repeat(5,1fr)"><div class="metric"><div class="metric-label">Payroll Gross</div><div class="metric-val" style="font-size:17px;color:var(--green)">'+fmt(gross)+'</div></div>'+
      '<div class="metric"><div class="metric-label">Employer Contributions</div><div class="metric-val" style="font-size:17px">'+fmt(employerContrib)+'</div></div>'+
      '<div class="metric"><div class="metric-label">Attendance Quality</div><div class="metric-val" style="color:var(--green)">'+Math.round((totalAtt-exceptions)/totalAtt*100)+'%</div></div>'+
      '<div class="metric"><div class="metric-label">Compliance Health</div><div class="metric-val" style="color:'+(h.score>=90?'var(--green)':'var(--amber)')+'">'+h.score+'%</div></div>'+
      '<div class="metric"><div class="metric-label">Performance Avg.</div><div class="metric-val">'+perfAvg+'%</div></div></div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem"><div class="card"><div class="card-title" style="margin-bottom:14px">Recruitment Funnel · '+candidateActive+' active</div>'+
      funnel.map(function(x){return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px"><div style="width:70px;text-transform:capitalize;font-size:12px;color:var(--txt2)">'+x.stage+'</div>'+
        '<div style="flex:1;height:20px;background:var(--bg);border-radius:5px;overflow:hidden"><div style="width:'+Math.max(5,x.count/maxF*100)+'%;height:100%;background:var(--accent);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;padding-left:7px">'+x.count+'</div></div></div>';}).join('')+'</div>'+
      '<div class="card"><div class="card-title" style="margin-bottom:14px">Headcount Distribution</div>'+Object.keys(dept).map(function(d){return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)"><span>'+esc(d)+'</span><strong>'+dept[d]+'</strong></div>';}).join('')+'</div>'+
      '<div class="card" style="grid-column:1/-1"><div class="card-hd"><div><div class="card-title">Operational Attention</div><div class="card-sub">Items that can delay payroll or employee service</div></div></div>'+
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px"><div class="metric"><div class="metric-label">Resolution Cases</div><div class="metric-val" style="font-size:20px">'+RESOLUTION_CASES.filter(function(c){return c.status==='open'||c.status==='in_review';}).length+'</div></div>'+
      '<div class="metric"><div class="metric-label">Pending Attendance</div><div class="metric-val" style="font-size:20px">'+h.pendingAtt+'</div></div>'+
      '<div class="metric"><div class="metric-label">Pending Payrolls</div><div class="metric-val" style="font-size:20px">'+h.pendingPay+'</div></div>'+
      '<div class="metric"><div class="metric-label">At-risk Goals</div><div class="metric-val" style="font-size:20px">'+PERFORMANCE_GOALS.filter(function(g){return g.status==='at_risk';}).length+'</div></div></div></div></div>';
  };

  var baseRecruitment=pgRecruitment;
  window.pgRecruitment=pgRecruitment=function(){
    var html=baseRecruitment();
    var panel='<div class="card" style="margin-top:1rem"><div class="card-hd"><div><div class="card-title">Open Requisitions</div><div class="card-sub">Hiring demand and pipeline coverage</div></div></div>'+
      '<table><thead><tr><th>Role</th><th>Department</th><th>Openings</th><th>Pipeline</th><th>Owner</th><th>Age</th><th>Status</th></tr></thead><tbody>'+
      JOB_REQUISITIONS.map(function(j){var pipeline=CANDIDATES.filter(function(c){return c.pos.toLowerCase().indexOf(j.title.split(' ').pop().toLowerCase())>=0||c.dept===j.dept;}).length;return '<tr><td style="font-weight:600">'+esc(j.title)+'</td><td>'+esc(j.dept)+'</td><td>'+j.openings+'</td><td><span class="badge '+(pipeline>=j.openings?'b-approved':'b-pending')+'">'+pipeline+' candidate(s)</span></td><td>'+esc(j.owner)+'</td><td>'+j.age+' days</td><td><span class="badge b-info">'+esc(j.status)+'</span></td></tr>';}).join('')+
      '</tbody></table></div>';
    return html+panel;
  };

  window.addGoal=function(){
    var eid=parseInt(prompt('Employee numeric ID (example: 2):'),10);var emp=USERS.find(function(e){return e.id===eid&&e.role==='employee';});
    if(!emp){toast('Employee not found.','warning');return;}
    var title=prompt('Goal title:');if(!title||!title.trim())return;
    PERFORMANCE_GOALS.push({id:nextGoalId++,eid:eid,title:title.trim(),metric:'Completion',target:100,progress:0,due:new Date(new Date().setMonth(new Date().getMonth()+3)).toISOString().slice(0,10),status:'on_track',checkIn:today()});
    toast('Goal added for '+emp.name+'.','success');render();
  };
  window.checkInGoal=function(id){
    var g=PERFORMANCE_GOALS.find(function(x){return x.id===id;});if(!g)return;
    var value=parseInt(prompt('Current progress (0–100):',g.progress),10);
    if(isNaN(value)||value<0||value>100){toast('Enter a progress value from 0 to 100.','warning');return;}
    g.progress=value;g.checkIn=today();g.status=value<50?'at_risk':value>=100?'completed':'on_track';toast('Check-in saved.','success');render();
  };
  window.pgPerformance=pgPerformance=function(){
    var isAdmin=user.role==='admin'||isPlatformAdmin;var tabs=['Review Results','Goals & Check-ins','Calibration'];var records=isAdmin?PERF:PERF.filter(function(p){return p.eid===user.id;});
    var body='';
    if(tab===0){
      body=records.map(function(p){var emp=USERS.find(function(e){return e.id===p.eid;})||{};var avg=Math.round(p.kpis.reduce(function(s,k){return s+k.s;},0)/p.kpis.length);return '<div style="border:1px solid var(--border);border-radius:10px;padding:1rem;margin-bottom:10px"><div style="display:flex;justify-content:space-between;margin-bottom:12px"><div><div style="font-weight:700">'+esc(emp.name)+'</div><div class="card-sub">'+esc(p.period)+' · '+esc(emp.pos||'')+'</div></div><div style="font-size:25px;font-weight:800;color:'+(avg>=85?'var(--green)':'var(--accent)')+'">'+avg+'%</div></div>'+
        p.kpis.map(function(k){return '<div class="perf-bar"><div class="perf-label">'+esc(k.k)+'</div><div class="perf-track"><div class="perf-fill" style="width:'+k.s+'%;background:'+(k.s>=85?'var(--green)':k.s>=70?'var(--accent)':'var(--amber)')+'"></div></div><div class="perf-score">'+k.s+'</div></div>';}).join('')+'<div style="font-size:12px;color:var(--txt3);margin-top:10px">'+esc(p.comment)+'</div></div>';}).join('')||'<div class="empty-state">No reviews.</div>';
    }else if(tab===1){
      var goals=isAdmin?PERFORMANCE_GOALS:PERFORMANCE_GOALS.filter(function(g){return g.eid===user.id;});
      body='<div style="display:flex;justify-content:flex-end;margin-bottom:10px">'+(isAdmin?'<button class="btn btn-primary btn-sm" onclick="addGoal()">+ Add Goal</button>':'')+'</div>'+
        goals.map(function(g){var emp=USERS.find(function(e){return e.id===g.eid;})||{};return '<div class="card" style="margin-bottom:8px"><div style="display:flex;align-items:flex-start;justify-content:space-between"><div><div style="font-weight:700">'+esc(g.title)+'</div><div class="card-sub">'+esc(emp.name)+' · '+esc(g.metric)+' · Due '+g.due+'</div></div><span class="badge '+(g.status==='at_risk'?'b-pending':'b-approved')+'">'+g.status.replace('_',' ')+'</span></div>'+
          '<div class="progress-bar" style="height:9px;margin:12px 0 6px"><div class="progress-fill" style="width:'+g.progress+'%;background:'+(g.status==='at_risk'?'var(--amber)':'var(--green)')+'"></div></div><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--txt3)"><span>'+g.progress+'% progress · Last check-in '+g.checkIn+'</span><button class="btn btn-sm" onclick="checkInGoal('+g.id+')">Check in</button></div></div>';}).join('');
    }else{
      var distribution={exceeds:0,meets:0,needs:0};PERF.forEach(function(p){var a=p.kpis.reduce(function(s,k){return s+k.s;},0)/p.kpis.length;if(a>=85)distribution.exceeds++;else if(a>=70)distribution.meets++;else distribution.needs++;});
      body='<div class="metrics"><div class="metric"><div class="metric-label">Exceeds</div><div class="metric-val" style="color:var(--green)">'+distribution.exceeds+'</div></div><div class="metric"><div class="metric-label">Meets</div><div class="metric-val">'+distribution.meets+'</div></div><div class="metric"><div class="metric-label">Needs Support</div><div class="metric-val" style="color:var(--amber)">'+distribution.needs+'</div></div></div><div style="padding:12px;background:var(--accent-bg);border-radius:8px;color:var(--accent-txt);font-size:12px">Calibration view helps leaders review rating distribution before results are finalized.</div>';
    }
    return '<div class="page-header"><div><div class="page-title">Performance Management</div><div class="page-sub">Reviews, measurable goals, check-ins and calibration</div></div></div><div class="tabs">'+tabs.map(function(t,i){return '<div class="tab'+(tab===i?' active':'')+'" onclick="goTab('+i+')">'+t+'</div>';}).join('')+'</div><div class="card">'+body+'</div>';
  };

  function aiInsight(type){
    var h=complianceHealth(),openCases=RESOLUTION_CASES.filter(function(c){return c.status==='open'||c.status==='in_review';});
    if(type==='payroll')return 'Payroll readiness: '+h.pendingAtt+' attendance record(s) pending, '+h.pendingPay+' payroll run(s) awaiting approval, '+h.missingBank.length+' employee(s) missing bank details, and '+h.missingGov.length+' employee(s) with incomplete government IDs. Recommended action: clear attendance and employee-master exceptions before submitting the next payroll.';
    if(type==='compliance')return 'Compliance health is '+h.score+'%. The engine is configured for SSS 2025, PhilHealth 2025, Pag-IBIG Circular 460, and BIR Annex E 2023 onwards. Highest operational risks: '+h.missingGov.length+' incomplete statutory profiles and '+openCases.length+' unresolved employee case(s). Always confirm new agency advisories before filing.';
    if(type==='talent')return 'Talent summary: '+CANDIDATES.filter(function(c){return c.stage!=='rejected'&&c.stage!=='hired';}).length+' active candidate(s), '+JOB_REQUISITIONS.length+' open requisition(s), and '+PERFORMANCE_GOALS.filter(function(g){return g.status==='at_risk';}).length+' goal(s) at risk. Prioritize interview-stage candidates and schedule check-ins for at-risk goals.';
    return 'Workforce pulse: '+USERS.filter(function(u){return u.role==='employee'&&u.active!==false;}).length+' active employees, '+openCases.length+' open service cases, '+ATT.filter(function(a){return a.status==='late'||a.status==='absent';}).length+' attendance exception(s), and '+CANDIDATES.length+' candidates in the recruitment database.';
  }
  window.runAiInsight=function(type){var text=aiInsight(type);AI_HISTORY.unshift({type:type,text:text,at:new Date().toISOString()});aiText=text;render();};
  window.smartAsk=function(){
    var q=((document.getElementById('aiq')||{}).value||'').trim().toLowerCase();if(!q){toast('Enter a question.','warning');return;}
    var type=/payroll|salary|payslip/.test(q)?'payroll':/compliance|sss|philhealth|pag-ibig|bir|tax/.test(q)?'compliance':/recruit|candidate|performance|goal|talent/.test(q)?'talent':'workforce';
    runAiInsight(type);
  };
  window.pgAssistant=pgAssistant=function(){
    return '<div class="page-header"><div><div class="page-title">Workforce AI Copilot</div><div class="page-sub">Operational insights from the current HR, attendance, payroll and talent data</div></div></div>'+
      '<div class="card"><div class="section-header">One-click analysis</div><div class="qs-grid">'+
      '<button class="qs-btn" onclick="runAiInsight(\'payroll\')">💰 Analyze payroll readiness</button><button class="qs-btn" onclick="runAiInsight(\'compliance\')">🛡 Review compliance risks</button>'+
      '<button class="qs-btn" onclick="runAiInsight(\'talent\')">🎯 Summarize talent pipeline</button><button class="qs-btn" onclick="runAiInsight(\'workforce\')">📊 Generate workforce pulse</button></div>'+
      '<div class="field"><label>Ask about your workforce data</label><textarea id="aiq" rows="3" placeholder="Example: What can delay our next payroll?"></textarea></div>'+
      '<div class="action-row"><button class="btn btn-primary" onclick="smartAsk()">Analyze</button><button class="btn" onclick="aiText=\'\';render()">Clear</button></div>'+
      (aiText?'<div class="ai-box"><div style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;margin-bottom:5px">Decision support · Generated '+new Date().toLocaleTimeString()+'</div>'+esc(aiText)+'</div>':'')+
      '<div style="font-size:10px;color:var(--txt3);margin-top:10px">AI output is decision support, not legal or tax advice. Statutory filings still require authorized review.</div></div>';
  };

  /*
   * Configurable attendance request catalog. Administrators control which
   * employee-facing forms are available without removing historical requests.
   */
  var ATTENDANCE_FORM_CONFIG = [
    {key:'daily_time',label:'Daily Time Entry',short:'DTR',description:'File a manual time-in and time-out record.',kind:'time',visible:true,core:true},
    {key:'missing_punch',label:'Missing Punch',short:'MP',description:'Supply a missing time-in or time-out for review.',kind:'time',visible:true},
    {key:'attendance_correction',label:'Attendance Correction',short:'AC',description:'Request a correction to an existing attendance record.',kind:'time',visible:true},
    {key:'overtime',label:'Overtime Request',short:'OT',description:'Request approval for work beyond the regular schedule.',kind:'hours',visible:true},
    {key:'official_business',label:'Official Business / Field Work',short:'OB',description:'Document approved work performed away from the office.',kind:'range',visible:true},
    {key:'work_from_home',label:'Work From Home',short:'WFH',description:'Request or document an approved remote-work schedule.',kind:'range',visible:true},
    {key:'rest_day_holiday',label:'Rest Day / Holiday Work',short:'RD',description:'Request approval for work on a rest day or holiday.',kind:'hours',visible:true},
    {key:'undertime',label:'Undertime Request',short:'UT',description:'Declare an early departure or reduced work schedule.',kind:'minutes',visible:true}
  ];
  if(COMPANY.attendanceForms&&COMPANY.attendanceForms.length){
    ATTENDANCE_FORM_CONFIG.forEach(function(f){
      var saved=COMPANY.attendanceForms.find(function(x){return x.key===f.key;});
      if(saved)f.visible=saved.visible!==false;
    });
  }

  function saveAttendanceFormConfig(){
    COMPANY.attendanceForms=ATTENDANCE_FORM_CONFIG.map(function(f){return {key:f.key,visible:f.visible};});
    queueSync('Field_Config');
  }

  window.toggleAttendanceForm=function(key){
    if(!(user.role==='admin'||isPlatformAdmin)){toast('Only administrators can change form visibility.','warning');return;}
    var form=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===key;});
    if(!form)return;
    form.visible=!form.visible;
    saveAttendanceFormConfig();
    toast(form.label+' is now '+(form.visible?'visible':'hidden')+' to employees.','success');
    render();
  };

  window.setAttendanceFormVisibility=function(visible){
    if(!(user.role==='admin'||isPlatformAdmin)){toast('Only administrators can change form visibility.','warning');return;}
    ATTENDANCE_FORM_CONFIG.forEach(function(f){f.visible=!!visible;});
    saveAttendanceFormConfig();
    toast(visible?'All attendance forms are visible.':'All attendance forms are hidden.','success');
    render();
  };

  function renderAttendanceFormManager(){
    var visible=ATTENDANCE_FORM_CONFIG.filter(function(f){return f.visible;}).length;
    return '<div class="card attendance-form-manager" style="margin-top:1rem">'+
      '<div class="card-hd"><div><div class="card-title">Attendance Form Visibility</div><div class="card-sub">Admin-only configuration · '+visible+' of '+ATTENDANCE_FORM_CONFIG.length+' forms visible to employees</div></div>'+
      '<div class="action-row"><button class="btn btn-sm" onclick="setAttendanceFormVisibility(true)">Show all</button><button class="btn btn-sm" onclick="setAttendanceFormVisibility(false)">Hide all</button></div></div>'+
      '<div class="attendance-form-grid">'+ATTENDANCE_FORM_CONFIG.map(function(f){
        return '<div class="attendance-form-setting '+(f.visible?'is-visible':'is-hidden')+'"><div class="attendance-form-mark">'+f.short+'</div>'+
          '<div style="flex:1"><div style="font-weight:700">'+esc(f.label)+'</div><div class="card-sub">'+esc(f.description)+'</div></div>'+
          '<label class="attendance-switch" title="'+(f.visible?'Hide':'Show')+' '+esc(f.label)+'"><input type="checkbox" '+(f.visible?'checked':'')+' onchange="toggleAttendanceForm(\''+f.key+'\')"><span></span></label>'+
          '<span class="badge '+(f.visible?'b-approved':'b-rejected')+'">'+(f.visible?'Visible':'Hidden')+'</span></div>';
      }).join('')+'</div>'+
      '<div style="font-size:11px;color:var(--txt3);margin-top:12px">Visibility only affects the employee filing catalog. Existing requests and attendance records remain available to administrators and approvers.</div></div>';
  }

  window.openAttendanceForm=function(key){
    var form=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===key&&f.visible;});
    if(!form){toast('This attendance form is not currently available.','warning');return;}
    window._attendanceFormKey=key;tab=1;render();
  };

  function attendanceFormFields(form){
    var timeFields=(form.kind==='time')?'<div class="form-row"><div class="field"><label>Time In</label><input type="time" id="att-form-in"></div><div class="field"><label>Time Out</label><input type="time" id="att-form-out"></div></div>':'';
    var hoursFields=(form.kind==='hours')?'<div class="form-row"><div class="field"><label>Start Time</label><input type="time" id="att-form-in"></div><div class="field"><label>Requested Hours</label><input type="number" id="att-form-hours" min=".25" max="24" step=".25" value="1"></div></div>':'';
    var minuteFields=(form.kind==='minutes')?'<div class="field"><label>Undertime Minutes</label><input type="number" id="att-form-minutes" min="1" max="480" step="1" value="30"></div>':'';
    var rangeFields=(form.kind==='range')?'<div class="form-row"><div class="field"><label>End Date</label><input type="date" id="att-form-end" value="'+today()+'"></div><div class="field"><label>Work Location</label><input id="att-form-location" placeholder="Client site, home, or field location"></div></div>':'';
    return '<div class="form-row"><div class="field"><label>Request Date</label><input type="date" id="att-form-date" value="'+today()+'"></div><div class="field"><label>Form Type</label><input value="'+esc(form.label)+'" disabled></div></div>'+
      rangeFields+timeFields+hoursFields+minuteFields+
      '<div class="field"><label>Reason and supporting details</label><textarea id="att-form-reason" rows="4" placeholder="Explain the request and include the expected correction or approval."></textarea></div>';
  }

  function renderEmployeeAttendanceForms(){
    var selected=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===window._attendanceFormKey&&f.visible;});
    var visible=ATTENDANCE_FORM_CONFIG.filter(function(f){return f.visible;});
    var body=selected?
      '<div style="max-width:760px"><button class="btn btn-sm" style="margin-bottom:14px" onclick="window._attendanceFormKey=null;render()">Back to forms</button>'+
      '<div class="section-header">'+esc(selected.label)+'</div><div class="card-sub" style="margin-bottom:14px">'+esc(selected.description)+'</div>'+
      attendanceFormFields(selected)+'<div style="padding:9px 12px;background:var(--accent-bg);border-radius:8px;color:var(--accent-txt);font-size:12px;margin-bottom:12px">Your request will be routed to HR Operations for review and will not affect payroll until approved.</div>'+
      '<div class="action-row"><button class="btn btn-primary" onclick="submitAttendanceFormRequest()">Submit for approval</button><button class="btn" onclick="window._attendanceFormKey=null;render()">Cancel</button></div></div>':
      (visible.length?'<div class="attendance-catalog">'+visible.map(function(f){
        return '<button class="attendance-form-card" onclick="openAttendanceForm(\''+f.key+'\')"><span class="attendance-form-mark">'+f.short+'</span><span><strong>'+esc(f.label)+'</strong><small>'+esc(f.description)+'</small></span><span class="attendance-form-arrow">›</span></button>';
      }).join('')+'</div>':'<div class="empty-state"><div style="font-weight:700;margin-bottom:5px">No attendance forms are currently available.</div>Please contact HR if you need an attendance correction or special request.</div>');
    return '<div class="page-header"><div><div class="page-title">Attendance</div><div class="page-sub">Employee attendance records and approval-controlled requests</div></div></div>'+
      '<div class="tabs"><div class="tab" onclick="window._attendanceFormKey=null;goTab(0)">My Records</div><div class="tab active">Attendance Forms</div></div><div class="card">'+body+'</div>';
  }

  window.submitAttendanceFormRequest=function(){
    var form=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===window._attendanceFormKey&&f.visible;});
    if(!form){toast('This attendance form is not currently available.','warning');return;}
    var value=function(id){return ((document.getElementById(id)||{}).value||'').trim();};
    var date=value('att-form-date'),reason=value('att-form-reason');
    if(!date||!reason){toast('Request date and supporting details are required.','warning');return;}
    var tin=value('att-form-in'),tout=value('att-form-out'),hours=parseFloat(value('att-form-hours'))||0;
    if(form.kind==='time'&&!tin&&!tout){toast('Enter at least a time-in or time-out.','warning');return;}
    if(form.key==='daily_time'){
      ATT.push({id:nAtt++,eid:user.id,date:date,tin:tin,tout:tout,status:'present',ot:0,nd:0,notes:form.label+': '+reason,approvalStatus:'pending',filedBy:user.name,filedAt:new Date().toISOString(),source:'attendance-form'});
      queueSync('Attendance');
    }else{
      var linked=ATT.find(function(a){return a.eid===user.id&&a.date===date;});
      var details=['Request date: '+date];
      if(value('att-form-end'))details.push('End date: '+value('att-form-end'));
      if(tin)details.push('Start / time in: '+tin);
      if(tout)details.push('Time out: '+tout);
      if(hours)details.push('Hours: '+hours);
      if(value('att-form-minutes'))details.push('Minutes: '+value('att-form-minutes'));
      if(value('att-form-location'))details.push('Location: '+value('att-form-location'));
      details.push('Details: '+reason);
      var id=nextCaseId++,due=new Date();due.setDate(due.getDate()+((form.key==='overtime'||form.key==='rest_day_holiday')?2:4));
      RESOLUTION_CASES.push({id:id,caseNo:'CASE-'+new Date().getFullYear()+'-'+String(id).padStart(3,'0'),employeeId:user.id,category:'Attendance',subject:form.label+' · '+date,description:details.join('\n'),priority:(form.key==='overtime'||form.key==='rest_day_holiday')?'high':'normal',status:'open',linkedType:linked?'attendance':'',linkedId:linked?linked.id:null,submittedBy:user.name,submittedAt:new Date().toISOString(),owner:'HR Operations',dueDate:due.toISOString().slice(0,10),resolution:''});
    }
    window._attendanceFormKey=null;
    toast(form.label+' submitted for approval.','success');
    tab=0;render();
  };

  var baseAttendance=window.pgAttendance;
  window.pgAttendance=pgAttendance=function(){
    var admin=user.role==='admin'||isPlatformAdmin;
    if(!admin&&tab===1)return renderEmployeeAttendanceForms();
    var html=baseAttendance();
    if(!admin)html=html.replace('File Attendance','Attendance Forms');
    return html+(admin?renderAttendanceFormManager():'');
  };

  /* Extend payroll approval: approved runs release payslips and create audit events. */
  var baseApprove=window.approvePayroll;
  window.approvePayroll=function(runId){
    baseApprove(runId);
    var r=PAYROLLS.find(function(x){return x.id===runId;});
    if(r&&r.status==='approved'){r.payslipsReleased=true;r.payslipsReleasedAt=new Date().toISOString();r.payslipsReleasedBy=user.name;}
  };

  var style=document.createElement('style');
  style.textContent='.attendance-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.attendance-form-setting{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:10px;padding:11px;background:var(--card)}.attendance-form-setting.is-hidden{opacity:.65;background:var(--bg)}.attendance-form-mark{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;flex:0 0 38px;border-radius:9px;background:var(--accent-bg);color:var(--accent-txt);font-size:11px;font-weight:800}.attendance-switch{position:relative;width:38px;height:22px;flex:0 0 38px}.attendance-switch input{opacity:0;width:0;height:0}.attendance-switch span{position:absolute;inset:0;border-radius:20px;background:var(--border);cursor:pointer;transition:.2s}.attendance-switch span:before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:.2s}.attendance-switch input:checked+span{background:var(--green)}.attendance-switch input:checked+span:before{transform:translateX(16px)}.attendance-catalog{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.attendance-form-card{display:flex;align-items:center;gap:12px;width:100%;padding:15px;border:1px solid var(--border);border-radius:11px;background:var(--card);color:var(--txt);text-align:left;cursor:pointer;font:inherit}.attendance-form-card:hover{border-color:var(--accent);box-shadow:0 4px 14px #0000000d}.attendance-form-card strong{display:block;margin-bottom:3px}.attendance-form-card small{display:block;color:var(--txt3);line-height:1.35}.attendance-form-arrow{margin-left:auto;color:var(--txt3);font-size:24px}@media(max-width:900px){.metrics[style*="repeat(5"]{grid-template-columns:repeat(2,1fr)!important}.content{padding:1rem}.card{overflow-x:auto}.attendance-form-grid,.attendance-catalog{grid-template-columns:1fr}}';
  document.head.appendChild(style);
  render();
}());
