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
    var map={open:'b-info',in_review:'b-pending',resolved:'b-approved',rejected:'b-rejected',cancelled:'b-rejected'};
    var label={open:'Open',in_review:'In review',resolved:'Resolved',rejected:'Rejected',cancelled:'Cancelled'};
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
    view='resolution';tab=isAdminUser(user)?0:1;render();
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
    if(decision==='resolved'&&c.attendanceRequestType==='overtime'){
      var otEmployee=USERS.find(function(u){return u.id===c.employeeId;});
      var otApprovalCheck=otTypeEligibility(otEmployee,c.requestDate,c.otType,c.requestedStart,c.requestedEnd);
      if(!otApprovalCheck.ok){toast('No longer eligible: '+otApprovalCheck.html.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(),'warning',7000);return;}
    }
    if(decision==='resolved'&&c.attendanceRequestType==='rest_day_holiday'){
      var rdhEmployee=USERS.find(function(u){return u.id===c.employeeId;});
      var rdhApprovalCheck=rdhEligibility(rdhEmployee,c.requestDate,c.rdhType,c.requestedStart,c.requestedEnd);
      if(!rdhApprovalCheck.ok){toast('No longer eligible: '+rdhApprovalCheck.html.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(),'warning',7000);return;}
    }
    if(decision==='resolved'&&c.attendanceRequestType==='undertime'&&!actualLogForDate(c.employeeId,c.requestDate)){
      toast('A completed actual Time In and Time Out log is required before approving undertime.','warning');return;
    }
    if(decision==='resolved'&&c.attendanceRequestType==='work_from_home'){
      var missingLogs=requestDates(c.requestDate,c.requestEndDate).filter(function(d){return !actualLogForDate(c.employeeId,d);});
      if(missingLogs.length){toast('WFH approval requires completed Time In and Time Out logs for: '+missingLogs.join(', ')+'.','warning');return;}
    }
    var notes=prompt('Resolution notes / basis:');
    if(notes===null)return;
    if(!notes.trim()){toast('Resolution notes are required for the audit trail.','warning');return;}
    c.status=decision==='resolved'?'resolved':'rejected';
    c.resolution=notes.trim();c.resolvedBy=user.name;c.resolvedAt=new Date().toISOString();
    if(decision==='resolved'){
      if(c.attendanceRequestType==='time_correction'){
        var linkedCorrection=TimekeepingCore.validateLinkedRecord(ATT,c);
        var corrected=upsertAttendance(c.employeeId,c.requestDate,linkedCorrection?{}:{tin:'',tout:'',status:'present',ot:0,nd:0,notes:'Approved '+c.subject,source:'attendance-correction'});
        if(c.punchType==='time_out')corrected.tout=c.correctedTime;
        else corrected.tin=c.correctedTime;
        corrected.approvalStatus='approved';corrected.reviewedBy=user.name;corrected.reviewedAt=c.resolvedAt;
        c.linkedType='attendance';c.linkedId=corrected.id;
        queueSync('Attendance');
      }else if(c.attendanceRequestType==='official_business'){
        var obRecords=[];
        requestDates(c.requestDate,c.requestEndDate).forEach(function(d){
          var current=attendanceRecord(c.employeeId,d);
          var ob=upsertAttendance(c.employeeId,d,{tin:c.requestedStart,tout:c.requestedEnd,status:'present',ot:current&&current.ot||0,nd:current&&current.nd||0,notes:(current&&current.notes?current.notes+' · ':'')+'Approved Official Business',source:'official-business'});
          ob.approvalStatus='approved';ob.reviewedBy=user.name;ob.reviewedAt=c.resolvedAt;obRecords.push(ob.id);
        });
        c.attendanceRecordIds=obRecords;queueSync('Attendance');
      }else if(c.attendanceRequestType==='work_from_home'){
        var wfhRecords=[];
        requestDates(c.requestDate,c.requestEndDate).forEach(function(d){
          var wfh=actualLogForDate(c.employeeId,d);
          wfh.status='present';wfh.approvalStatus='approved';wfh.reviewedBy=user.name;wfh.reviewedAt=c.resolvedAt;
          wfh.notes=(wfh.notes?wfh.notes+' · ':'')+'Approved Work From Home';wfhRecords.push(wfh.id);
        });
        c.attendanceRecordIds=wfhRecords;queueSync('Attendance');
      }else if(c.attendanceRequestType==='schedule_adjustment'){
        var scheduleEmployee=USERS.find(function(e){return e.id===c.employeeId;});
        if(scheduleEmployee){
          if(!scheduleEmployee.scheduleAdjustments)scheduleEmployee.scheduleAdjustments=[];
          scheduleEmployee.scheduleAdjustments.push({id:c.id,from:c.requestDate,to:c.requestEndDate,days:c.scheduleDays||null,status:'approved',approvedBy:user.name,approvedAt:c.resolvedAt});
          queueSync('Employees','Schedule_Adjustments');
        }
      }else if(c.attendanceRequestType==='undertime'){
        var undertime=actualLogForDate(c.employeeId,c.requestDate);
        undertime.undertimeMinutes=Math.max(Number(undertime.undertimeMinutes||0),Number(c.requestedMinutes||0));
        undertime.approvalStatus='approved';undertime.reviewedBy=user.name;undertime.reviewedAt=c.resolvedAt;
        undertime.notes=(undertime.notes?undertime.notes+' · ':'')+'Approved undertime: '+undertime.undertimeMinutes+' minute(s)';
        c.linkedType='attendance';c.linkedId=undertime.id;queueSync('Attendance');
      }else if(c.attendanceRequestType==='overtime'){
        // Re-run through otTypeEligibility (not just calculateEligibleHours) so approval also
        // re-validates the Before/After Shift boundary against the schedule at approval time —
        // the pre-check above already blocked approval if it's no longer eligible, so ok here.
        var otApprovalEmployee=USERS.find(function(u){return u.id===c.employeeId;});
        var otResult=otTypeEligibility(otApprovalEmployee,c.requestDate,c.otType,c.requestedStart,c.requestedEnd);
        var actual=actualLogForDate(c.employeeId,c.requestDate);
        c.eligibleHours=otResult.hours;
        c.actualTimeIn=actual&&actual.tin||'';
        c.actualTimeOut=actual&&actual.tout||'';
        if(actual){
          actual.approvalStatus='approved';actual.reviewedBy=user.name;actual.reviewedAt=c.resolvedAt;
          actual.ot=otResult.hours;
          c.linkedType='attendance';c.linkedId=actual.id;
          queueSync('Attendance');
        }
      }else if(c.attendanceRequestType==='rest_day_holiday'){
        // Recomputed from the LATEST actual log rather than trusting c.eligibleHours from filing
        // time — the pre-check above already re-ran rdhEligibility and blocked approval if it's
        // no longer eligible, so this is guaranteed ok here.
        var rdhEmp=USERS.find(function(u){return u.id===c.employeeId;});
        var rdhResult=rdhEligibility(rdhEmp,c.requestDate,c.rdhType,c.requestedStart,c.requestedEnd);
        var rdhLogActual=actualLogForDate(c.employeeId,c.requestDate);
        c.eligibleHours=rdhResult.hours;
        c.actualTimeIn=rdhLogActual&&rdhLogActual.tin||'';
        c.actualTimeOut=rdhLogActual&&rdhLogActual.tout||'';
        if(rdhLogActual){
          rdhLogActual.approvalStatus='approved';rdhLogActual.reviewedBy=user.name;rdhLogActual.reviewedAt=c.resolvedAt;
          rdhLogActual.restDayHolidayHours=rdhResult.hours;
          c.linkedType='attendance';c.linkedId=rdhLogActual.id;
          queueSync('Attendance');
        }
      }else if(c.linkedType==='attendance'){
        var a=TimekeepingCore.validateLinkedRecord(ATT,c);
        if(a){a.approvalStatus='approved';a.reviewedBy=user.name;a.reviewedAt=c.resolvedAt;}
      }else if(c.linkedType==='leave'){
        var l=LEAVES.find(function(x){return x.id===c.linkedId;});
        if(l)l.status='approved';
      }
    }
    toast(c.caseNo+' '+(decision==='resolved'?'resolved':'closed without change')+'.',decision==='resolved'?'success':'warning');render();
  };

  // Lets an employee withdraw their own request while it's still awaiting action — covers
  // both plain Resolution Center cases and the Attendance Forms catalog (OT/undertime/
  // schedule adjustment/etc.), since submitAttendanceFormRequest() files into this same
  // RESOLUTION_CASES array. Once resolved/rejected/already cancelled, there's nothing to
  // withdraw.
  window.cancelResolutionCase=function(id){
    var c=RESOLUTION_CASES.find(function(x){return x.id===id;});
    if(!c||c.employeeId!==user.id||(c.status!=='open'&&c.status!=='in_review'))return;
    if(!confirm('Cancel this request? This cannot be undone.'))return;
    c.status='cancelled';c.resolution='Cancelled by employee';c.resolvedBy=user.name;c.resolvedAt=new Date().toISOString();
    queueSync('Resolution_Cases');toast(c.caseNo+' cancelled.','success');render();
  };

  window.pgResolution=function() {
    var isAdmin=isAdminUser(user)||isPlatformAdmin;
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
              (!isAdmin&&c.employeeId===user.id&&(c.status==='open'||c.status==='in_review')?
              '<button class="btn btn-sm btn-danger" onclick="cancelResolutionCase('+c.id+')">Cancel</button>':
              '<button class="btn btn-sm" onclick="openResolutionForm(\''+c.category+'\',\''+(c.linkedType||'')+'\','+(c.linkedId||'null')+')">Follow up</button>'))+'</td></tr>';
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

  window.sidebarExtraSections=function(){
    var pending=RESOLUTION_CASES.filter(function(c){return c.status==='open'||c.status==='in_review';}).length;
    return [{title:'Service Desk',items:[
      {v:'resolution',k:'file',l:'Resolution Center',badge:pending}
    ]}];
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
    var isAdmin=isAdminUser(user)||isPlatformAdmin;var tabs=['Review Results','Goals & Check-ins','Calibration'];var records=isAdmin?PERF:PERF.filter(function(p){return p.eid===user.id;});
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
  var SHIFT_DAY_KEYS=['mon','tue','wed','thu','fri','sat','sun'];
  var SHIFT_DAY_LABELS={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
  var SHIFT_DAY_SHORT={mon:'Mon',tue:'Tue',wed:'Wed',thu:'Thu',fri:'Fri',sat:'Sat',sun:'Sun'};

  function defaultShiftSchedule(){
    var schedule={};
    SHIFT_DAY_KEYS.forEach(function(k){
      schedule[k]=(k==='sun')?{restDay:true,start:'',end:'',breakStart:'',breakEnd:''}
        :{restDay:false,start:'08:00',end:'17:00',breakStart:'12:00',breakEnd:'13:00'};
    });
    return schedule;
  }

  var SHIFT_DEFINITIONS=(COMPANY.shifts&&COMPANY.shifts.length?COMPANY.shifts:[
    {id:1,name:'Regular Day Shift',graceMinutes:5,active:true,schedule:defaultShiftSchedule()},
    {id:2,name:'Early Shift',graceMinutes:5,active:true,schedule:(function(){var s=defaultShiftSchedule();SHIFT_DAY_KEYS.forEach(function(k){if(!s[k].restDay){s[k].start='06:00';s[k].end='15:00';}});return s;})()},
    {id:3,name:'Night Shift',graceMinutes:5,active:true,schedule:(function(){var s=defaultShiftSchedule();SHIFT_DAY_KEYS.forEach(function(k){if(!s[k].restDay){s[k].start='22:00';s[k].end='06:00';s[k].breakStart='02:00';s[k].breakEnd='03:00';}});return s;})()}
  ]);
  COMPANY.shifts=SHIFT_DEFINITIONS; /* keep readable from other files even before the first explicit save */
  var nextShiftId=SHIFT_DEFINITIONS.reduce(function(max,s){return Math.max(max,s.id||0);},0)+1;
  USERS.filter(function(e){return e.role==='employee';}).forEach(function(e){if(!e.shiftId)e.shiftId=1;});

  function saveShiftConfig(){
    COMPANY.shifts=SHIFT_DEFINITIONS;
    queueSync('Shift_Config');
  }

  function validShiftTime(value){return /^([01]\d|2[0-3]):[0-5]\d$/.test(value||'');}

  // Groups consecutive days that share the exact same start/end/rest-day status into a
  // single readable range, e.g. "Mon–Sat 8:00–17:00, Sun Rest Day" instead of 7 rows.
  function describeShiftPattern(shift){
    var normalized=TimekeepingCore.normalizeShift(shift);
    var groups=[];
    SHIFT_DAY_KEYS.forEach(function(k){
      var day=normalized.schedule[k]||{restDay:true};
      var sig=day.restDay?'REST':(day.start+'-'+day.end);
      var last=groups[groups.length-1];
      if(last&&last.sig===sig)last.days.push(k);
      else groups.push({sig:sig,days:[k],restDay:day.restDay,start:day.start,end:day.end});
    });
    return groups.map(function(g){
      var label=g.days.length>1?SHIFT_DAY_SHORT[g.days[0]]+'–'+SHIFT_DAY_SHORT[g.days[g.days.length-1]]:SHIFT_DAY_SHORT[g.days[0]];
      return g.restDay?label+' Rest Day':label+' '+g.start+'–'+g.end;
    }).join(', ');
  }

  window.openShiftEditor=function(shiftId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var existing=shiftId?SHIFT_DEFINITIONS.find(function(s){return s.id===shiftId;}):null;
    var draft=existing?JSON.parse(JSON.stringify(TimekeepingCore.normalizeShift(existing))):{
      id:null,name:'',graceMinutes:5,active:true,schedule:defaultShiftSchedule()
    };
    modal={type:'shiftEditor',draft:draft,isNew:!existing};
    render();
  };

  window.shiftEditorApplyToAll=function(dayKey){
    if(!modal||modal.type!=='shiftEditor')return;
    var src=modal.draft.schedule[dayKey];
    SHIFT_DAY_KEYS.forEach(function(k){
      if(k===dayKey||modal.draft.schedule[k].restDay)return;
      modal.draft.schedule[k]=Object.assign({},src,{restDay:false});
    });
    render();
  };

  window.saveShiftEditor=function(){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var d=modal.draft;
    if(!d.name||!d.name.trim()){toast('Shift name is required.','warning');return;}
    for(var i=0;i<SHIFT_DAY_KEYS.length;i++){
      var k=SHIFT_DAY_KEYS[i],day=d.schedule[k];
      // A rest day never keeps leftover times underneath — whether from an old save made
      // before this was enforced, or from a row toggled to Rest Day and back — so nothing
      // downstream (reports, exports) can read stale hours off a day marked Rest Day.
      if(day.restDay){day.start='';day.end='';day.breakStart='';day.breakEnd='';continue;}
      if(!validShiftTime(day.start)||!validShiftTime(day.end)){toast('Enter valid start/end times for '+SHIFT_DAY_LABELS[k]+', or mark it as a rest day.','warning');return;}
      if(day.breakStart&&!validShiftTime(day.breakStart)){toast('Enter a valid break start time for '+SHIFT_DAY_LABELS[k]+'.','warning');return;}
      if(day.breakEnd&&!validShiftTime(day.breakEnd)){toast('Enter a valid break end time for '+SHIFT_DAY_LABELS[k]+'.','warning');return;}
    }
    var graceMinutes=parseInt(d.graceMinutes,10);
    if(isNaN(graceMinutes)||graceMinutes<0){toast('Enter a valid grace period.','warning');return;}
    if(d.id){
      var existing=SHIFT_DEFINITIONS.find(function(s){return s.id===d.id;});
      Object.assign(existing,{name:d.name.trim(),graceMinutes:graceMinutes,schedule:d.schedule});
      delete existing.start;delete existing.end;delete existing.breakMinutes;
    }else{
      SHIFT_DEFINITIONS.push({id:nextShiftId++,name:d.name.trim(),graceMinutes:graceMinutes,active:true,schedule:d.schedule});
    }
    saveShiftConfig();closeM();toast('Shift saved.','success');
  };

  window.toggleShift=function(id){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var s=SHIFT_DEFINITIONS.find(function(x){return x.id===id;});if(!s)return;
    s.active=!s.active;saveShiftConfig();render();
  };

  window.deleteShift=function(id){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var assigned=USERS.filter(function(e){return e.shiftId===id;}).length;
    if(assigned){toast('Reassign '+assigned+' employee(s) before deleting this shift.','warning');return;}
    var index=SHIFT_DEFINITIONS.findIndex(function(s){return s.id===id;});if(index<0)return;
    if(!confirm('Delete this shift?'))return;
    SHIFT_DEFINITIONS.splice(index,1);saveShiftConfig();render();
  };

  window.assignEmployeeShift=function(employeeId,shiftId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var employee=USERS.find(function(e){return e.id===employeeId;}),shift=SHIFT_DEFINITIONS.find(function(s){return s.id===shiftId;});
    if(!employee||!shift)return;
    employee.shiftId=shiftId;queueSync('Employees','Employee_Shifts');toast(shift.name+' assigned to '+employee.name+'.','success');render();
  };

  // Personal Schedule: an optional, permanent per-employee override of the shared shift
  // template's weekly pattern (same day-by-day shape as a shift), for the one employee whose
  // hours or rest day genuinely differ from everyone else on the same shift — without forking
  // a new shared template just for them. TimekeepingCore checks this before falling back to
  // the assigned shift; an approved Schedule Adjustment still overrides both.
  window.openPersonalScheduleEditor=function(employeeId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var employee=USERS.find(function(e){return e.id===employeeId;});
    if(!employee)return;
    var isNew=!employee.personalSchedule;
    var baseSchedule;
    if(!isNew){
      baseSchedule=JSON.parse(JSON.stringify(employee.personalSchedule));
    }else{
      // Intelligent default: start from whatever this employee currently actually follows
      // (their assigned shift's pattern) so the admin only has to change the day(s) that
      // need to be different, instead of re-entering a whole week from scratch.
      var assignedShift=SHIFT_DEFINITIONS.find(function(s){return s.id===employee.shiftId;});
      baseSchedule=assignedShift?JSON.parse(JSON.stringify(TimekeepingCore.normalizeShift(assignedShift).schedule)):defaultShiftSchedule();
    }
    modal={type:'personalScheduleEditor',employeeId:employeeId,draft:baseSchedule,isNew:isNew};
    render();
  };

  window.personalScheduleApplyToAll=function(dayKey){
    if(!modal||modal.type!=='personalScheduleEditor')return;
    var src=modal.draft[dayKey];
    SHIFT_DAY_KEYS.forEach(function(k){
      if(k===dayKey||modal.draft[k].restDay)return;
      modal.draft[k]=Object.assign({},src,{restDay:false});
    });
    render();
  };

  window.savePersonalSchedule=function(){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var employee=USERS.find(function(e){return e.id===modal.employeeId;});
    if(!employee)return;
    var d=modal.draft;
    for(var i=0;i<SHIFT_DAY_KEYS.length;i++){
      var k=SHIFT_DAY_KEYS[i],day=d[k];
      // A rest day never keeps leftover times underneath — whether from an old save made
      // before this was enforced, or from a row toggled to Rest Day and back — so nothing
      // downstream (reports, exports) can read stale hours off a day marked Rest Day.
      if(day.restDay){day.start='';day.end='';day.breakStart='';day.breakEnd='';continue;}
      if(!validShiftTime(day.start)||!validShiftTime(day.end)){toast('Enter valid start/end times for '+SHIFT_DAY_LABELS[k]+', or mark it as a rest day.','warning');return;}
      if(day.breakStart&&!validShiftTime(day.breakStart)){toast('Enter a valid break start time for '+SHIFT_DAY_LABELS[k]+'.','warning');return;}
      if(day.breakEnd&&!validShiftTime(day.breakEnd)){toast('Enter a valid break end time for '+SHIFT_DAY_LABELS[k]+'.','warning');return;}
    }
    // Refuse a week that's entirely rest days — almost certainly a mistake (every field left
    // unedited from a rest-day-heavy starting point), not a deliberate "never works" schedule.
    if(SHIFT_DAY_KEYS.every(function(k){return d[k].restDay;})){toast('Every day is marked Rest Day — mark at least one working day, or remove the personal schedule instead.','warning');return;}
    employee.personalSchedule=d;
    queueSync('Employees','Personal_Schedules');
    closeM();
    toast('Personal schedule saved for '+employee.name+'.','success');
  };

  window.removePersonalSchedule=function(employeeId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var employee=USERS.find(function(e){return e.id===employeeId;});
    if(!employee||!employee.personalSchedule)return;
    if(!confirm(employee.name+' will go back to following the assigned shift template. Continue?'))return;
    delete employee.personalSchedule;
    queueSync('Employees','Personal_Schedules');
    toast('Personal schedule removed — now following the assigned shift template.','success');
    render();
  };

  function renderShiftManager(){
    var personalCount=USERS.filter(function(e){return e.role==='employee'&&e.personalSchedule;}).length;
    return '<div class="card" style="margin-top:1rem"><div class="card-hd"><div><div class="card-title">Shift Setup</div><div class="card-sub">Set a start/end and break per day of the week, with rest days, and assign from each employee profile'+(personalCount?' · '+personalCount+' employee(s) currently on a Personal Schedule override':'')+'</div></div><div class="action-row"><button class="btn btn-sm" onclick="openBulkPersonalSchedule()">📋 Bulk Import Personal Schedules</button><button class="btn btn-primary btn-sm" onclick="openShiftEditor()">+ Add Shift</button></div></div>'+
      '<div style="overflow-x:auto"><table><thead><tr><th>Shift</th><th>Weekly Pattern</th><th>Grace</th><th>Employees</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+
      SHIFT_DEFINITIONS.map(function(s){var count=USERS.filter(function(e){return e.role==='employee'&&e.shiftId===s.id;}).length;return '<tr><td style="font-weight:700">'+esc(s.name)+'</td><td class="mono" style="font-size:12px">'+esc(describeShiftPattern(s))+'</td><td>'+s.graceMinutes+' min</td><td>'+count+'</td><td><span class="badge '+(s.active?'b-approved':'b-rejected')+'">'+(s.active?'Active':'Inactive')+'</span></td><td><div class="action-row"><button class="btn btn-sm" onclick="openShiftEditor('+s.id+')">Edit</button><button class="btn btn-sm" onclick="toggleShift('+s.id+')">'+(s.active?'Deactivate':'Activate')+'</button><button class="btn btn-sm btn-danger" onclick="deleteShift('+s.id+')">Delete</button></div></td></tr>';}).join('')+
      '</tbody></table></div></div>';
  }

  /* ---- Holiday Calendar ----
   * Dates entered here get auto-matched against attendance so approved holiday/rest-day
   * work is paid at the correct statutory rate instead of one flat premium for everything. */
  var HOLIDAY_TYPE_LABELS={
    'regular':'Regular Holiday',
    'special-non-working':'Special Non-Working Holiday',
    'special-working':'Special Working Holiday',
    'double':'Double Holiday'
  };
  var HOLIDAYS=(COMPANY.holidays&&COMPANY.holidays.length?COMPANY.holidays:[]);
  COMPANY.holidays=HOLIDAYS; /* keep readable from other files even before the first explicit save */
  var nextHolidayId=HOLIDAYS.reduce(function(max,h){return Math.max(max,h.id||0);},0)+1;

  function saveHolidayConfig(){
    COMPANY.holidays=HOLIDAYS;
    queueSync('Holiday_Config');
  }

  window.openHolidayEditor=function(holidayId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var existing=holidayId?HOLIDAYS.find(function(h){return h.id===holidayId;}):null;
    modal={type:'holidayEditor',draft:existing?Object.assign({},existing):{id:null,date:'',name:'',type:'regular'},isNew:!existing};
    render();
  };

  window.saveHolidayEditor=function(){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var d=modal.draft;
    if(!d.date){toast('Please pick a date.','warning');return;}
    if(!d.name||!d.name.trim()){toast('Holiday name is required.','warning');return;}
    if(!HOLIDAY_TYPE_LABELS[d.type]){toast('Please choose a holiday type.','warning');return;}
    var dup=HOLIDAYS.find(function(h){return h.date===d.date&&h.id!==d.id;});
    if(dup&&d.type!=='double'&&dup.type!=='double'){
      if(!confirm('Another holiday ("'+dup.name+'") is already set on '+d.date+'. If two regular holidays genuinely coincide, use the "Double Holiday" type instead. Save anyway?'))return;
    }
    if(d.id){
      var existing=HOLIDAYS.find(function(h){return h.id===d.id;});
      Object.assign(existing,{date:d.date,name:d.name.trim(),type:d.type});
    }else{
      HOLIDAYS.push({id:nextHolidayId++,date:d.date,name:d.name.trim(),type:d.type});
    }
    HOLIDAYS.sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0;});
    saveHolidayConfig();closeM();toast('Holiday saved.','success');
  };

  window.deleteHoliday=function(id){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var index=HOLIDAYS.findIndex(function(h){return h.id===id;});if(index<0)return;
    if(!confirm('Delete this holiday?'))return;
    HOLIDAYS.splice(index,1);saveHolidayConfig();render();
  };

  function renderHolidayManager(){
    var upcoming=HOLIDAYS.slice().sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0;});
    return '<div class="card" style="margin-top:1rem"><div class="card-hd"><div><div class="card-title">Holiday Calendar</div><div class="card-sub">Dates here are automatically matched against attendance, and payroll uses the matching holiday pay rate for approved holiday work</div></div><button class="btn btn-primary btn-sm" onclick="openHolidayEditor()">+ Add Holiday</button></div>'+
      '<div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Holiday</th><th>Type</th><th>Actions</th></tr></thead><tbody>'+
      (upcoming.length?upcoming.map(function(h){
        return '<tr><td class="mono">'+esc(h.date)+'</td><td style="font-weight:700">'+esc(h.name)+'</td><td><span class="badge">'+esc(HOLIDAY_TYPE_LABELS[h.type]||h.type)+'</span></td><td><div class="action-row"><button class="btn btn-sm" onclick="openHolidayEditor('+h.id+')">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteHoliday('+h.id+')">Delete</button></div></td></tr>';
      }).join(''):'<tr><td colspan="4" style="text-align:center;color:var(--txt3);padding:2rem">No holidays configured yet.</td></tr>')+
      '</tbody></table></div></div>';
  }

  /* ---- Leave Policy ----
   * Defines leave TYPES (entitlement, accrual, paid/unpaid, carry-over, eligibility rules) —
   * replaces the old hardcoded dropdown in File Leave with configurable policy, and is the
   * basis for per-employee balance tracking and eligibility checks (Stage 2/3). */
  var LEAVE_GENDER_LABELS={'':'Any gender','female':'Female only','male':'Male only'};
  var LEAVE_ACCRUAL_LABELS={'upfront':'Full amount at year start','monthly':'Accrues monthly (1/12 per month)'};
  var LEAVE_BASIS_LABELS={'hire':'Date hired','regularization':'Date of regularization'};
  // eligibilityBasis: 'hire' (clock starts day 1) or 'regularization' (clock starts only once
  // status leaves 'probationary' — see checkOffboarding()'s auto-convert on probEndDate;
  // probationary employees are simply not eligible yet under this basis, full stop).
  // prorateFirstGrant: for 'upfront' types, whether the very first grant (at eligibility) is
  // cut down to the months remaining in the calendar year, vs. handing over the full
  // annualDays regardless of when eligibility started. Meaningless for 'monthly' accrual,
  // which already prorates naturally by only ticking forward from eligibility.
  var LEAVE_TYPES=(COMPANY.leaveTypes&&COMPANY.leaveTypes.length?COMPANY.leaveTypes:[
    {id:1,name:'Vacation Leave',code:'VL',paid:true,annualDays:15,accrualMethod:'upfront',eligibilityBasis:'regularization',prorateFirstGrant:true,carryOver:true,maxCarryOverDays:5,genderRestriction:'',minTenureMonths:0,employeeTypes:[],active:true},
    {id:2,name:'Sick Leave',code:'SL',paid:true,annualDays:15,accrualMethod:'upfront',eligibilityBasis:'regularization',prorateFirstGrant:true,carryOver:false,maxCarryOverDays:0,genderRestriction:'',minTenureMonths:0,employeeTypes:[],active:true},
    {id:3,name:'Emergency Leave',code:'EL',paid:true,annualDays:5,accrualMethod:'upfront',eligibilityBasis:'hire',prorateFirstGrant:false,carryOver:false,maxCarryOverDays:0,genderRestriction:'',minTenureMonths:0,employeeTypes:[],active:true},
    {id:4,name:'Maternity Leave',code:'ML',paid:true,annualDays:105,accrualMethod:'upfront',eligibilityBasis:'hire',prorateFirstGrant:false,carryOver:false,maxCarryOverDays:0,genderRestriction:'female',minTenureMonths:0,employeeTypes:[],active:true},
    {id:5,name:'Paternity Leave',code:'PL',paid:true,annualDays:7,accrualMethod:'upfront',eligibilityBasis:'hire',prorateFirstGrant:false,carryOver:false,maxCarryOverDays:0,genderRestriction:'male',minTenureMonths:0,employeeTypes:[],active:true},
    {id:6,name:'Solo Parent Leave',code:'SPL',paid:true,annualDays:7,accrualMethod:'upfront',eligibilityBasis:'hire',prorateFirstGrant:false,carryOver:false,maxCarryOverDays:0,genderRestriction:'',minTenureMonths:12,employeeTypes:[],active:true},
    {id:7,name:'Bereavement Leave',code:'BL',paid:true,annualDays:3,accrualMethod:'upfront',eligibilityBasis:'hire',prorateFirstGrant:false,carryOver:false,maxCarryOverDays:0,genderRestriction:'',minTenureMonths:0,employeeTypes:[],active:true}
  ]);
  COMPANY.leaveTypes=LEAVE_TYPES; /* keep readable from other files even before the first explicit save */
  var nextLeaveTypeId=LEAVE_TYPES.reduce(function(max,t){return Math.max(max,t.id||0);},0)+1;

  function saveLeaveTypeConfig(){
    COMPANY.leaveTypes=LEAVE_TYPES;
    queueSync('Leave_Policy');
  }

  function tenureMonths(employee){
    if(!employee||!employee.hired)return 0;
    var hired=new Date(employee.hired+'T00:00:00Z'),now=new Date();
    return Math.max(0,(now.getUTCFullYear()-hired.getUTCFullYear())*12+(now.getUTCMonth()-hired.getUTCMonth()));
  }

  // The date this employee's entitlement clock actually starts for a given type — 'hire' is
  // always known; 'regularization' falls back to hired date if probEndDate was never recorded
  // (e.g. a direct-hire regular with no tracked probation period).
  function leaveEligibilityStartDate(employee,leaveType){
    if(!employee)return null;
    if(leaveType.eligibilityBasis==='regularization'){
      if(employee.type==='probationary')return null; // not yet regularized — no start date at all
      return employee.probEndDate||employee.hired||null;
    }
    return employee.hired||null;
  }

  // Default (policy-based) eligibility for a leave type — gender, regularization status,
  // minimum tenure, and employment type all have to match. A newly-created type
  // (requiresAssignment:true) never gets policy-based eligibility at all — it only becomes
  // available once an admin explicitly assigns it (per-employee, or via "Assign to All"),
  // so adding a new leave type doesn't silently hand it to the whole company. The original
  // seed types predate this flag and keep working exactly as before. An explicit
  // per-employee override (Stage 2, employee.leaveOverrides[typeId]) always takes precedence
  // over both when present.
  function leaveTypePolicyEligible(employee,leaveType){
    if(!employee||!leaveType)return false;
    if(leaveType.requiresAssignment)return false;
    if(leaveType.genderRestriction&&employee.gender&&employee.gender.toLowerCase()!==leaveType.genderRestriction)return false;
    if(!leaveEligibilityStartDate(employee,leaveType))return false; /* covers the regularization gate */
    if(tenureMonths(employee)<(leaveType.minTenureMonths||0))return false;
    if(leaveType.employeeTypes&&leaveType.employeeTypes.length&&leaveType.employeeTypes.indexOf(employee.type)<0)return false;
    return true;
  }
  window.leaveTypeEligible=function(employee,leaveType){
    if(!employee||employee.active===false)return false; /* inactive employees are never covered, override or not */
    var override=employee.leaveOverrides&&employee.leaveOverrides[leaveType.id];
    if(override!==undefined)return !!override;
    return leaveTypePolicyEligible(employee,leaveType);
  };

  window.assignLeaveTypeToAll=function(typeId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var t=LEAVE_TYPES.find(function(x){return x.id===typeId;});if(!t)return;
    if(!confirm('Assign "'+t.name+'" to every active employee, granting their starting balance immediately? Inactive employees are skipped.'))return;
    var tod=today(),count=0;
    USERS.filter(function(e){return e.role==='employee'&&e.active!==false;}).forEach(function(e){
      if(!e.leaveOverrides)e.leaveOverrides={};
      e.leaveOverrides[typeId]=true;
      grantLeaveIfDue(e,t,tod);
      count++;
    });
    queueSync('Employees');
    toast('Assigned '+t.name+' to '+count+' active employee(s) and granted starting balances.','success');render();
  };

  window.unassignLeaveTypeFromAll=function(typeId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var t=LEAVE_TYPES.find(function(x){return x.id===typeId;});if(!t)return;
    if(!confirm('Unassign "'+t.name+'" from every employee? This does not touch their existing balance, just their eligibility.'))return;
    var count=0;
    USERS.filter(function(e){return e.role==='employee';}).forEach(function(e){
      if(!e.leaveOverrides)e.leaveOverrides={};
      e.leaveOverrides[typeId]=false;count++;
    });
    queueSync('Employees');
    toast('Unassigned '+t.name+' from '+count+' employee(s).','success');render();
  };

  window.openLeaveTypeEditor=function(typeId){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var existing=typeId?LEAVE_TYPES.find(function(t){return t.id===typeId;}):null;
    modal={type:'leaveTypeEditor',isNew:!existing,draft:existing?Object.assign({},existing,{employeeTypes:(existing.employeeTypes||[]).slice()}):
      {id:null,name:'',code:'',paid:true,annualDays:0,accrualMethod:'upfront',eligibilityBasis:'hire',prorateFirstGrant:false,carryOver:false,maxCarryOverDays:0,genderRestriction:'',minTenureMonths:0,employeeTypes:[],active:true}};
    render();
  };

  window.saveLeaveTypeEditor=function(){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var d=modal.draft;
    if(!d.name||!d.name.trim()){toast('Leave type name is required.','warning');return;}
    if(!d.code||!d.code.trim()){toast('A short code (e.g. VL, SL) is required.','warning');return;}
    var dupCode=LEAVE_TYPES.find(function(t){return t.code.toLowerCase()===d.code.trim().toLowerCase()&&t.id!==d.id;});
    if(dupCode){toast('Code "'+d.code+'" is already used by '+dupCode.name+'.','warning');return;}
    if(Number(d.annualDays)<0){toast('Annual entitlement cannot be negative.','warning');return;}
    var payload={name:d.name.trim(),code:d.code.trim().toUpperCase(),paid:!!d.paid,annualDays:Number(d.annualDays)||0,
      accrualMethod:d.accrualMethod==='monthly'?'monthly':'upfront',
      eligibilityBasis:d.eligibilityBasis==='regularization'?'regularization':'hire',
      prorateFirstGrant:d.accrualMethod!=='monthly'&&!!d.prorateFirstGrant,
      carryOver:!!d.carryOver,maxCarryOverDays:d.carryOver?(Number(d.maxCarryOverDays)||0):0,genderRestriction:d.genderRestriction||'',
      minTenureMonths:Number(d.minTenureMonths)||0,employeeTypes:(d.employeeTypes||[]).slice(),active:d.active!==false};
    if(modal.isNew)payload.requiresAssignment=true; /* new types are opt-in only — never touched again on later edits */
    else if(d.id){var prior=LEAVE_TYPES.find(function(t){return t.id===d.id;});if(prior)payload.requiresAssignment=!!prior.requiresAssignment;}
    if(d.id){
      Object.assign(LEAVE_TYPES.find(function(t){return t.id===d.id;}),payload);
    }else{
      LEAVE_TYPES.push(Object.assign({id:nextLeaveTypeId++},payload));
    }
    saveLeaveTypeConfig();closeM();toast('Leave policy saved.','success');
  };

  window.toggleLeaveType=function(id){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var t=LEAVE_TYPES.find(function(x){return x.id===id;});if(!t)return;
    t.active=!t.active;saveLeaveTypeConfig();toast(t.name+' is now '+(t.active?'active':'inactive')+'.','success');render();
  };

  window.deleteLeaveType=function(id){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var t=LEAVE_TYPES.find(function(x){return x.id===id;});if(!t)return;
    var used=LEAVES.some(function(l){return l.type===t.name;});
    if(used){toast('Cannot delete: existing leave requests reference "'+t.name+'". Deactivate it instead.','warning');return;}
    if(!confirm('Delete "'+t.name+'"? This cannot be undone.'))return;
    LEAVE_TYPES.splice(LEAVE_TYPES.indexOf(t),1);saveLeaveTypeConfig();render();
  };

  function describeLeaveEligibility(t){
    if(t.requiresAssignment)return'Not assigned to anyone yet — needs "Assign to All" or per-employee assignment';
    var parts=[LEAVE_BASIS_LABELS[t.eligibilityBasis||'hire']];
    if(t.accrualMethod==='upfront'&&t.prorateFirstGrant)parts.push('prorated first grant');
    if(t.genderRestriction)parts.push(LEAVE_GENDER_LABELS[t.genderRestriction]);
    if(t.minTenureMonths)parts.push(t.minTenureMonths+'+ months tenure');
    if(t.employeeTypes&&t.employeeTypes.length)parts.push(t.employeeTypes.map(function(c){var lt=LOOKUPS.employmentTypes.find(function(x){return x.code===c;});return lt?lt.code:c;}).join('/'));
    return parts.join(' · ');
  }

  // Leave policy year can run on the calendar (default, start month 1) or a fiscal year
  // (e.g. start month 4 = April–March), set company-wide via COMPANY.leaveFiscalYearStartMonth.
  window.leaveFiscalYearStartMonth=function(){
    var m=Number(COMPANY.leaveFiscalYearStartMonth)||1;
    return m>=1&&m<=12?m:1;
  };
  // The "leave year" label a date falls into — e.g. with a July page date, if the policy year
  // starts in April, that's still fiscal year "2026" (Apr 2026–Mar 2027); a February 2026
  // date would fall in fiscal year "2025" (Apr 2025–Mar 2026).
  window.leaveFiscalYear=function(dateStr){
    var d=new Date((dateStr||today())+'T00:00:00Z'),startMonth=leaveFiscalYearStartMonth(),month=d.getUTCMonth()+1;
    return month>=startMonth?d.getUTCFullYear():d.getUTCFullYear()-1;
  };
  // How many months remain (inclusive of the start month) in the current policy year from a
  // given date — used to prorate a first grant, e.g. regularized in the 2nd month of the
  // policy year leaves 10 of the year's 12 months of entitlement remaining.
  function leaveFiscalMonthsRemaining(dateStr){
    var d=new Date((dateStr||today())+'T00:00:00Z'),startMonth=leaveFiscalYearStartMonth(),month=d.getUTCMonth()+1;
    var elapsed=(month-startMonth+12)%12;
    return 12-elapsed;
  }

  // 'YYYY-MM' -> a comparable/subtractable absolute month count.
  function monthIndex(ym){var p=ym.split('-');return parseInt(p[0],10)*12+parseInt(p[1],10);}
  function prevYearMonth(ym){
    var y=parseInt(ym.slice(0,4),10),m=parseInt(ym.slice(5,7),10)-1;
    if(m<1){m=12;y--;}
    return y+'-'+(m<10?'0':'')+m;
  }
  // Half-month proration rule for a first grant: eligibility starting on the 1st-15th of a
  // month counts that whole month toward the grant; starting on the 16th-end only counts it as
  // half a month. Only ever applies once, to the single month eligibility actually began in —
  // every other month in the grant (before or after) is a normal full month.
  function halfMonthDiscount(dateStr){
    return parseInt(dateStr.slice(8,10),10)>=16?0.5:0;
  }
  function fiscalYearStartYM(fiscalYearLabel){
    var m=leaveFiscalYearStartMonth();
    return fiscalYearLabel+'-'+(m<10?'0':'')+m;
  }

  // Grants leave balances per policy.
  //
  // 'monthly' types tick by annualDays/12 per elapsed calendar month, guarded by
  // lastAccrualMonth. Since the sweep only runs when someone logs in (not on a fixed monthly
  // clock), a gap between logins — or an employee's very first sweep long after their
  // eligibility start date — has to catch up every month in between at once, not just credit a
  // single month's worth: monthsToCredit counts every month from (lastAccrualMonth, or the
  // month before eligibility started, for a first grant) through the current month inclusive.
  //
  // 'upfront' types special-case the FIRST grant an employee ever receives (tracked via
  // bucket.firstGrantDate): if the type prorates first grants AND eligibility started within
  // THE CURRENT policy year (a genuinely new mid-year hire/regularization), the grant is cut
  // down to the months remaining in that policy year. Otherwise — including any employee whose
  // eligibility started in a past policy year, e.g. backfilling an already-tenured employee
  // when this system is first set up — they get the full annualDays now; there's no attempt to
  // reconstruct what they "should" have accrued in prior years, since Set Balance is the right
  // tool for migrating a real historical balance. After the first grant, 'upfront' types renew
  // the full annualDays once per policy year (plus any carried-over balance, capped at
  // maxCarryOverDays — the rest is forfeited), guarded by lastAccrualYear. Right before that
  // reset, the outgoing balance is snapshotted into bucket.yearlyClosingBalances so a forfeited
  // or carried-over prior year's balance stays visible (Leave tab > History) even after reset.
  // Core grant check for one employee + one leave type, as of `tod`. Returns true if a
  // balance change was made (first grant, a monthly tick, or an annual renewal), false if
  // nothing was due (not eligible, not yet started, or already credited for this period).
  // Shared by runLeaveAccrual (bulk/manual), assignment actions (grant immediately instead of
  // waiting for the next manual run), and the automatic per-login sweep.
  function grantLeaveIfDue(emp,t,tod){
    if(!t.active||!leaveTypeEligible(emp,t))return false;
    var startDate=leaveEligibilityStartDate(emp,t);
    if(!startDate||startDate>tod)return false; /* not yet regularized / not yet hired */
    var fiscalYear=leaveFiscalYear(tod),yearMonth=tod.slice(0,7);
    if(!emp.leaveBalances)emp.leaveBalances={};
    var bucket=emp.leaveBalances[t.id]||{balance:0,adjustments:[]};
    bucket.adjustments=bucket.adjustments||[];
    bucket.yearlyClosingBalances=bucket.yearlyClosingBalances||{};
    var actor=(user&&user.name)||'System';
    if(t.accrualMethod==='monthly'){
      if(bucket.lastAccrualMonth===yearMonth)return false;
      var isFirst=!bucket.firstGrantDate;
      // Catch-up is capped to the current policy year — same "don't reconstruct prior years"
      // rule as the upfront branch below. A first grant whose eligibility started in an earlier
      // fiscal year (a long-tenured employee's very first sweep) only catches up from the start
      // of THIS fiscal year, not every month since they became eligible; likewise, a stale
      // lastAccrualMonth left over from a previous fiscal year (employee hasn't logged in since)
      // doesn't get carried across the year boundary. Set Balance is the tool for a real
      // historical balance.
      var currentFYStartYM=fiscalYearStartYM(fiscalYear);
      var referenceYM,startedThisFY=leaveFiscalYear(startDate)===fiscalYear;
      if(isFirst){
        var startYM=startDate.slice(0,7);
        referenceYM=startedThisFY?prevYearMonth(startYM):prevYearMonth(currentFYStartYM);
      }else{
        referenceYM=leaveFiscalYear(bucket.lastAccrualMonth+'-01')===fiscalYear?bucket.lastAccrualMonth:prevYearMonth(currentFYStartYM);
      }
      // The month eligibility actually started in only counts as half a month if that start
      // date falls on the 16th or later — applied once, on a first grant only, regardless of
      // how many total months are being caught up in this single call. Only meaningful when the
      // reference point IS that start date (started within this fiscal year); when it's been
      // clamped to the fiscal year boundary instead (a long-tenured employee's first sweep), the
      // discount has nothing real to attach to and must not apply.
      var discount=(isFirst&&startedThisFY)?halfMonthDiscount(startDate):0;
      var monthsToCredit=monthIndex(yearMonth)-monthIndex(referenceYM)-discount;
      if(monthsToCredit<=0)return false;
      var grantAmount=+(t.annualDays/12*monthsToCredit).toFixed(3);
      bucket.adjustments.unshift({id:Date.now()+Math.random(),date:tod,from:bucket.balance||0,to:+((bucket.balance||0)+grantAmount).toFixed(3),
        reason:(isFirst?'Initial monthly accrual — ':'Monthly accrual — ')+monthsToCredit+' month(s) through '+yearMonth,by:actor});
      bucket.balance=+((bucket.balance||0)+grantAmount).toFixed(3);
      bucket.lastAccrualMonth=yearMonth;
      if(isFirst)bucket.firstGrantDate=tod;
    }else if(!bucket.firstGrantDate){
      var startedThisYear=leaveFiscalYear(startDate)===fiscalYear;
      var monthsRemaining=leaveFiscalMonthsRemaining(startDate)-halfMonthDiscount(startDate);
      var initialGrant=(t.prorateFirstGrant&&startedThisYear)?+(t.annualDays*monthsRemaining/12).toFixed(3):t.annualDays;
      bucket.adjustments.unshift({id:Date.now()+Math.random(),date:tod,from:bucket.balance||0,to:initialGrant,
        reason:'Initial grant ('+(t.eligibilityBasis==='regularization'?'regularization':'hire')+' '+startDate+')'+(t.prorateFirstGrant&&startedThisYear?' — prorated':''),by:actor});
      bucket.balance=initialGrant;
      bucket.firstGrantDate=tod;
      bucket.lastAccrualYear=fiscalYear;
    }else{
      if(bucket.lastAccrualYear===fiscalYear)return false;
      var carry=t.carryOver?Math.min(bucket.balance||0,t.maxCarryOverDays||0):0;
      var forfeited=Math.max(0,(bucket.balance||0)-carry);
      bucket.yearlyClosingBalances[bucket.lastAccrualYear]=bucket.balance||0;
      bucket.adjustments.unshift({id:Date.now()+Math.random(),date:tod,from:bucket.balance||0,to:+(carry+t.annualDays).toFixed(3),
        reason:'Annual accrual '+fiscalYear+(carry?' (+'+carry+' carried over)':'')+(forfeited?' ('+forfeited+' forfeited)':''),by:actor});
      bucket.balance=+(carry+t.annualDays).toFixed(3);
      bucket.lastAccrualYear=fiscalYear;
    }
    emp.leaveBalances[t.id]=bucket;
    return true;
  }

  window.grantLeaveIfDue=grantLeaveIfDue; /* used by assignment actions in index.html so a newly-assigned type grants its balance immediately */

  // Sweeps every active employee x active leave type and grants whatever's due, silently (no
  // toast/render/queueSync of its own — callers decide whether and how to surface it). Used by
  // both the manual "Run Leave Accrual" button and the automatic per-login sweep.
  function sweepLeaveAccrual(employees){
    var tod=today(),credited=0;
    (employees||USERS.filter(function(e){return e.role==='employee'&&e.active!==false;})).forEach(function(emp){
      LEAVE_TYPES.forEach(function(t){if(grantLeaveIfDue(emp,t,tod))credited++;});
    });
    return credited;
  }

  window.runLeaveAccrual=function(){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    var credited=sweepLeaveAccrual();
    queueSync('Employees');
    toast('Leave accrual applied: '+credited+' balance(s) updated.','success');
    render();
  };

  // Runs automatically on every login (see checkOffboarding's caller in index.html) instead of
  // requiring an admin to remember to click "Run Leave Accrual" — answers "is there a trigger
  // once regularized": yes, the very next time anyone logs in. A plain employee only sweeps
  // their own record (self-service, no special permission needed); an admin sweeps every active
  // employee, so the whole company stays current as long as an admin logs in periodically.
  // Silent by design — no toast, since this fires unconditionally on every login.
  window.autoRunLeaveAccrual=function(){
    if(!user)return;
    var scope=(isAdminUser(user)||isPlatformAdmin)?undefined:[user];
    var credited=sweepLeaveAccrual(scope);
    if(credited>0)queueSync('Employees');
  };

  var LEAVE_MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
  window.saveLeaveFiscalYearStartMonth=function(v){
    if(!(isAdminUser(user)||isPlatformAdmin))return;
    COMPANY.leaveFiscalYearStartMonth=Number(v)||1;
    queueSync('Leave_Policy');
    toast('Leave policy year updated.','success');
    render();
  };
  function renderLeaveFiscalYearCard(){
    var fyStart=leaveFiscalYearStartMonth(),isCalendar=fyStart===1;
    return '<div class="card"><div class="card-hd"><div><div class="card-title">Leave Policy Year</div><div class="card-sub">'+
      (isCalendar?'Calendar year (Jan–Dec).':'Fiscal year: '+LEAVE_MONTH_NAMES[fyStart-1]+'–'+LEAVE_MONTH_NAMES[(fyStart+10)%12]+'. Current policy year is labeled '+leaveFiscalYear(today())+'.')+
      ' Controls when annual accrual, carry-over/forfeiture, and first-grant proration reset.</div></div>'+
      '<div class="field" style="margin:0;width:220px"><label>Policy year starts in</label><select class="finput" onchange="saveLeaveFiscalYearStartMonth(this.value)">'+
      LEAVE_MONTH_NAMES.map(function(m,i){return '<option value="'+(i+1)+'" '+(fyStart===i+1?'selected':'')+'>'+m+'</option>';}).join('')+
      '</select></div></div>';
  }
  function renderLeavePolicyManager(){
    return renderLeaveFiscalYearCard()+
      '<div class="card" style="margin-top:1rem"><div class="card-hd"><div><div class="card-title">Leave Policy</div><div class="card-sub">Define leave types, entitlement, accrual, and eligibility — used for balance tracking and the File Leave form. Accrual also runs automatically whenever anyone logs in, so this button is only needed to force an immediate update.</div></div><div class="action-row"><button class="btn btn-sm" onclick="openBulkLeaveBalance()">📋 Bulk Import Balances</button><button class="btn btn-sm" onclick="if(confirm(\'Grant leave accrual to every eligible active employee right now? Upfront types are credited once per policy year, monthly types once per month — already-credited employees for this period are skipped.\'))runLeaveAccrual()">Run Leave Accrual</button><button class="btn btn-primary btn-sm" onclick="openLeaveTypeEditor()">+ Add Leave Type</button></div></div>'+
      '<div style="overflow-x:auto"><table><thead><tr><th>Type</th><th>Paid</th><th>Annual Days</th><th>Accrual</th><th>Carry-over</th><th>Eligibility</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+
      (LEAVE_TYPES.length?LEAVE_TYPES.map(function(t){
        return '<tr><td style="font-weight:700">'+esc(t.name)+' <span class="badge" style="font-size:10px">'+esc(t.code)+'</span></td>'+
          '<td>'+(t.paid?'Paid':'Unpaid')+'</td><td style="text-align:center">'+t.annualDays+'</td>'+
          '<td style="font-size:12px">'+LEAVE_ACCRUAL_LABELS[t.accrualMethod]+'</td>'+
          '<td style="font-size:12px">'+(t.carryOver?'Up to '+t.maxCarryOverDays+' days':'No carry-over')+'</td>'+
          '<td style="font-size:11px;color:'+(t.requiresAssignment?'var(--amber-txt)':'var(--txt3)')+'">'+esc(describeLeaveEligibility(t))+'</td>'+
          '<td><span class="badge '+(t.active?'b-approved':'b-rejected')+'">'+(t.active?'Active':'Inactive')+'</span></td>'+
          '<td><div class="action-row"><button class="btn btn-sm" onclick="openLeaveTypeEditor('+t.id+')">Edit</button>'+(t.requiresAssignment?'<button class="btn btn-sm btn-primary" onclick="assignLeaveTypeToAll('+t.id+')">Assign to All</button>':'')+'<button class="btn btn-sm" onclick="unassignLeaveTypeFromAll('+t.id+')">Unassign from All</button><button class="btn btn-sm" onclick="toggleLeaveType('+t.id+')">'+(t.active?'Deactivate':'Activate')+'</button><button class="btn btn-sm btn-danger" onclick="deleteLeaveType('+t.id+')">Delete</button></div></td></tr>';
      }).join(''):'<tr><td colspan="8" style="text-align:center;color:var(--txt3);padding:2rem">No leave types configured yet.</td></tr>')+
      '</tbody></table></div></div>';
  }

  var ATTENDANCE_FORM_CONFIG = [
    {key:'time_correction',label:'Time In / Time Out Correction',short:'TC',description:'File multiple missing or incorrect punches in one batch.',kind:'punch',visible:true,core:true},
    {key:'schedule_adjustment',label:'Schedule Adjustment',short:'SA',description:'Request a temporary change to the assigned shift schedule.',kind:'schedule',visible:true},
    {key:'overtime',label:'Overtime Request',short:'OT',description:'Request an OT interval; payable hours are capped by actual logs.',kind:'interval',visible:true},
    {key:'official_business',label:'Official Business / Field Work',short:'OB',description:'Enter the OB Time In and Time Out; approval automatically tags attendance as Present.',kind:'ob',visible:true},
    {key:'work_from_home',label:'Work From Home',short:'WFH',description:'Request remote work; completed actual Time In and Time Out logs are still required.',kind:'wfh',visible:true},
    {key:'rest_day_holiday',label:'Rest Day / Holiday Overtime',short:'RD',description:'Claim overtime pay for hours worked beyond 8 on a rest day or holiday — checked against your schedule and actual time logs.',kind:'rdh_ot',visible:true},
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
    queueSync('Attendance_Form_Config');
  }

  window.toggleAttendanceForm=function(key){
    if(!(isAdminUser(user)||isPlatformAdmin)){toast('Only administrators can change form visibility.','warning');return;}
    var form=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===key;});
    if(!form)return;
    form.visible=!form.visible;
    saveAttendanceFormConfig();
    toast(form.label+' is now '+(form.visible?'visible':'hidden')+' to employees.','success');
    render();
  };

  window.setAttendanceFormVisibility=function(visible){
    if(!(isAdminUser(user)||isPlatformAdmin)){toast('Only administrators can change form visibility.','warning');return;}
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

  function minutesFromTime(value){
    var parts=(value||'').split(':');
    return parts.length===2?(parseInt(parts[0],10)*60+parseInt(parts[1],10)):null;
  }

  function actualLogForDate(employeeId,date){
    var log=TimekeepingCore.consolidate(ATT,employeeId,date);
    return log&&log.tin&&log.tout&&log.approvalStatus!=='rejected'?log:null;
  }

  function requestDates(start,end){
    var dates=[],cursor=new Date((start||today())+'T00:00:00Z'),last=new Date((end||start||today())+'T00:00:00Z');
    if(last<cursor)last=new Date(cursor);
    while(cursor<=last&&dates.length<366){dates.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1);}
    return dates;
  }

  function calculateEligibleHours(employeeId,date,requestedStart,requestedEnd){
    var log=actualLogForDate(employeeId,date);
    var reqStart=minutesFromTime(requestedStart),reqEnd=minutesFromTime(requestedEnd);
    if(!log||reqStart===null||reqEnd===null)return {hours:0,minutes:0,log:log};
    var actualStart=minutesFromTime(log.tin),actualEnd=minutesFromTime(log.tout);
    if(actualStart===null||actualEnd===null)return {hours:0,minutes:0,log:log};
    if(reqEnd<=reqStart)reqEnd+=1440;
    if(actualEnd<=actualStart)actualEnd+=1440;
    var eligible=Math.max(0,Math.min(reqEnd,actualEnd)-Math.max(reqStart,actualStart));
    return {hours:Math.round(eligible/60*100)/100,minutes:eligible,log:log};
  }

  var RDH_BREAK_MINUTES=60,RDH_REGULAR_MINUTES=480; // 1-hour unpaid break, 8 regular hours
  function minutesToTimeStr(mins){
    mins=((Math.round(mins)%1440)+1440)%1440;
    var h=Math.floor(mins/60),m=mins%60;
    return (h<10?'0':'')+h+':'+(m<10?'0':'')+m;
  }
  // Rest Day/Holiday Overtime: the employee still types the OT interval they're claiming
  // (like Overtime does), but this validates it against the classification (Rest Day/Holiday),
  // the actual completed time log for that date, and a fixed 1-hour break — only the portion of
  // the requested interval that falls after 8 worked hours + the break, AND actually overlaps the
  // real logged Time In/Out, is ever eligible. Passing reqStart/reqEnd as null (before the
  // employee has typed anything) returns eligibility info without evaluating a specific claim.
  // Shared between the live preview and the submit/approval-time checks so they can never disagree.
  function rdhEligibility(employee,date,type,reqStart,reqEnd){
    if(!date)return {ok:false,html:'Select a request date.'};
    if(!type)return {ok:false,html:'Select whether this is a <strong>Rest Day</strong>, <strong>Holiday</strong>, or <strong>Rest Day on a Holiday</strong> claim.'};
    var isRest=TimekeepingCore.isRestDay(employee,date,SHIFT_DEFINITIONS);
    var holiday=HOLIDAYS.find(function(h){return h.date===date;});
    if(type==='rest_day'&&!isRest){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ This date isn\'t tagged as your Rest Day.</strong><br>Please check your attendance and file a Schedule Adjustment first if your schedule needs correcting.'};
    }
    if(type==='holiday'&&!holiday){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ This date isn\'t configured as a holiday.</strong><br>Please contact your System Administrator.'};
    }
    if(type==='both'){
      var bothMissing=[];
      if(!isRest)bothMissing.push('your Rest Day');
      if(!holiday)bothMissing.push('a configured Holiday');
      if(bothMissing.length){
        return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ This date isn\'t '+bothMissing.join(' or ')+'.</strong><br>'+(!isRest?'Check your attendance/Schedule Adjustment for the Rest Day side. ':'')+(!holiday?'Contact your System Administrator for the Holiday side.':'')};
      }
    }
    var log=actualLogForDate(employee.id,date);
    if(!log){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ No completed attendance log found for this date yet.</strong><br>File this request once your Time In and Time Out for that day are recorded.'};
    }
    var tinM=minutesFromTime(log.tin),toutM=minutesFromTime(log.tout);
    // tinM===toutM (not just null) is the actual signature of an in-progress punch that never
    // got a real Time Out recorded — treating that as a same-time-next-day overnight shift is
    // exactly the bug that produced a bogus "24 hrs worked" claim from a Time-In-only log.
    if(tinM===null||toutM===null||tinM===toutM){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ Your attendance log for this date isn\'t complete yet.</strong><br>Make sure both a valid Time In and Time Out are recorded before filing this claim.'};
    }
    if(toutM<=tinM)toutM+=1440;
    var rawMinutes=toutM-tinM;
    var workedMinutes=Math.max(0,rawMinutes-RDH_BREAK_MINUTES);
    var otWindowStart=tinM+RDH_REGULAR_MINUTES+RDH_BREAK_MINUTES; // 8 worked hrs + 1-hr break, elapsed from Time In
    var label=type==='holiday'?(HOLIDAY_TYPE_LABELS[holiday.type]||'Holiday')+' — '+esc(holiday.name):
      type==='both'?'Rest Day + '+(HOLIDAY_TYPE_LABELS[holiday.type]||'Holiday')+' — '+esc(holiday.name):
      'Rest Day';
    var logSummary='Logged: '+esc(log.tin)+' – '+esc(log.tout)+' ('+(workedMinutes/60).toFixed(2)+' hrs worked, net of a 1-hr break)';
    if(workedMinutes<=RDH_REGULAR_MINUTES){
      return {ok:false,html:'<strong>'+label+'</strong> confirmed for this date, but '+logSummary.toLowerCase()+" don't exceed 8 — there's no overtime to claim on this form."};
    }
    if(!reqStart||!reqEnd){
      var maxOt=Math.round((workedMinutes-RDH_REGULAR_MINUTES)/60*100)/100;
      return {ok:false,html:'<strong style="color:var(--green)">✓ '+label+'</strong><br>'+logSummary+'<br>Enter your OT Start and End Time — it must start on or after <strong>'+minutesToTimeStr(otWindowStart)+'</strong> (8 hrs + 1-hr break from your Time In). Up to <strong>'+maxOt.toFixed(2)+' hrs</strong> available to claim.'};
    }
    var reqStartM=minutesFromTime(reqStart),reqEndM=minutesFromTime(reqEnd);
    if(reqStartM===null||reqEndM===null)return {ok:false,html:'Enter both a valid Requested Start Time and End Time.'};
    if(reqEndM<=reqStartM)reqEndM+=1440;
    if(reqStartM<otWindowStart){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ Your OT Start Time must be on or after '+minutesToTimeStr(otWindowStart)+'.</strong><br>That\'s 8 regular hours plus a 1-hour break from your actual Time In ('+esc(log.tin)+').'};
    }
    var overlapStart=Math.max(reqStartM,otWindowStart),overlapEnd=Math.min(reqEndM,toutM);
    var otMinutes=Math.max(0,overlapEnd-overlapStart);
    var otHours=Math.round(otMinutes/60*100)/100;
    if(otHours<=0){
      return {ok:false,html:'The requested interval doesn\'t overlap with logged overtime hours (after '+minutesToTimeStr(otWindowStart)+', up to your actual Time Out '+esc(log.tout)+').'};
    }
    return {ok:true,hours:otHours,html:'<strong style="color:var(--green)">✓ '+label+'</strong><br>'+logSummary+'<br>Eligible Rest Day/Holiday overtime: <strong>'+otHours.toFixed(2)+' hrs</strong> (capped by your actual Time Out).'};
  }
  window.previewRdhEligibility=function(){
    var box=document.getElementById('att-rdh-info');if(!box)return;
    var value=function(id){return ((document.getElementById(id)||{}).value||'').trim();};
    var check=rdhEligibility(user,value('att-form-date'),value('att-form-rdh-type'),value('att-form-in')||null,value('att-form-out')||null);
    box.innerHTML=check.html;
    box.style.borderColor=check.ok?'var(--green)':'var(--amber)';
    updateAttSubmitButton();
  };

  // Regular Overtime (kind:'interval') claims time worked outside the assigned shift on an
  // otherwise-normal workday — Before Shift (early login) or After Shift (stayed late). Rest
  // day/holiday work has its own dedicated form with its own premium rules, so this one requires
  // an actual scheduled shift to measure "before"/"after" against.
  function otTypeEligibility(employee,date,type,reqStart,reqEnd){
    if(!date)return {ok:false,html:'Select a request date.'};
    if(!type)return {ok:false,html:'Select whether this is <strong>Before Shift</strong> or <strong>After Shift</strong> overtime.'};
    var sched=TimekeepingCore.scheduleForDate(employee,date,SHIFT_DEFINITIONS);
    if(!sched){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ No regular shift is scheduled for this date.</strong><br>If you worked a rest day or holiday, file that through Rest Day/Holiday Overtime instead.'};
    }
    var shiftStartM=minutesFromTime(sched.start),shiftEndM=minutesFromTime(sched.end);
    var label=type==='before'?'Before Shift':'After Shift';
    var boundaryText=type==='before'?('on or before your shift start ('+esc(sched.start)+')'):('on or after your shift end ('+esc(sched.end)+')');
    var schedSummary='Scheduled shift: <strong>'+esc(sched.start)+' – '+esc(sched.end)+'</strong>';
    if(!reqStart||!reqEnd){
      return {ok:false,html:'<strong>'+label+' Overtime</strong><br>'+schedSummary+'<br>Enter your OT Start and End Time — both must fall '+boundaryText+'.'};
    }
    var reqStartM=minutesFromTime(reqStart),reqEndM=minutesFromTime(reqEnd);
    if(reqStartM===null||reqEndM===null)return {ok:false,html:'Enter both a valid Requested Start Time and End Time.'};
    var reqEndAdj=reqEndM<=reqStartM?reqEndM+1440:reqEndM;
    if(type==='before'&&reqEndAdj>shiftStartM){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ Before Shift OT must end on or before your shift start ('+esc(sched.start)+').</strong>'};
    }
    if(type==='after'&&reqStartM<shiftEndM){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ After Shift OT must start on or after your shift end ('+esc(sched.end)+').</strong>'};
    }
    var eligible=calculateEligibleHours(employee.id,date,reqStart,reqEnd);
    if(!eligible.log){
      return {ok:false,html:'<strong style="color:var(--amber-txt)">⚠ No completed attendance log found for this date yet.</strong><br>File this request once your Time In and Time Out for that day are recorded.'};
    }
    if(eligible.hours<=0){
      return {ok:false,html:'The requested interval doesn\'t overlap with your actual logged hours ('+esc(eligible.log.tin)+' – '+esc(eligible.log.tout)+').'};
    }
    return {ok:true,hours:eligible.hours,html:'<strong style="color:var(--green)">✓ '+label+' Overtime</strong><br>'+schedSummary+'<br>Actual log: '+esc(eligible.log.tin)+' – '+esc(eligible.log.tout)+'<br>Eligible overtime: <strong>'+eligible.hours.toFixed(2)+' hrs</strong> (capped by your actual log).'};
  }
  window.previewOtEligibility=function(){
    var box=document.getElementById('att-ot-info');if(!box)return;
    var value=function(id){return ((document.getElementById(id)||{}).value||'').trim();};
    var check=otTypeEligibility(user,value('att-form-date'),value('att-form-ot-type'),value('att-form-in')||null,value('att-form-out')||null);
    box.innerHTML=check.html;
    box.style.borderColor=check.ok?'var(--green)':'var(--amber)';
    updateAttSubmitButton();
  };

  // The realtime ZK biometric poll (see index.html's zkPullAttendance, every 20s) calls render()
  // unconditionally whenever no input/textarea/select currently has focus — which still leaves a
  // real gap: a field the user already filled in but isn't actively focused on RIGHT NOW (e.g.
  // they just tabbed away, or paused to think) gets silently reset to blank on the next
  // background render, because none of these fields' values were ever stored anywhere except the
  // DOM itself. Mirrors the same fix already applied to Add Employee/File Leave for the same bug
  // class: every field syncs its value into this draft on each keystroke, and the HTML this form
  // renders always reads its value FROM here — so a render triggered by anything other than this
  // form's own actions reconstructs the exact same values instead of wiping them.
  window.attFormSync=function(id){
    var el=document.getElementById(id);
    if(el)(window._attFormDraft=window._attFormDraft||{})[id]=el.value;
  };
  function attFieldVal(id,fallback){
    var draft=window._attFormDraft;
    return (draft&&draft[id]!=null)?draft[id]:fallback;
  }

  // Single source of truth for whether the current Attendance Forms draft is complete enough to
  // submit — mirrors the exact same checks submitAttendanceFormRequest() runs before filing, just
  // returning a boolean instead of toasting, so the Submit button can be grayed out live instead
  // of letting someone click it and get bounced by a warning toast.
  function attendanceFormValid(form){
    var reason=attFieldVal('att-form-reason','').trim();
    if(!reason)return false;
    if(form.kind==='punch'){
      var corrections=window._correctionRows||[];
      return corrections.length>0&&corrections.every(function(r){return r.date&&r.punchType&&r.correctedTime;});
    }
    if(form.kind==='schedule'){
      var schedRows=window._scheduleAdjRows||[];
      if(!schedRows.length)return false;
      return !schedRows.some(function(r){return !r.isRestDay&&(!r.start||!r.end);});
    }
    if(form.kind==='rdh_ot'){
      var rdhReqStart=attFieldVal('att-form-in',''),rdhReqEnd=attFieldVal('att-form-out','');
      if(!rdhReqStart||!rdhReqEnd)return false;
      return rdhEligibility(user,attFieldVal('att-form-date',''),attFieldVal('att-form-rdh-type',''),rdhReqStart,rdhReqEnd).ok;
    }
    if(form.kind==='interval'){
      var otReqStart=attFieldVal('att-form-in',''),otReqEnd=attFieldVal('att-form-out','');
      if(!otReqStart||!otReqEnd)return false;
      return otTypeEligibility(user,attFieldVal('att-form-date',''),attFieldVal('att-form-ot-type',''),otReqStart,otReqEnd).ok;
    }
    var date=attFieldVal('att-form-date','');
    if(!date)return false;
    var tin=attFieldVal('att-form-in',''),tout=attFieldVal('att-form-out','');
    if(form.kind==='ob'&&(!tin||!tout))return false;
    if(form.kind==='minutes'&&Number(attFieldVal('att-form-minutes',''))<=0)return false;
    var endDate=attFieldVal('att-form-end','');
    if(endDate&&endDate<date)return false;
    return true;
  }

  // Called on every field edit that doesn't already trigger a full render() (most fields do, via
  // attFormSync's callers) so the Submit button's disabled state stays live without needing to
  // re-render the whole form and risk losing focus mid-edit.
  window.updateAttSubmitButton=function(){
    var form=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===window._attendanceFormKey&&f.visible;});
    var btn=document.getElementById('att-submit-btn');
    if(!btn||!form)return;
    var ok=attendanceFormValid(form);
    btn.disabled=!ok;
    btn.title=ok?'':'Complete the required fields above before submitting.';
  };

  window.openAttendanceForm=function(key){
    var form=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===key&&f.visible;});
    if(!form){toast('This attendance form is not currently available.','warning');return;}
    window._attFormDraft={};
    if(key==='time_correction')window._correctionRows=[{date:'',punchType:'',correctedTime:''}];
    if(key==='schedule_adjustment'){window._scheduleAdjRows=null;window._scheduleAdjFrom=null;window._scheduleAdjTo=null;window._scheduleAdjShiftEndTouched=false;}
    window._attendanceFormKey=key;
    tab=(isAdminUser(user)||isPlatformAdmin)?3:1; /* "Attendance Forms" sits at index 3 in the admin tab layout, index 1 otherwise */
    render();
  };

  window.addCorrectionRow=function(){
    if(!window._correctionRows)window._correctionRows=[];
    window._correctionRows.push({date:'',punchType:'',correctedTime:''});render();
  };
  window.removeCorrectionRow=function(index){
    if(!window._correctionRows||window._correctionRows.length<=1){toast('At least one correction row is required.','warning');return;}
    window._correctionRows.splice(index,1);render();
  };
  window.updateCorrectionRow=function(index,key,value){
    if(window._correctionRows&&window._correctionRows[index])window._correctionRows[index][key]=value;
  };

  function correctionRowsFields(){
    var rows=window._correctionRows||[{date:'',punchType:'',correctedTime:''}];
    window._correctionRows=rows;
    return '<div class="card-sub" style="margin-bottom:8px">Add as many Time In or Time Out corrections as needed. Each row becomes a separate approval item.</div>'+
      '<div style="display:grid;gap:8px">'+rows.map(function(row,i){return '<div class="correction-row"><div class="field"><label>Date</label><input type="date" value="'+esc(row.date)+'" onchange="updateCorrectionRow('+i+',\'date\',this.value);updateAttSubmitButton()"></div>'+
        '<div class="field"><label>Punch</label><select onchange="updateCorrectionRow('+i+',\'punchType\',this.value);updateAttSubmitButton()"><option value="" '+(row.punchType?'':'selected')+'>Select…</option><option value="time_in" '+(row.punchType==='time_in'?'selected':'')+'>Time In</option><option value="time_out" '+(row.punchType==='time_out'?'selected':'')+'>Time Out</option></select></div>'+
        '<div class="field"><label>Correct Time</label><input type="time" value="'+esc(row.correctedTime)+'" onchange="updateCorrectionRow('+i+',\'correctedTime\',this.value);updateAttSubmitButton()"></div>'+
        '<button class="btn btn-sm btn-danger" style="align-self:end;margin-bottom:10px" onclick="removeCorrectionRow('+i+')">Remove</button></div>';}).join('')+'</div>'+
      '<button class="btn btn-sm" type="button" onclick="addCorrectionRow()">+ Add another correction</button>';
  }

  function assignedShiftText(shiftId){
    var s=SHIFT_DEFINITIONS.find(function(x){return x.id===shiftId;});
    return s?s.name+' · '+describeShiftPattern(s):'No shift assigned';
  }

  function attendanceFormFields(form){
    var punchFields=(form.kind==='punch')?correctionRowsFields():'';
    var otTypeVal=attFieldVal('att-form-ot-type','');
    var intervalFields=(form.kind==='interval')?
      '<div class="field"><label>Type</label><select id="att-form-ot-type" onchange="attFormSync(\'att-form-ot-type\');previewOtEligibility()"><option value="" '+(otTypeVal===''?'selected':'')+'>Select…</option><option value="before" '+(otTypeVal==='before'?'selected':'')+'>Before Shift</option><option value="after" '+(otTypeVal==='after'?'selected':'')+'>After Shift</option></select></div>'+
      '<div class="form-row"><div class="field"><label>Requested Start Time</label><input type="time" id="att-form-in" value="'+esc(attFieldVal('att-form-in',''))+'" oninput="attFormSync(\'att-form-in\');previewOtEligibility()"></div><div class="field"><label>Requested End Time</label><input type="time" id="att-form-out" value="'+esc(attFieldVal('att-form-out',''))+'" oninput="attFormSync(\'att-form-out\');previewOtEligibility()"></div></div>'+
      '<div id="att-ot-info" style="padding:10px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;color:var(--txt2);font-size:12px;line-height:1.5;margin-bottom:12px">Select a Type above to check eligibility for this date.</div>'
      :'';
    var rdhTypeVal=attFieldVal('att-form-rdh-type','');
    var rdhFields=(form.kind==='rdh_ot')?
      '<div class="field"><label>Type</label><select id="att-form-rdh-type" onchange="attFormSync(\'att-form-rdh-type\');previewRdhEligibility()"><option value="" '+(rdhTypeVal===''?'selected':'')+'>Select…</option><option value="rest_day" '+(rdhTypeVal==='rest_day'?'selected':'')+'>Rest Day</option><option value="holiday" '+(rdhTypeVal==='holiday'?'selected':'')+'>Holiday</option><option value="both" '+(rdhTypeVal==='both'?'selected':'')+'>Rest Day on a Holiday</option></select></div>'+
      '<div class="form-row"><div class="field"><label>Requested Start Time</label><input type="time" id="att-form-in" value="'+esc(attFieldVal('att-form-in',''))+'" oninput="attFormSync(\'att-form-in\');previewRdhEligibility()"></div><div class="field"><label>Requested End Time</label><input type="time" id="att-form-out" value="'+esc(attFieldVal('att-form-out',''))+'" oninput="attFormSync(\'att-form-out\');previewRdhEligibility()"></div></div>'+
      '<div id="att-rdh-info" style="padding:10px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;color:var(--txt2);font-size:12px;line-height:1.5;margin-bottom:12px">Select a Type above to check eligibility for this date.</div>'
      :'';
    var minuteFields=(form.kind==='minutes')?'<div class="field"><label>Undertime Minutes</label><input type="number" id="att-form-minutes" min="1" max="480" step="1" placeholder="e.g. 30" value="'+esc(attFieldVal('att-form-minutes',''))+'" oninput="attFormSync(\'att-form-minutes\');updateAttSubmitButton()"></div>':'';
    var isRange=(form.kind==='range'||form.kind==='ob'||form.kind==='wfh');
    var rangeFields=isRange?'<div class="field"><label>Work Location</label><input id="att-form-location" value="'+esc(attFieldVal('att-form-location',''))+'" placeholder="Client site, home, or field location" oninput="attFormSync(\'att-form-location\')"></div>':'';
    var obFields=(form.kind==='ob')?'<div class="form-row"><div class="field"><label>OB Time In</label><input type="time" id="att-form-in" value="'+esc(attFieldVal('att-form-in',''))+'" oninput="attFormSync(\'att-form-in\');updateAttSubmitButton()"></div><div class="field"><label>OB Time Out</label><input type="time" id="att-form-out" value="'+esc(attFieldVal('att-form-out',''))+'" oninput="attFormSync(\'att-form-out\');updateAttSubmitButton()"></div></div><div style="padding:9px 12px;background:var(--accent-bg);border-radius:8px;color:var(--accent-txt);font-size:12px;margin-bottom:12px">Once approved, these OB times will create or update a Present attendance record for every covered date.</div>':'';
    var wfhNotice=(form.kind==='wfh')?'<div style="padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--txt2);font-size:12px;margin-bottom:12px"><strong>Bundy is still required.</strong> You must have completed actual Time In and Time Out logs for every covered WFH date before HR can approve this request.</div>':'';
    var scheduleFields=(form.kind==='schedule')?renderScheduleAdjBuilder():'';
    var header=(form.kind==='punch'||form.kind==='schedule')?'':
      isRange?'<div class="form-row"><div class="field"><label>From</label><input type="date" id="att-form-date" value="'+esc(attFieldVal('att-form-date',''))+'" oninput="attFormSync(\'att-form-date\');updateAttSubmitButton()"></div><div class="field"><label>To</label><input type="date" id="att-form-end" value="'+esc(attFieldVal('att-form-end',''))+'" oninput="attFormSync(\'att-form-end\');updateAttSubmitButton()"></div></div>':
      '<div class="field"><label>Request Date</label><input type="date" id="att-form-date" value="'+esc(attFieldVal('att-form-date',''))+'" oninput="attFormSync(\'att-form-date\');'+(form.kind==='interval'?'previewOtEligibility()':form.kind==='rdh_ot'?'previewRdhEligibility()':'updateAttSubmitButton()')+'"></div>';
    return header+rangeFields+punchFields+intervalFields+rdhFields+obFields+wfhNotice+scheduleFields+minuteFields+
      '<div class="field"><label>Reason and supporting details</label><textarea id="att-form-reason" oninput="attFormSync(\'att-form-reason\');updateAttSubmitButton()" rows="4" placeholder="Explain the request and include the expected correction or approval.">'+esc(attFieldVal('att-form-reason',''))+'</textarea></div>';
  }

  // Schedule Adjustment: an "Effectivity Date" range plus a master Shift Start/Break Start/
  // Break End/Shift End, used to generate one editable row per calendar date via Generate
  // Dates. Each row can be independently retimed, marked a rest day (locking its time inputs),
  // marked no-break, copied to every other non-rest-day row ("fill down" — the fast path for a
  // schedule that repeats Mon-Fri), or dropped entirely. Regenerating after edits preserves any
  // date already in the table and only adds/removes what the new range actually changed.
  function renderScheduleAdjBuilder(){
    var rows=window._scheduleAdjRows||[];
    // Shift Start/End are left blank rather than pre-filled from the assigned shift — the info
    // box below already shows the current assignment for reference. Once the admin types a Shift
    // Start, scheduleAdjAutoBreak() fills in Break Start/End and Shift End automatically.
    return '<div style="padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12px;margin-bottom:12px">Current assigned shift: <strong>'+esc(assignedShiftText(user.shiftId))+'</strong></div>'+
      '<div class="form-row"><div class="field"><label>Effectivity From</label><input type="date" id="satt-from" value="'+esc(attFieldVal('satt-from',''))+'" oninput="attFormSync(\'satt-from\')"></div><div class="field"><label>Effectivity To</label><input type="date" id="satt-to" value="'+esc(attFieldVal('satt-to',''))+'" oninput="attFormSync(\'satt-to\')"></div></div>'+
      '<div class="form-row"><div class="field"><label>Shift Start</label><input type="time" id="satt-shift-start" value="'+esc(attFieldVal('satt-shift-start',''))+'" oninput="attFormSync(\'satt-shift-start\')" onchange="scheduleAdjAutoBreak()"></div><div class="field"><label>Break Start</label><input type="time" id="satt-break-start" value="'+esc(attFieldVal('satt-break-start',''))+'" oninput="attFormSync(\'satt-break-start\')"></div><div class="field"><label>Break End</label><input type="time" id="satt-break-end" value="'+esc(attFieldVal('satt-break-end',''))+'" oninput="attFormSync(\'satt-break-end\')"></div><div class="field"><label>Shift End</label><input type="time" id="satt-shift-end" value="'+esc(attFieldVal('satt-shift-end',''))+'" oninput="attFormSync(\'satt-shift-end\');window._scheduleAdjShiftEndTouched=true"></div></div>'+
      '<div style="margin-bottom:14px"><button type="button" class="btn btn-sm btn-primary" onclick="scheduleAdjGenerateDates()">Generate Dates</button></div>'+
      (rows.length?renderScheduleAdjTable(rows):'<div style="padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--txt3);margin-bottom:12px">Set an effectivity range above and click Generate Dates to build the day-by-day schedule.</div>');
  }
  var SCHED_ADJ_DOW=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function renderScheduleAdjTable(rows){
    return '<div style="overflow-x:auto"><table><thead><tr><th>Day</th><th>Date</th><th>Holiday</th><th>Shift Start</th><th>Break Start</th><th>Break End</th><th>Shift End</th><th>Rest Day</th><th></th></tr></thead><tbody>'+
      rows.map(function(r){
        var timeDisabled=r.isRestDay?'disabled':'';
        // No separate "No Break" toggle — an empty Break Start/End on a working day IS "no
        // break" (one way to say it instead of two that could disagree with each other).
        var holidayBadge=r.holiday?'<span class="badge b-info" title="'+esc(HOLIDAY_TYPE_LABELS[r.holiday.type]||r.holiday.type)+'">'+esc(r.holiday.name)+'</span>':'—';
        return '<tr'+(r.isRestDay?' style="opacity:.65"':'')+'>'+
          '<td>'+r.dow+'</td><td class="mono">'+r.date+'</td>'+
          '<td style="font-size:11px">'+holidayBadge+'</td>'+
          '<td><input type="time" '+timeDisabled+' value="'+(r.isRestDay?'':(r.start||''))+'" onblur="scheduleAdjUpdateRow(\''+r.date+'\',\'start\',this.value)"></td>'+
          '<td><input type="time" '+timeDisabled+' value="'+(r.isRestDay?'':(r.breakStart||''))+'" onblur="scheduleAdjUpdateRow(\''+r.date+'\',\'breakStart\',this.value)"></td>'+
          '<td><input type="time" '+timeDisabled+' value="'+(r.isRestDay?'':(r.breakEnd||''))+'" onblur="scheduleAdjUpdateRow(\''+r.date+'\',\'breakEnd\',this.value)"></td>'+
          '<td><input type="time" '+timeDisabled+' value="'+(r.isRestDay?'':(r.end||''))+'" onblur="scheduleAdjUpdateRow(\''+r.date+'\',\'end\',this.value)"></td>'+
          '<td style="text-align:center"><input type="checkbox" style="width:auto;accent-color:var(--accent)" '+(r.isRestDay?'checked':'')+' onchange="scheduleAdjToggleRestDay(\''+r.date+'\')" title="No expected work hours this date"></td>'+
          '<td style="white-space:nowrap"><button type="button" class="btn btn-sm" onclick="scheduleAdjCopyRow(\''+r.date+'\')" title="Copy this schedule to every other non-rest-day row">⧉</button> <button type="button" class="btn btn-sm btn-danger" onclick="scheduleAdjDeleteRow(\''+r.date+'\')" title="Remove this date from the request">🗑</button></td>'+
        '</tr>';
      }).join('')+'</tbody></table></div>';
  }
  // Auto-suggests Break Start/End (3 hours after Shift Start, a 1-hour break) and Shift End (9
  // hours after Shift Start — 8 worked hours plus that same 1-hour break) the moment Shift Start
  // is entered — still fully editable. Break Start/End only fill in while both are blank. Shift
  // End always starts with a sensible default (so it can't be "blank" to key off of) and instead
  // tracks a "touched" flag: it keeps following Shift Start until the admin edits it directly.
  window.scheduleAdjAutoBreak=function(){
    var startEl=document.getElementById('satt-shift-start'),breakStartEl=document.getElementById('satt-break-start'),breakEndEl=document.getElementById('satt-break-end'),endEl=document.getElementById('satt-shift-end');
    if(!startEl)return;
    var startM=minutesFromTime(startEl.value);
    if(startM==null)return;
    if(breakStartEl&&breakEndEl&&!breakStartEl.value&&!breakEndEl.value){
      breakStartEl.value=minutesToTimeStr(startM+180);
      breakEndEl.value=minutesToTimeStr(startM+240);
      attFormSync('satt-break-start');attFormSync('satt-break-end');
    }
    if(endEl&&!window._scheduleAdjShiftEndTouched){
      endEl.value=minutesToTimeStr(startM+540);
      attFormSync('satt-shift-end');
    }
  };
  window.scheduleAdjGenerateDates=function(){
    var value=function(id){return ((document.getElementById(id)||{}).value||'').trim();};
    var from=value('satt-from'),to=value('satt-to');
    if(!from||!to){toast('Set both an effectivity From and To date.','warning');return;}
    if(to<from){toast('Effectivity To must be on or after From.','warning');return;}
    if(requestDates(from,to).length>62){toast('Keep the effectivity range to 62 days or fewer.','warning');return;}
    window._scheduleAdjFrom=from;window._scheduleAdjTo=to;
    var masterStart=value('satt-shift-start'),masterBreakStart=value('satt-break-start'),masterBreakEnd=value('satt-break-end'),masterEnd=value('satt-shift-end');
    var existingByDate={};
    (window._scheduleAdjRows||[]).forEach(function(r){existingByDate[r.date]=r;});
    // Re-clicking Generate Dates re-applies whatever the master Shift Start/Break Start/Break
    // End/Shift End fields say RIGHT NOW to every non-rest-day row — editing those fields and
    // clicking Generate Dates again is how you're meant to retime the whole table at once, so
    // silently keeping stale per-row values here (as an earlier version of this did) just makes
    // the button look broken. The one thing carried over from an existing row is its Rest Day
    // flag, since that's a deliberate per-date override the user made, not part of the template.
    window._scheduleAdjRows=requestDates(from,to).map(function(date){
      var existing=existingByDate[date];
      var holiday=HOLIDAYS.find(function(h){return h.date===date;})||null;
      // A date locks like a Rest Day if it's explicitly one on the assigned shift's weekly
      // pattern, if there's simply no shift configured for that date at all, OR if it's a
      // holiday — no regular shift schedule needs to be plotted for a holiday; if the employee
      // actually works it, that's claimed through Rest Day/Holiday Overtime, not pre-planned
      // here. Carried over from an existing row once generated, same as a manual Rest Day
      // toggle, so unchecking it to force a plotted schedule on a worked holiday sticks across
      // re-clicking Generate Dates.
      var isRest=existing?existing.isRestDay:(TimekeepingCore.isRestDay(user,date,SHIFT_DEFINITIONS)||!TimekeepingCore.scheduleForDate(user,date,SHIFT_DEFINITIONS)||!!holiday);
      return {date:date,dow:SCHED_ADJ_DOW[new Date(date+'T00:00:00Z').getUTCDay()],
        start:isRest?'':masterStart,end:isRest?'':masterEnd,
        breakStart:isRest?'':masterBreakStart,breakEnd:isRest?'':masterBreakEnd,
        isRestDay:isRest,holiday:holiday};
    });
    var holidayCount=window._scheduleAdjRows.filter(function(r){return r.holiday;}).length;
    toast('Schedule generated from the Shift Start/Break/Shift End fields above.'+(holidayCount?' '+holidayCount+' holiday(s) flagged in this range.':''),'success');
    render();
  };
  window.scheduleAdjUpdateRow=function(date,key,val){
    var row=(window._scheduleAdjRows||[]).find(function(r){return r.date===date;});
    if(row)row[key]=val;
    updateAttSubmitButton();
  };
  window.scheduleAdjToggleRestDay=function(date){
    var row=(window._scheduleAdjRows||[]).find(function(r){return r.date===date;});
    if(row)row.isRestDay=!row.isRestDay;
    render();
  };
  window.scheduleAdjCopyRow=function(date){
    var rows=window._scheduleAdjRows||[];
    var source=rows.find(function(r){return r.date===date;});
    if(!source)return;
    rows.forEach(function(r){
      if(r.date===date||r.isRestDay)return;
      r.start=source.start;r.end=source.end;r.breakStart=source.breakStart;r.breakEnd=source.breakEnd;
    });
    toast('Copied to every other non-rest-day row.','success');
    render();
  };
  window.scheduleAdjDeleteRow=function(date){
    window._scheduleAdjRows=(window._scheduleAdjRows||[]).filter(function(r){return r.date!==date;});
    render();
  };

  // Employees have no default access to the Resolution Center (no permission key gates it,
  // so canAccess('resolution') is always false for a non-admin) — this is the only place they
  // can actually see and withdraw the requests they filed through this catalog.
  function myAttendanceFormRequests(){
    var mine=RESOLUTION_CASES.filter(function(c){return c.employeeId===user.id&&c.attendanceRequestType;});
    if(!mine.length)return'';
    return '<div class="section-header" style="margin-top:18px">My Requests</div>'+
      '<div style="overflow-x:auto"><table><thead><tr><th>Type</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>'+
      mine.slice().reverse().map(function(c){
        var formDef=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===c.attendanceRequestType;});
        return '<tr><td>'+esc(formDef?formDef.label:c.attendanceRequestType)+'</td>'+
          '<td class="mono" style="font-size:12px">'+esc(c.requestDate||'')+(c.requestEndDate&&c.requestEndDate!==c.requestDate?' – '+esc(c.requestEndDate):'')+'</td>'+
          '<td>'+caseBadge(c.status)+'</td>'+
          '<td>'+((c.status==='open'||c.status==='in_review')?'<button class="btn btn-sm btn-danger" onclick="cancelResolutionCase('+c.id+')">Cancel</button>':'')+'</td></tr>';
      }).join('')+
      '</tbody></table></div>';
  }
  function renderEmployeeAttendanceForms(){
    var selected=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===window._attendanceFormKey&&f.visible;});
    var visible=ATTENDANCE_FORM_CONFIG.filter(function(f){return f.visible;});
    // Submit starts (and stays) disabled until the form's own required fields all check out —
    // a toast-on-click warning was too easy to miss/ignore; disabling the button is the clearer
    // signal that something's still incomplete. Applies to every form kind, not just RDH.
    var formSubmitOk=selected?attendanceFormValid(selected):true;
    var body=selected?
      '<div style="max-width:'+(selected.kind==='schedule'?'100%':'760px')+'"><button class="btn btn-sm" style="margin-bottom:14px" onclick="window._attendanceFormKey=null;render()">Back to forms</button>'+
      '<div class="section-header">'+esc(selected.label)+'</div><div class="card-sub" style="margin-bottom:14px">'+esc(selected.description)+'</div>'+
      attendanceFormFields(selected)+'<div style="padding:9px 12px;background:var(--accent-bg);border-radius:8px;color:var(--accent-txt);font-size:12px;margin-bottom:12px">Your request will be routed to HR Operations for review and will not affect payroll until approved.</div>'+
      '<div class="action-row"><button class="btn btn-primary" id="att-submit-btn" '+(!formSubmitOk?'disabled title="Complete the required fields above before submitting."':'')+' onclick="submitAttendanceFormRequest()">Submit for approval</button><button class="btn" onclick="window._attendanceFormKey=null;render()">Cancel</button></div></div>':
      (visible.length?'<div class="attendance-catalog">'+visible.map(function(f){
        return '<button class="attendance-form-card" onclick="openAttendanceForm(\''+f.key+'\')"><span class="attendance-form-mark">'+f.short+'</span><span><strong>'+esc(f.label)+'</strong><small>'+esc(f.description)+'</small></span><span class="attendance-form-arrow">›</span></button>';
      }).join('')+'</div>':'<div class="empty-state"><div style="font-weight:700;margin-bottom:5px">No attendance forms are currently available.</div>Please contact HR if you need an attendance correction or special request.</div>')+myAttendanceFormRequests();
    // A staff-admin still needs every other Attendance tab reachable from here (Pending Approval,
    // All Employees, Attendance Report) — this used to render its own hardcoded 2-tab bar
    // ("My Records" / "Attendance Forms"), which silently dropped every other tab for a
    // staff-admin the moment they landed on their own self-service catalog. Mirror the same
    // full tab layout pgAttendance() itself uses so switching tabs from here works exactly like
    // switching from anywhere else in Attendance.
    var admin=isAdminUser(user)||isPlatformAdmin;
    var tabs=admin?['Pending Approval','My Records','Time Logs','Attendance Forms','Attendance Report']:['My Records','Attendance Forms'];
    var activeIdx=admin?3:1;
    var pendingCount=attendanceRecords().filter(function(a){return a.approvalStatus==='pending';}).length;
    return '<div class="page-header"><div><div class="page-title">Attendance</div><div class="page-sub">Employee attendance records and approval-controlled requests</div></div></div>'+
      '<div class="tabs">'+tabs.map(function(t,i){return '<div class="tab'+(i===activeIdx?' active':'')+'" onclick="window._attendanceFormKey=null;goTab('+i+')">'+t+(i===0&&admin?redBubble(pendingCount):'')+'</div>';}).join('')+'</div><div class="card">'+body+'</div>';
  }

  window.submitAttendanceFormRequest=function(){
    var form=ATTENDANCE_FORM_CONFIG.find(function(f){return f.key===window._attendanceFormKey&&f.visible;});
    if(!form){toast('This attendance form is not currently available.','warning');return;}
    var value=function(id){return ((document.getElementById(id)||{}).value||'').trim();};
    var date=value('att-form-date'),reason=value('att-form-reason');
    if(!reason){toast('Supporting details are required.','warning');return;}
    if(form.kind==='punch'){
      var corrections=window._correctionRows||[];
      if(!corrections.length||corrections.some(function(r){return !r.date||!r.punchType||!r.correctedTime;})){toast('Complete the date, punch type, and corrected time for every row.','warning');return;}
      var batchId='TC-'+Date.now();
      corrections.forEach(function(row){
        var correctionLinked=attendanceRecord(user.id,row.date);
        var correctionId=nextCaseId++,correctionDue=new Date();correctionDue.setDate(correctionDue.getDate()+4);
        RESOLUTION_CASES.push({id:correctionId,caseNo:'CASE-'+new Date().getFullYear()+'-'+String(correctionId).padStart(3,'0'),employeeId:user.id,category:'Attendance',subject:form.label+' · '+row.date,description:'Request date: '+row.date+'\nPunch: '+(row.punchType==='time_out'?'Time Out':'Time In')+'\nCorrect time: '+row.correctedTime+'\nDetails: '+reason,priority:'normal',status:'open',linkedType:correctionLinked?'attendance':'',linkedId:correctionLinked?correctionLinked.id:null,attendanceRequestType:'time_correction',requestDate:row.date,requestEndDate:row.date,punchType:row.punchType,correctedTime:row.correctedTime,batchId:batchId,submittedBy:user.name,submittedAt:new Date().toISOString(),owner:'HR Operations',dueDate:correctionDue.toISOString().slice(0,10),resolution:''});
      });
      window._correctionRows=null;window._attendanceFormKey=null;
      toast(corrections.length+' time correction request(s) submitted for approval.','success');tab=(isAdminUser(user)||isPlatformAdmin)?1:0;render();return;
    }
    if(form.kind==='schedule'){
      var schedRows=window._scheduleAdjRows||[];
      if(!schedRows.length){toast('Generate at least one date before submitting.','warning');return;}
      var badRow=schedRows.find(function(r){return !r.isRestDay&&(!r.start||!r.end);});
      if(badRow){toast('Enter a Shift Start and Shift End for '+badRow.date+', or mark it a rest day.','warning');return;}
      var fromDate=schedRows[0].date,toDate=schedRows[schedRows.length-1].date;
      var schedSummary=schedRows.map(function(r){
        var holidayTag=r.holiday?' [Holiday: '+r.holiday.name+']':'';
        return (r.isRestDay?(r.date+' ('+r.dow+'): Rest day'):(r.date+' ('+r.dow+'): '+r.start+' – '+r.end+(r.breakStart&&r.breakEnd?' · break '+r.breakStart+'–'+r.breakEnd:' · no break')))+holidayTag;
      }).join('\n');
      var schedId=nextCaseId++,schedDue=new Date();schedDue.setDate(schedDue.getDate()+4);
      RESOLUTION_CASES.push({id:schedId,caseNo:'CASE-'+new Date().getFullYear()+'-'+String(schedId).padStart(3,'0'),employeeId:user.id,category:'Attendance',subject:form.label+' · '+fromDate+(toDate!==fromDate?' to '+toDate:''),description:'Assigned shift: '+assignedShiftText(user.shiftId)+'\nEffectivity: '+fromDate+' to '+toDate+'\n'+schedSummary+'\nDetails: '+reason,priority:'normal',status:'open',linkedType:'',linkedId:null,attendanceRequestType:form.key,requestDate:fromDate,requestEndDate:toDate,scheduleDays:schedRows,submittedBy:user.name,submittedAt:new Date().toISOString(),owner:'HR Operations',dueDate:schedDue.toISOString().slice(0,10),resolution:''});
      window._scheduleAdjRows=null;window._scheduleAdjFrom=null;window._scheduleAdjTo=null;window._attendanceFormKey=null;
      toast('Schedule adjustment submitted for approval.','success');tab=(isAdminUser(user)||isPlatformAdmin)?1:0;render();return;
    }
    if(form.kind==='rdh_ot'){
      var rdhType=value('att-form-rdh-type');
      var rdhReqStart=value('att-form-in'),rdhReqEnd=value('att-form-out');
      if(!rdhReqStart||!rdhReqEnd){toast('Enter both a Requested Start Time and End Time.','warning');return;}
      var rdhCheck=rdhEligibility(user,date,rdhType,rdhReqStart,rdhReqEnd);
      if(!rdhCheck.ok){toast(rdhCheck.html.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(),'warning',7000);return;}
      var rdhLog=actualLogForDate(user.id,date);
      var rdhHoliday=HOLIDAYS.find(function(h){return h.date===date;});
      var rdhTypeLabel=rdhType==='holiday'?'Holiday':rdhType==='both'?'Rest Day on a Holiday':'Rest Day';
      var rdhDetails=['Request date: '+date,'Type: '+rdhTypeLabel,'Requested OT: '+rdhReqStart+' – '+rdhReqEnd];
      if((rdhType==='holiday'||rdhType==='both')&&rdhHoliday)rdhDetails.push('Holiday: '+rdhHoliday.name+' ('+(HOLIDAY_TYPE_LABELS[rdhHoliday.type]||rdhHoliday.type)+')');
      rdhDetails.push('Actual log: '+rdhLog.tin+' – '+rdhLog.tout,'Eligible Rest Day/Holiday overtime hours (net of 1-hr break): '+rdhCheck.hours.toFixed(2),'Details: '+reason);
      var rdhId=nextCaseId++,rdhDue=new Date();rdhDue.setDate(rdhDue.getDate()+2);
      RESOLUTION_CASES.push({id:rdhId,caseNo:'CASE-'+new Date().getFullYear()+'-'+String(rdhId).padStart(3,'0'),employeeId:user.id,category:'Attendance',subject:form.label+' · '+date,description:rdhDetails.join('\n'),priority:'high',status:'open',linkedType:'attendance',linkedId:rdhLog.id,attendanceRequestType:form.key,requestDate:date,requestEndDate:date,requestedStart:rdhReqStart,requestedEnd:rdhReqEnd,rdhType:rdhType,eligibleHours:rdhCheck.hours,submittedBy:user.name,submittedAt:new Date().toISOString(),owner:'HR Operations',dueDate:rdhDue.toISOString().slice(0,10),resolution:''});
      window._attendanceFormKey=null;
      toast('Rest Day/Holiday overtime submitted for approval.','success');tab=(isAdminUser(user)||isPlatformAdmin)?1:0;render();return;
    }
    if(form.kind==='interval'){
      var otType=value('att-form-ot-type');
      var otReqStart=value('att-form-in'),otReqEnd=value('att-form-out');
      if(!otReqStart||!otReqEnd){toast('Enter both a Requested Start Time and End Time.','warning');return;}
      var otCheck=otTypeEligibility(user,date,otType,otReqStart,otReqEnd);
      if(!otCheck.ok){toast(otCheck.html.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(),'warning',7000);return;}
      var otLog=actualLogForDate(user.id,date);
      var otTypeLabel=otType==='before'?'Before Shift':'After Shift';
      var otDetails=['Request date: '+date,'Type: '+otTypeLabel+' Overtime','Requested OT: '+otReqStart+' – '+otReqEnd,'Actual log: '+otLog.tin+' – '+otLog.tout,'Estimated eligible hours: '+otCheck.hours.toFixed(2),'Details: '+reason];
      var otId=nextCaseId++,otDue=new Date();otDue.setDate(otDue.getDate()+2);
      RESOLUTION_CASES.push({id:otId,caseNo:'CASE-'+new Date().getFullYear()+'-'+String(otId).padStart(3,'0'),employeeId:user.id,category:'Attendance',subject:form.label+' · '+date,description:otDetails.join('\n'),priority:'high',status:'open',linkedType:'attendance',linkedId:otLog.id,attendanceRequestType:form.key,requestDate:date,requestEndDate:date,requestedStart:otReqStart,requestedEnd:otReqEnd,otType:otType,eligibleHours:otCheck.hours,submittedBy:user.name,submittedAt:new Date().toISOString(),owner:'HR Operations',dueDate:otDue.toISOString().slice(0,10),resolution:''});
      window._attendanceFormKey=null;
      toast('Overtime request submitted for approval.','success');tab=(isAdminUser(user)||isPlatformAdmin)?1:0;render();return;
    }
    if(!date){toast('Request date is required.','warning');return;}
    var tin=value('att-form-in'),tout=value('att-form-out');
    if(form.kind==='ob'&&(!tin||!tout)){toast('OB Time In and Time Out are required.','warning');return;}
    if(form.kind==='minutes'&&Number(value('att-form-minutes'))<=0){toast('Enter valid undertime minutes.','warning');return;}
    if(value('att-form-end')&&value('att-form-end')<date){toast('End date cannot be earlier than the request date.','warning');return;}
    var linked=actualLogForDate(user.id,date)||attendanceRecord(user.id,date);
      var details=['Request date: '+date];
      if(value('att-form-end'))details.push('End date: '+value('att-form-end'));
      if(form.kind==='punch')details.push('Punch: '+(value('att-form-punch')==='time_out'?'Time Out':'Time In'), 'Correct time: '+value('att-form-time'));
      if(tin)details.push((form.kind==='ob'?'OB Time In':'Requested start')+': '+tin);
      if(tout)details.push((form.kind==='ob'?'OB Time Out':'Requested end')+': '+tout);
      if(form.kind==='wfh')details.push('Attendance rule: Completed actual Time In and Time Out logs required for every covered date');
      if(value('att-form-minutes'))details.push('Minutes: '+value('att-form-minutes'));
      if(value('att-form-location'))details.push('Location: '+value('att-form-location'));
      details.push('Details: '+reason);
      var id=nextCaseId++,due=new Date();due.setDate(due.getDate()+4);
      RESOLUTION_CASES.push({id:id,caseNo:'CASE-'+new Date().getFullYear()+'-'+String(id).padStart(3,'0'),employeeId:user.id,category:'Attendance',subject:form.label+' · '+date,description:details.join('\n'),priority:'normal',status:'open',linkedType:linked?'attendance':'',linkedId:linked?linked.id:null,attendanceRequestType:form.key,requestDate:date,requestEndDate:value('att-form-end')||date,requestedStart:tin,requestedEnd:tout,requestedMinutes:Number(value('att-form-minutes')||0),punchType:value('att-form-punch'),correctedTime:value('att-form-time'),eligibleHours:null,submittedBy:user.name,submittedAt:new Date().toISOString(),owner:'HR Operations',dueDate:due.toISOString().slice(0,10),resolution:''});
    window._attendanceFormKey=null;
    toast(form.label+' submitted for approval.','success');
    tab=(isAdminUser(user)||isPlatformAdmin)?1:0;render();
  };

  var baseAttendance=window.pgAttendance;
  window.pgAttendance=pgAttendance=function(){
    var admin=isAdminUser(user)||isPlatformAdmin;
    var isStaff=!!(user&&user.role==='employee');
    if(!admin&&tab===1)return renderEmployeeAttendanceForms();
    // A staff-admin (SaaS mode: role:'employee' + Super Admin access) is also filing their OWN
    // attendance, so their "File Attendance" tab (index 3 in the admin tab layout) should be the
    // same self-service catalog regular employees use — not the manual entry-on-behalf-of-others
    // form, which stays reserved for outsourced/service admins (role:'admin', not staff).
    if(admin&&isStaff&&tab===3)return renderEmployeeAttendanceForms();
    var html=baseAttendance();
    if(!admin)html=html.replace('File Attendance','Attendance Forms');
    return html;
  };

  function renderEmployeeShiftCard(employee){
    var shift=SHIFT_DEFINITIONS.find(function(s){return s.id===employee.shiftId;});
    var adjustments=(employee.scheduleAdjustments||[]).slice().reverse().slice(0,5);
    var hasPersonal=!!employee.personalSchedule;
    var effectivePatternHtml=hasPersonal
      ?'<strong>Personal Schedule</strong><br>'+esc(describeShiftPattern({schedule:employee.personalSchedule}))
      :(shift?'<strong>'+esc(shift.name)+'</strong><br>'+esc(describeShiftPattern(shift))+' · '+shift.graceMinutes+'-minute grace':'No shift is assigned.');
    return '<div class="card" style="margin-top:1rem"><div class="card-hd"><div><div class="card-title">Assigned Work Shift</div><div class="card-sub">Employee profile schedule used for attendance policy and schedule-adjustment requests</div></div><span class="badge '+(hasPersonal?'b-info':(shift&&shift.active?'b-approved':'b-pending'))+'">'+(hasPersonal?'Personal schedule':(shift&&shift.active?'Active shift':'Needs assignment'))+'</span></div>'+
      '<div class="form-row"><div class="field"><label>Shift Assignment</label><select onchange="assignEmployeeShift('+employee.id+',parseInt(this.value,10))">'+SHIFT_DEFINITIONS.filter(function(s){return s.active||s.id===employee.shiftId;}).map(function(s){return '<option value="'+s.id+'" '+(s.id===employee.shiftId?'selected':'')+'>'+esc(s.name)+(s.active?'':' (inactive)')+'</option>';}).join('')+'</select>'+(hasPersonal?'<div style="font-size:11px;color:var(--txt3);margin-top:5px">Used as the fallback if the personal schedule below is removed.</div>':'')+'</div>'+
      '<div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12px;align-self:end;margin-bottom:10px">Currently following: '+effectivePatternHtml+'</div></div>'+
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--border)">'+
      (hasPersonal?
        '<button class="btn btn-sm" onclick="openPersonalScheduleEditor('+employee.id+')">Edit Personal Schedule</button><button class="btn btn-sm btn-danger" onclick="removePersonalSchedule('+employee.id+')">Remove — follow shift template</button>':
        '<button class="btn btn-sm" onclick="openPersonalScheduleEditor('+employee.id+')">+ Set Personal Schedule</button><span style="font-size:11px;color:var(--txt3)">For when this one employee\'s hours or rest day need to differ from the shift they\'re assigned to.</span>')+
      '</div>'+
      (adjustments.length?'<div class="section-header" style="margin-top:12px">Recent approved schedule adjustments</div>'+adjustments.map(function(a){
        var summary=a.days?a.days.length+' day(s) individually scheduled':(a.start+' – '+a.end);
        return '<div class="info-row"><span>'+a.from+(a.to&&a.to!==a.from?' – '+a.to:'')+'</span><strong class="mono">'+summary+'</strong></div>';
      }).join(''):'')+'</div>';
  }

  var baseEmpDetail=window.pgEmpDetail;
  window.pgEmpDetail=pgEmpDetail=function(){
    var html=baseEmpDetail(),employee=USERS.find(function(e){return e.id===detailEmpId;});
    return html+((employee&&(isAdminUser(user)||isPlatformAdmin))?renderEmployeeShiftCard(employee):'');
  };

  var baseCompanySettings=window.pgCompanySettings;
  window.showCompanySettingsTab=function(key){window._companySettingsTab=key;render();};
  function companySettingsTabs(active){
    var items=[{key:'general',label:'General & Payroll'},{key:'shifts',label:'Shift Setup'},{key:'holidays',label:'Holiday Calendar'},{key:'leave',label:'Leave Policy'},{key:'attendance',label:'Attendance Forms'}];
    return '<div class="settings-tabbar" role="tablist" aria-label="Company Settings sections">'+items.map(function(item){return '<button class="settings-tab'+(active===item.key?' active':'')+'" role="tab" aria-selected="'+(active===item.key?'true':'false')+'" onclick="showCompanySettingsTab(\''+item.key+'\')">'+item.label+'</button>';}).join('')+'</div>';
  }
  window.pgCompanySettings=pgCompanySettings=function(){
    var admin=isAdminUser(user)||isPlatformAdmin;
    if(!admin)return baseCompanySettings();
    var active=window._companySettingsTab||'general',tabs=companySettingsTabs(active);
    if(active==='general'){
      var general=baseCompanySettings(),marker='<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">';
      return general.indexOf(marker)>=0?general.replace(marker,tabs+marker):tabs+general;
    }
    var subtitles={shifts:'Create reusable schedules and manage employee shift assignments.',holidays:'Manage holiday dates so attendance and payroll automatically apply the correct rate.',leave:'Define leave types, entitlement, accrual, and eligibility rules.',attendance:'Choose which attendance request forms employees can access.'};
    var body=active==='shifts'?renderShiftManager():active==='holidays'?renderHolidayManager():active==='leave'?renderLeavePolicyManager():renderAttendanceFormManager();
    return '<div class="page-header"><div><div class="page-title">Company Settings</div><div class="page-sub">'+(subtitles[active]||'')+'</div></div></div>'+tabs+body;
  };

  /* Extend payroll approval: approved runs release payslips and create audit events. */
  var baseApprove=window.approvePayroll;
  window.approvePayroll=function(runId){
    baseApprove(runId);
    var r=PAYROLLS.find(function(x){return x.id===runId;});
    if(r&&r.status==='approved'){r.payslipsReleased=true;r.payslipsReleasedAt=new Date().toISOString();r.payslipsReleasedBy=user.name;}
  };

  window.collectEnterpriseState=function(){
    return {resolutionCases:RESOLUTION_CASES,performanceGoals:PERFORMANCE_GOALS,jobRequisitions:JOB_REQUISITIONS,aiHistory:AI_HISTORY};
  };
  window.applyEnterpriseState=function(saved){
    if(!saved)return;
    if(Array.isArray(saved.resolutionCases)){RESOLUTION_CASES=saved.resolutionCases;nextCaseId=RESOLUTION_CASES.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;}
    if(Array.isArray(saved.performanceGoals)){PERFORMANCE_GOALS=saved.performanceGoals;nextGoalId=PERFORMANCE_GOALS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;}
    if(Array.isArray(saved.jobRequisitions))JOB_REQUISITIONS=saved.jobRequisitions;
    if(Array.isArray(saved.aiHistory))AI_HISTORY=saved.aiHistory;
    SHIFT_DEFINITIONS=(COMPANY.shifts&&COMPANY.shifts.length)?COMPANY.shifts:SHIFT_DEFINITIONS;
    nextShiftId=SHIFT_DEFINITIONS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    // LEAVE_TYPES is seeded once, synchronously, at page load — before hydrate() ever runs,
    // since that only resolves after an async /state fetch. hydrate() reassigns
    // COMPANY.leaveTypes to the saved data, but without this, the enterprise.js-local
    // LEAVE_TYPES variable everything else here actually reads from (the policy manager,
    // grantLeaveIfDue, etc.) stays pointed at the stale pre-hydration array — on a fresh page
    // load that's just the hardcoded defaults, so every saved Leave Policy customization
    // appeared to silently reset back to them on every login/refresh. Same re-sync SHIFT_DEFINITIONS
    // already gets above.
    LEAVE_TYPES=(COMPANY.leaveTypes&&COMPANY.leaveTypes.length)?COMPANY.leaveTypes:LEAVE_TYPES;
    nextLeaveTypeId=LEAVE_TYPES.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    // Same stale-reference gap as LEAVE_TYPES above, same fix.
    HOLIDAYS=(COMPANY.holidays&&COMPANY.holidays.length)?COMPANY.holidays:HOLIDAYS;
    nextHolidayId=HOLIDAYS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    if(COMPANY.attendanceForms){ATTENDANCE_FORM_CONFIG.forEach(function(form){var item=COMPANY.attendanceForms.find(function(savedForm){return savedForm.key===form.key;});if(item)form.visible=item.visible!==false;});}
  };

  var style=document.createElement('style');
  style.textContent='.attendance-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.attendance-form-setting{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:10px;padding:11px;background:var(--card)}.attendance-form-setting.is-hidden{opacity:.65;background:var(--bg)}.attendance-form-mark{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;flex:0 0 38px;border-radius:9px;background:var(--accent-bg);color:var(--accent-txt);font-size:11px;font-weight:800}.attendance-switch{position:relative;width:38px;height:22px;flex:0 0 38px}.attendance-switch input{opacity:0;width:0;height:0}.attendance-switch span{position:absolute;inset:0;border-radius:20px;background:var(--border);cursor:pointer;transition:.2s}.attendance-switch span:before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:.2s}.attendance-switch input:checked+span{background:var(--green)}.attendance-switch input:checked+span:before{transform:translateX(16px)}.attendance-catalog{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.attendance-form-card{display:flex;align-items:center;gap:12px;width:100%;padding:15px;border:1px solid var(--border);border-radius:11px;background:var(--card);color:var(--txt);text-align:left;cursor:pointer;font:inherit}.attendance-form-card:hover{border-color:var(--accent);box-shadow:0 4px 14px #0000000d}.attendance-form-card strong{display:block;margin-bottom:3px}.attendance-form-card small{display:block;color:var(--txt3);line-height:1.35}.attendance-form-arrow{margin-left:auto;color:var(--txt3);font-size:24px}.correction-row{display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:8px;padding:9px;border:1px solid var(--border);border-radius:9px;background:var(--bg)}@media(max-width:900px){.metrics[style*="repeat(5"]{grid-template-columns:repeat(2,1fr)!important}.content{padding:1rem}.card{overflow-x:auto}.attendance-form-grid,.attendance-catalog{grid-template-columns:1fr}.correction-row{grid-template-columns:1fr 1fr}.correction-row .btn{grid-column:1/-1}}';
  document.head.appendChild(style);
  var settingsStyle=document.createElement('style');
  settingsStyle.textContent='.settings-tabbar{display:flex;gap:6px;margin:0 0 1rem;padding:5px;background:var(--bg);border:1px solid var(--border);border-radius:11px;overflow-x:auto}.settings-tab{border:0;background:transparent;color:var(--txt3);padding:9px 14px;border-radius:8px;font:inherit;font-size:12px;font-weight:700;white-space:nowrap;cursor:pointer}.settings-tab:hover{color:var(--txt);background:var(--card)}.settings-tab.active{background:var(--card);color:var(--accent);box-shadow:0 1px 4px #00000012}';
  document.head.appendChild(settingsStyle);
  render();
}());
