(function () {
  'use strict';

  var PAYROLL_RULEBOOK = window.PAYROLL_RULEBOOK = window.PAYROLL_RULEBOOK || [
    {id:1,code:'BASIC_PAY',name:'Basic Pay by Payroll Frequency',category:'earnings',sourceType:'contract',source:'Employment contract / company compensation policy',effectiveFrom:'2025-01-01',effectiveTo:'',coverage:{},value:1,formula:'Effective monthly salary converted by payroll frequency',priority:100,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:2,code:'OT_REGULAR_DAY',name:'Regular-Day Overtime',category:'premium',sourceType:'statutory',source:'Labor Code / DOLE',effectiveFrom:'2025-01-01',effectiveTo:'',coverage:{otEligible:true},value:1.25,formula:'Hourly Rate × Approved OT Hours × 125%',priority:200,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:3,code:'REST_HOLIDAY_WORK',name:'Rest-Day / Special-Day Work',category:'premium',sourceType:'statutory',source:'Labor Code / DOLE',effectiveFrom:'2025-01-01',effectiveTo:'',coverage:{otEligible:true},value:1.30,formula:'Hourly Rate × Approved Hours × 130%',priority:210,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:4,code:'NIGHT_DIFFERENTIAL',name:'Night Shift Differential',category:'premium',sourceType:'statutory',source:'Labor Code / DOLE',effectiveFrom:'2025-01-01',effectiveTo:'',coverage:{},value:0.10,formula:'Applicable Hourly Base × Qualified NSD Hours × 10%',priority:220,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:5,code:'ABSENCE_DEDUCTION',name:'Unpaid Absence',category:'attendance',sourceType:'policy',source:'Company attendance policy',effectiveFrom:'2025-01-01',effectiveTo:'',coverage:{},value:1,formula:'Unpaid Absence Days × Daily Rate',priority:300,rounding:'exact',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:6,code:'LATE_ROUNDING_MINUTES',name:'Late Rounding Increment',category:'attendance',sourceType:'policy',source:'Company attendance policy',effectiveFrom:'2025-01-01',effectiveTo:'',coverage:{},value:1,formula:'Round chargeable late time upward to configured minute increment',priority:310,rounding:'exact',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:7,code:'DEMINIMIS_RICE_MONTHLY',name:'Rice Subsidy Monthly Ceiling',category:'tax',sourceType:'statutory',source:'BIR RR 29-2025',effectiveFrom:'2026-01-01',effectiveTo:'',coverage:{},value:2500,formula:'Lower of rice benefit paid or ₱2,500 monthly ceiling',priority:400,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:8,code:'PROTECTED_NET_PAY',name:'Protected Minimum Net Pay',category:'deduction',sourceType:'policy',source:'Company deduction and employee authorization policy',effectiveFrom:'2025-01-01',effectiveTo:'',coverage:{},value:0,formula:'Gross Pay − Mandatory Deductions − Protected Net Amount',priority:500,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:9,code:'DEMINIMIS_UNIFORM_ANNUAL',name:'Uniform and Clothing Annual Ceiling',category:'tax',sourceType:'statutory',source:'BIR RR 29-2025',effectiveFrom:'2026-01-01',effectiveTo:'',coverage:{},value:8000,formula:'Annual non-taxable ceiling by benefit category',priority:401,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:10,code:'DEMINIMIS_MEDICAL_ANNUAL',name:'Actual Medical Assistance Annual Ceiling',category:'tax',sourceType:'statutory',source:'BIR RR 29-2025',effectiveFrom:'2026-01-01',effectiveTo:'',coverage:{},value:12000,formula:'Annual non-taxable ceiling by benefit category',priority:402,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:11,code:'DEMINIMIS_LAUNDRY_MONTHLY',name:'Laundry Allowance Monthly Ceiling',category:'tax',sourceType:'statutory',source:'BIR RR 29-2025',effectiveFrom:'2026-01-01',effectiveTo:'',coverage:{},value:400,formula:'Monthly non-taxable ceiling by benefit category',priority:403,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:12,code:'DEMINIMIS_GIFT_ANNUAL',name:'Christmas / Anniversary Gift Annual Ceiling',category:'tax',sourceType:'statutory',source:'BIR RR 29-2025',effectiveFrom:'2026-01-01',effectiveTo:'',coverage:{},value:6000,formula:'Annual non-taxable ceiling by benefit category',priority:404,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'},
    {id:13,code:'THIRTEENTH_MONTH_EXEMPT_ANNUAL',name:'13th-Month and Other Benefits Exemption',category:'tax',sourceType:'statutory',source:'NIRC / current BIR rules',effectiveFrom:'2018-01-01',effectiveTo:'',coverage:{},value:90000,formula:'Annual non-taxable 13th-month and other-benefits bucket',priority:405,rounding:'final-line-2',approvalRequired:true,status:'active',version:1,createdBy:'System',approvedBy:'Payroll Administrator'}
  ];
  var PAYROLL_RULE_AUDIT = window.PAYROLL_RULE_AUDIT = window.PAYROLL_RULE_AUDIT || [];
  var PAYROLL_RETRO = window.PAYROLL_RETRO = window.PAYROLL_RETRO || [];
  var PAYROLL_WORKFLOW = window.PAYROLL_WORKFLOW = window.PAYROLL_WORKFLOW || [
    {key:'maker',label:'HR / Payroll Maker'},
    {key:'timekeeping_reviewer',label:'Timekeeping Reviewer'},
    {key:'hr_checker',label:'HR Checker'},
    {key:'finance_checker',label:'Finance Checker'},
    {key:'authorized_approver',label:'Authorized Approver'}
  ];
  var nextRuleId = PAYROLL_RULEBOOK.reduce(function (max,rule) { return Math.max(max,rule.id||0); },0)+1;

  function addDays(date,days){var value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);}
  function defaultAllowanceFrequency(emp){var group=PAYROLL_GROUPS.find(function(item){return item.id===emp.payGroupId;});return group&&['monthly','semi-monthly','weekly','bi-weekly'].indexOf(group.freq)>=0?group.freq:'monthly';}
  function migrateRecurringAllowances(emp){
    if(!Array.isArray(emp.recurringAllowances))emp.recurringAllowances=[];
    [{field:'mobileAllowance',code:'LOAD'},{field:'riceAllowance',code:'RICE'}].forEach(function(legacy){
      var amount=Number(emp[legacy.field]||0);
      if(!amount||emp.recurringAllowances.some(function(item){return item.legacyField===legacy.field;}))return;
      emp.recurringAllowances.push({id:'RA-'+emp.id+'-'+legacy.code,payItemCode:legacy.code,monthlyAmount:amount,frequency:defaultAllowanceFrequency(emp),timing:'every-2nd',effectiveFrom:emp.hired||'2025-01-01',effectiveTo:'',active:true,notes:'Migrated from legacy employee profile',legacyField:legacy.field});
    });
  }
  function ensureEffectiveData(){
    var componentUpdates={RICE:{dmLimit:2500,limitPeriod:'monthly'},CLOTH:{dmLimit:8000,limitPeriod:'annual'},XMAS:{dmLimit:6000,limitPeriod:'annual'},MEDICAL:{dmLimit:12000,limitPeriod:'annual'}};
    Object.keys(componentUpdates).forEach(function(code){var component=INCOME_TYPES.find(function(item){return item.code===code;});if(component)Object.assign(component,componentUpdates[code]);});
    USERS.filter(function(emp){return emp.role==='employee';}).forEach(function(emp){
      if(!Array.isArray(emp.compensationHistory))emp.compensationHistory=[];
      if(!emp.compensationHistory.length)emp.compensationHistory.push({id:'COMP-'+emp.id+'-1',effectiveFrom:emp.salaryEffectiveDate||emp.hired||'2025-01-01',effectiveTo:'',monthlySalary:Number(emp.salaryPM||emp.rate*(emp.dailyDivisor||COMPANY.dailyDivisor||22)),dailyRate:Number(emp.rate||0),hoursPerDay:Number(emp.hoursPerDay||8),annualWorkdays:Number(emp.annualWorkdays||261),status:'active',version:1,approvedBy:'Payroll migration'});
      if(typeof emp.otEligible==='undefined')emp.otEligible=true;
      if(typeof emp.holidayPayEligible==='undefined')emp.holidayPayEligible=true;
      if(typeof emp.nightDifferentialEligible==='undefined')emp.nightDifferentialEligible=true;
      if(typeof emp.restDayPremiumEligible==='undefined')emp.restDayPremiumEligible=true;
      if(!emp.workLocation)emp.workLocation=emp.city||'Philippines';
      migrateRecurringAllowances(emp);
    });
    PAY_PERIODS.forEach(function(period){
      if(typeof period.includeRecurringAllowances==='undefined')period.includeRecurringAllowances=true;
      var payDate=period.releaseDate||period.to;
      if(!period.adjustmentCutoff)period.adjustmentCutoff=period.attendanceTo||period.to;
      if(!period.approvalDeadline)period.approvalDeadline=addDays(payDate,-3);
      if(!period.processingDate)period.processingDate=addDays(payDate,-4);
      if(!period.bankFileDate)period.bankFileDate=addDays(payDate,-2);
      if(!period.fundingDeadline)period.fundingDeadline=addDays(payDate,-1);
      if(!period.glPostingDate)period.glPostingDate=payDate;
      if(!period.lockDate)period.lockDate=addDays(payDate,-1);
    });
  }
  function effectiveEmployee(emp,date){
    var records=(emp.compensationHistory||[]).filter(function(record){return record.status==='active'&&(!record.effectiveFrom||record.effectiveFrom<=date)&&(!record.effectiveTo||record.effectiveTo>=date);}).sort(function(a,b){return String(b.effectiveFrom).localeCompare(String(a.effectiveFrom))||Number(b.version||0)-Number(a.version||0);});
    var record=records[0];if(!record)return emp;
    return Object.assign({},emp,{salaryPM:Number(record.monthlySalary||emp.salaryPM||0),rate:Number(record.dailyRate||emp.rate||0),hoursPerDay:Number(record.hoursPerDay||emp.hoursPerDay||8),annualWorkdays:Number(record.annualWorkdays||emp.annualWorkdays||261),appliedCompensationRecord:record});
  }
  ensureEffectiveData();

  function audit(action,details) {
    PAYROLL_RULE_AUDIT.push({id:Date.now()+Math.random(),action:action,details:details||'',by:user&&user.name||'System',at:new Date().toISOString()});
  }
  function approvedAttendanceSummary(emp,from,to) {
    var approved = attendanceRecords().filter(function (record) { return record.approvalStatus === 'approved'; });
    return TimekeepingCore.periodSummary(approved,emp,from,to,typeof SHIFT_DEFINITIONS==='undefined'?[]:SHIFT_DEFINITIONS);
  }
  function periodForCalculation(period) {
    if (period) return period;
    var from = document.getElementById('pf')&&document.getElementById('pf').value||today();
    var to = document.getElementById('pt')&&document.getElementById('pt').value||today();
    return {from:from,to:to,attendanceFrom:from,attendanceTo:to,cutoff1:true,cutoff2:true};
  }
  function statutoryAmounts(monthly,factor) {
    return {
      sssEE:PayrollRuleEngine.money(totalSSS(monthly)*factor),sssER:PayrollRuleEngine.money(totalSssEr(monthly)*factor),
      phEE:PayrollRuleEngine.money(phContrib(monthly)*factor),phER:PayrollRuleEngine.money(phErShare(monthly)*factor),
      piEE:PayrollRuleEngine.money(piContrib(monthly)*factor),piER:PayrollRuleEngine.money(piErShare(monthly)*factor)
    };
  }
  function effectiveAdjustments(emp,period) {
    return PAYROLL_ADJ.filter(function (adjustment) {
      if(adjustment.empId!==emp.id||adjustment.status!=='approved')return false;
      if(adjustment.payPeriodId)return !!period.id&&adjustment.payPeriodId===period.id;
      return !adjustment.effectiveDate||adjustment.effectiveDate<=period.to;
    }).map(function (adjustment) {
      var payItem=INCOME_TYPES.find(function(item){return item.code===adjustment.payItemCode;});
      return Object.assign({},adjustment,{taxable:payItem?payItem.taxable:adjustment.amount>0,category:payItem?payItem.cat:adjustment.category});
    });
  }
  function recurringAllowanceFactor(record,group,period){
    return PayrollRuleEngine.recurringAllowanceFactor(record,group,period);
  }
  function effectiveRecurringAllowances(emp,group,period){
    var selectedCodes=period.recurringAllowanceCodes;
    if(Array.isArray(selectedCodes)&&!selectedCodes.length)return[];
    if(!Array.isArray(selectedCodes)&&period.includeRecurringAllowances===false)return[];
    migrateRecurringAllowances(emp);
    return (emp.recurringAllowances||[]).filter(function(record){
      var selected=!Array.isArray(selectedCodes)||selectedCodes.indexOf(record.payItemCode)>=0;
      return selected&&record.active!==false&&(!record.effectiveFrom||record.effectiveFrom<=period.to)&&(!record.effectiveTo||record.effectiveTo>=period.from);
    }).map(function(record){
      var payItem=INCOME_TYPES.find(function(item){return item.code===record.payItemCode;});
      var factor=recurringAllowanceFactor(record,group,period);
      if(!payItem||!factor)return null;
      var monthlyAmount=Number(record.monthlyAmount||record.amount||0);
      var fixedPayout=record.frequency==='every-payroll'||record.frequency==='quarterly';
      var payoutAmount=fixedPayout?monthlyAmount:monthlyAmount*factor;
      var capFactor=record.frequency==='every-payroll'?PayrollRuleEngine.frequencyFactor(group):(record.frequency==='quarterly'?3:factor);
      return Object.assign({},record,{name:payItem.name,taxable:payItem.taxable!==false,deminimis:!!payItem.deminimis,payoutAmount:PayrollRuleEngine.money(payoutAmount),exemptLimit:PayrollRuleEngine.money(Number(payItem.dmLimit||0)*capFactor),source:'Income Type '+payItem.code+' / employee recurring allowance',formula:record.frequency==='every-payroll'?'Fixed amount every payroll':record.frequency==='quarterly'?'Fixed quarterly amount in configured payout month':'Monthly entitlement × '+PayrollRuleEngine.money(factor)+' schedule factor'});
    }).filter(Boolean);
  }
  function governanceDraft(emp,grp,period) {
    var p=periodForCalculation(period);
    var from=p.attendanceFrom||p.from,to=p.attendanceTo||p.to;
    var appliedEmp=effectiveEmployee(emp,p.to);
    var attendance=approvedAttendanceSummary(appliedEmp,from,to);
    var baseBasic=computeBasicByPayType(appliedEmp,grp,p);
    var recurringAllowances=effectiveRecurringAllowances(emp,grp,p);
    var result=PayrollRuleEngine.calculate({employee:appliedEmp,group:grp,period:p,attendance:attendance,rules:PAYROLL_RULEBOOK,baseBasic:baseBasic,defaultDivisor:COMPANY.dailyDivisor||22,recurringAllowances:recurringAllowances,adjustments:effectiveAdjustments(emp,p),loans:LOANS.filter(function(loan){return loan.eid===emp.id;}),statutory:statutoryAmounts,tax:birTaxByFreq});
    return Object.assign({empId:emp.id,name:emp.name,eid:emp.eid,pos:emp.pos,payType:emp.payType,baseBasic:baseBasic,pr:attendance.presentDays,absentDays:attendance.absentDays,lateMinutes:attendance.lateMinutes,undertimeMinutes:attendance.undertimeMinutes,otH:attendance.otHours,ndH:attendance.ndHours,attendanceSummary:attendance,attendanceFrom:from,attendanceTo:to,attendanceApproved:attendance.records.length,applyStatutory:result.statutoryFactor>0,recurringAllowances:recurringAllowances,taxFreq:grp.taxMethod||grp.freq,ms:result.rates.monthly,calculationTrace:result.lines,validationIssues:result.issues,loanSchedule:result.loanSchedule,employerContributions:result.employerContributions,employerCost:result.employerCost,compensationSnapshot:appliedEmp.appliedCompensationRecord||null,_computed:{basic:result.basic,ot:result.ot,nd:result.nd,sss:result.sss,ph:result.ph,pi:result.pi,tax:result.tax,loan:result.loan},_nonEditableGross:PayrollRuleEngine.money(result.gross-result.basic-result.ot-result.nd),_edited:false},result);
  }
  window.buildDraftRow=buildDraftRow=governanceDraft;
  window.updateDraftNet=updateDraftNet=function(empId){
    var draft=PAYROLL_DRAFT[empId];if(!draft)return;
    var original=draft._computed||{};
    var changed=['basic','ot','nd','sss','ph','pi','tax','loan'].filter(function(key){return Number(draft[key]||0)!==Number(original[key]||0);});
    if(changed.length&&!draft.manualOverride){
      var reason=prompt('Manual payroll override detected ('+changed.join(', ')+'). Enter the reason and supporting approval reference:');
      if(reason===null||!reason.trim()){changed.forEach(function(key){draft[key]=Number(original[key]||0);});toast('Manual override cancelled. System-computed values restored.','info');render();return;}
      draft.manualOverride={fields:changed,reason:reason.trim(),by:user.name,at:new Date().toISOString(),original:Object.assign({},original)};
      draft.calculationTrace.push({code:'MANUAL_OVERRIDE',name:'Manual Payroll Override',type:'control',amount:0,ruleCode:'MANUAL_EXCEPTION',ruleVersion:1,legalSource:reason.trim(),formula:'Original system result retained in audit; override requires approval'});
    }
    var taxableDelta=(Number(draft.basic||0)-Number(original.basic||0))+(Number(draft.ot||0)-Number(original.ot||0))+(Number(draft.nd||0)-Number(original.nd||0));
    if(changed.indexOf('tax')<0)draft.tax=birTaxByFreq(Math.max(0,Number(draft.taxableCompensation||0)+taxableDelta),draft.taxFreq);
    draft.gross=PayrollRuleEngine.money(Number(draft.basic||0)+Number(draft.ot||0)+Number(draft.nd||0)+Number(draft._nonEditableGross||0));
    draft.totalDed=PayrollRuleEngine.money(Number(draft.attendanceDeduction||0)+Number(draft.sss||0)+Number(draft.ph||0)+Number(draft.pi||0)+Number(draft.tax||0)+Number(draft.loan||0));
    draft.net=PayrollRuleEngine.money(Math.max(0,draft.gross-draft.totalDed));draft._edited=true;render();
  };

  window.runPayroll=runPayroll=function(){
    var from=document.getElementById('pf')&&document.getElementById('pf').value;
    var to=document.getElementById('pt')&&document.getElementById('pt').value;
    if(!from||!to||!Object.keys(PAYROLL_DRAFT).length){toast('Preview payroll before submitting it.','warning');return;}
    var blockers=Object.values(PAYROLL_DRAFT).reduce(function(all,item){return all.concat((item.validationIssues||[]).filter(function(issue){return issue.severity==='blocker';}).map(function(issue){return item.eid+': '+issue.message;}));},[]);
    if(blockers.length){toast('Payroll blocked by '+blockers.length+' validation issue(s). Open the calculation trace for details.','warning',6000);return;}
    var groupId=window._prGroup||PAYROLL_GROUPS[0].id;
    var grp=PAYROLL_GROUPS.find(function(g){return g.id===groupId;})||PAYROLL_GROUPS[0];
    var pendingRun=PAYROLLS.find(function(run){return run.groupId===groupId&&run.from===from&&run.to===to&&run.status==='pending_approval';});
    if(pendingRun&&window._reprocessRunId!==pendingRun.id){toast('A payroll for this group and period is already awaiting approval. Use Reprocess Payroll from Adjustments.','warning');return;}
    var calculationPeriod={id:window._prPeriod!=='custom'?window._prPeriod:null,to:to};
    var items=Object.values(PAYROLL_DRAFT).map(function(item){return Object.assign({},item,{adjustmentIds:effectiveAdjustments(USERS.find(function(e){return e.id===item.empId;}),calculationPeriod).map(function(adj){return adj.id;})});});
    var now=new Date().toISOString();
    if(pendingRun){pendingRun.status='superseded';pendingRun.supersededAt=now;pendingRun.supersededBy=user.name;pendingRun.supersededReason='Replacement payroll submitted after approved adjustments';PAYROLL_AUDIT.push({runId:pendingRun.id,action:'superseded_for_reprocess',by:user.name,at:now,notes:'Replacement payroll was submitted from the adjustment reprocessing flow'});}
    var run={id:nPay++,from:from,to:to,items:items,on:today(),groupId:groupId,groupName:grp.name||'Standard',periodId:window._prPeriod!=='custom'?window._prPeriod:null,status:'pending_approval',approvalStage:1,workflow:[{stage:'maker',label:'HR / Payroll Maker',by:user.name,at:now,status:'completed'}],preparedBy:user.name,preparedAt:now,ruleSnapshot:PAYROLL_RULEBOOK.filter(function(rule){return rule.status==='active';}).map(function(rule){return {id:rule.id,code:rule.code,version:rule.version,effectiveFrom:rule.effectiveFrom,value:rule.value};}),complianceVersion:'Versioned PH Payroll Rule Engine · '+today()};
    PAYROLLS.push(run);PAYROLL_AUDIT.push({runId:run.id,action:'maker_submitted',stage:'maker',by:user.name,at:now});
    items.forEach(function(item){(item.adjustmentIds||[]).forEach(function(id){var adjustment=PAYROLL_ADJ.find(function(a){return a.id===id;});if(adjustment){adjustment.processStatus='submitted_for_approval';adjustment.payrollRunId=run.id;}});});
    PAYROLL_DRAFT={};window._prPreview=false;window._reprocessRunId=null;queueSync('Payroll_Runs','Payroll_Items','Payroll_Audit','Payroll_Adjustments');toast('Payroll submitted to the Timekeeping Reviewer.','success');tab=0;render();
  };

  window.approvePayroll=function(runId){
    var run=PAYROLLS.find(function(item){return item.id===runId;});
    if(!run||run.status!=='pending_approval')return;
    if(!(user.role==='admin'||canAccess('payroll_approve'))){toast('You do not have payroll approval permission.','error');return;}
    var stageIndex=numberOr(run.approvalStage,1),stage=PAYROLL_WORKFLOW[stageIndex];
    if(!stage){lockPayrollRun(run);return;}
    var previous=(run.workflow||[])[run.workflow.length-1];
    var override=false;
    if(previous&&previous.by===user.name){
      if(!isPlatformAdmin||!confirm('Segregation-of-duties warning: the same user handled the previous stage. Use emergency platform-admin override?')){toast('A different authorized user must complete '+stage.label+'.','warning');return;}
      override=true;
    }
    var notes=prompt(stage.label+' review notes / basis:');if(notes===null)return;
    if(!notes.trim()){toast('Review notes are required for the audit trail.','warning');return;}
    var at=new Date().toISOString();run.workflow=run.workflow||[];run.workflow.push({stage:stage.key,label:stage.label,by:user.name,at:at,status:'completed',notes:notes.trim(),segregationOverride:override});
    PAYROLL_AUDIT.push({runId:run.id,action:'stage_approved',stage:stage.key,by:user.name,at:at,notes:notes.trim(),segregationOverride:override});run.approvalStage=stageIndex+1;
    if(run.approvalStage>=PAYROLL_WORKFLOW.length)lockPayrollRun(run);else{queueSync('Payroll_Runs','Payroll_Audit');toast(stage.label+' completed. Next: '+PAYROLL_WORKFLOW[run.approvalStage].label+'.','success');render();}
  };
  function numberOr(value,fallback){var parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback;}
  function lockPayrollRun(run){
    var at=new Date().toISOString();run.status='locked';run.approvedBy=user.name;run.approvedAt=at;run.lockedAt=at;run.immutable=true;
    run.items.forEach(function(item){(item.adjustmentIds||[]).forEach(function(id){var adjustment=PAYROLL_ADJ.find(function(a){return a.id===id;});if(adjustment){adjustment.status='applied';adjustment.processStatus='applied';adjustment.appliedAt=at;adjustment.payrollRunId=run.id;}});});
    var period=PAY_PERIODS.find(function(item){return item.id===run.periodId;});if(period){period.status='closed';period.runId=run.id;period.lockedBy=user.email||user.name;period.lockedAt=today();}
    PAYROLL_AUDIT.push({runId:run.id,action:'approved_locked_immutable',stage:'authorized_approver',by:user.name,at:at});queueSync('Payroll_Runs','Payroll_Items','Payroll_Audit','Payroll_Adjustments','Payroll_Periods');toast('Payroll approved, locked, and immutable. Corrections now require a retro adjustment or reversal.','success');render();
  }
  window.rejectPayroll=function(runId){
    var run=PAYROLLS.find(function(item){return item.id===runId;});if(!run||run.status!=='pending_approval')return;
    var reason=prompt('Reason for returning this payroll:');if(reason===null)return;if(!reason.trim()){toast('A return reason is required.','warning');return;}
    run.status='returned';run.rejectedBy=user.name;run.rejectedAt=new Date().toISOString();run.returnReason=reason.trim();PAYROLL_AUDIT.push({runId:run.id,action:'returned_for_correction',by:user.name,at:run.rejectedAt,notes:reason.trim()});queueSync('Payroll_Runs','Payroll_Audit');toast('Payroll returned to the maker.','warning');render();
  };
  window.requestPayrollReopen=function(runId){
    var run=PAYROLLS.find(function(item){return item.id===runId;});if(!run||run.status!=='locked')return;
    var reason=prompt('Why must this locked payroll be reopened?');if(reason===null||!reason.trim())return;
    run.reopenRequest={status:'pending',reason:reason.trim(),requestedBy:user.name,requestedAt:new Date().toISOString()};PAYROLL_AUDIT.push({runId:run.id,action:'reopen_requested',by:user.name,at:run.reopenRequest.requestedAt,notes:reason.trim()});queueSync('Payroll_Runs','Payroll_Audit');toast('Reopen request submitted. Posted results remain unchanged.','info');render();
  };

  function canManagePayrollCalendar(){
    return !!(user&&(user.role==='admin'||isPlatformAdmin||canAccess('payroll_approve')));
  }
  function periodAudit(action,period,notes,runId){
    PAYROLL_AUDIT.push({runId:runId||period.runId||null,periodId:period.id,action:action,by:user.name,at:new Date().toISOString(),notes:notes||period.label});
  }
  window.lockPayPeriod=function(periodId){
    var period=PAY_PERIODS.find(function(item){return item.id===periodId;});
    if(!period||period.status!=='open')return;
    if(!canManagePayrollCalendar()){toast('You do not have permission to lock payroll calendars.','error');return;}
    period.status='locked';period.lockedBy=user.email||user.name;period.lockedAt=new Date().toISOString();
    periodAudit('pay_period_locked',period,'Calendar manually locked');
    queueSync('Payroll_Calendar','Payroll_Audit');toast('Payroll calendar locked.','success');render();
  };
  window.unlockPayPeriod=function(periodId){
    var period=PAY_PERIODS.find(function(item){return item.id===periodId;});
    if(!period||period.status!=='locked')return;
    if(!canManagePayrollCalendar()){toast('You do not have permission to unlock payroll calendars.','error');return;}
    var reason=prompt('Reason for unlocking this payroll calendar:');
    if(reason===null)return;
    if(!reason.trim()){toast('An unlock reason is required for the audit trail.','warning');return;}
    period.status='open';period.lockedBy=null;period.lockedAt=null;
    periodAudit('pay_period_unlocked',period,reason.trim());
    queueSync('Payroll_Calendar','Payroll_Audit');toast('Payroll calendar unlocked. You may now edit or delete it.','info');render();
  };
  window.reopenClosedPayPeriod=function(periodId){
    var period=PAY_PERIODS.find(function(item){return item.id===periodId;});
    if(!period||period.status!=='closed')return;
    if(!canManagePayrollCalendar()){toast('Payroll approval permission is required to reopen a closed calendar.','error');return;}
    var reason=prompt('Reason for voiding the posted payroll and reopening this calendar:');
    if(reason===null)return;
    if(!reason.trim()){toast('A reason is required for the audit trail.','warning');return;}
    if(!confirm('Void the linked payroll and reopen "'+period.label+'"?\n\nThe original payroll will remain in the audit history as VOIDED. This action cannot silently erase posted results.'))return;
    var linkedRunId=period.runId;
    var run=PAYROLLS.find(function(item){return item.id===linkedRunId;});
    var at=new Date().toISOString();
    if(run){
      run.status='voided';run.voidedBy=user.name;run.voidedAt=at;run.voidReason=reason.trim();run.immutable=true;
      run.reopenRequest={status:'approved',reason:reason.trim(),requestedBy:user.name,requestedAt:at,approvedBy:user.name,approvedAt:at};
    }
    period.status='open';period.runId=null;period.lockedBy=null;period.lockedAt=null;period.reopenedBy=user.name;period.reopenedAt=at;period.reopenReason=reason.trim();
    periodAudit('payroll_voided_period_reopened',period,reason.trim(),linkedRunId);
    queueSync('Payroll_Calendar','Payroll_Runs','Payroll_Items','Payroll_Audit');
    toast('Posted payroll voided and calendar reopened. The audit history was preserved.','success',5500);render();
  };
  window.deletePayPeriod=function(periodId){
    var period=PAY_PERIODS.find(function(item){return item.id===periodId;});
    if(!period)return;
    if(!canManagePayrollCalendar()){toast('You do not have permission to delete payroll calendars.','error');return;}
    if(period.status!=='open'||period.runId){toast('Unlock or safely void and reopen this period before deleting it.','warning');return;}
    if(!confirm('Delete payroll calendar "'+period.label+'"? This removes the calendar only; audit and voided payroll history are retained.'))return;
    periodAudit('pay_period_deleted',period,'Deleted open payroll calendar');
    PAY_PERIODS.splice(PAY_PERIODS.findIndex(function(item){return item.id===periodId;}),1);
    queueSync('Payroll_Calendar','Payroll_Audit');toast('Payroll calendar deleted and saved.','success');render();
  };

  window.createPayrollRuleVersion=function(code){
    var latest=PAYROLL_RULEBOOK.filter(function(rule){return rule.code===code;}).sort(function(a,b){return b.version-a.version;})[0];if(!latest)return;
    var effective=prompt('Effective-from date (YYYY-MM-DD):',today());if(!effective)return;
    var value=prompt('New numeric rule value:',latest.value);if(value===null||isNaN(Number(value)))return;
    var reason=prompt('Reason and legal/policy basis for this new version:');if(reason===null||!reason.trim())return;
    var version=Object.assign({},latest,{id:nextRuleId++,value:Number(value),effectiveFrom:effective,effectiveTo:'',version:latest.version+1,status:'draft',createdBy:user.name,createdAt:new Date().toISOString(),approvedBy:'',approvedAt:'',changeReason:reason.trim()});PAYROLL_RULEBOOK.push(version);audit('rule_version_created',code+' v'+version.version+' · '+reason.trim());toast(code+' version '+version.version+' created as Draft.','success');render();
  };
  window.approvePayrollRule=function(id){var rule=PAYROLL_RULEBOOK.find(function(item){return item.id===id;});if(!rule||rule.status!=='draft')return;if(rule.createdBy===user.name&&!isPlatformAdmin){toast('A different authorized user must approve this rule version.','warning');return;}rule.status='approved';rule.approvedBy=user.name;rule.approvedAt=new Date().toISOString();audit('rule_approved',rule.code+' v'+rule.version);queueSync('Payroll_Rules');render();};
  window.activatePayrollRule=function(id){
    var rule=PAYROLL_RULEBOOK.find(function(item){return item.id===id;});if(!rule||rule.status!=='approved')return;
    var previous=PAYROLL_RULEBOOK.filter(function(item){return item.code===rule.code&&item.status==='active';});previous.forEach(function(item){item.status='retired';item.effectiveTo=dayBefore(rule.effectiveFrom);});rule.status='active';rule.activatedBy=user.name;rule.activatedAt=new Date().toISOString();audit('rule_activated',rule.code+' v'+rule.version+' effective '+rule.effectiveFrom);queueSync('Payroll_Rules');toast('New rule version activated. Prior versions were retained.','success');render();
  };
  function dayBefore(date){var value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()-1);return value.toISOString().slice(0,10);}
  window.runPayrollRuleSimulation=function(){window._ruleSimulation=USERS.filter(function(e){return e.role==='employee';}).slice().sort(function(a,b){return (a.salaryPM||a.rate*22)-(b.salaryPM||b.rate*22);}).filter(function(_,i,array){return i===0||i===array.length-1;}).map(function(emp){var group=PAYROLL_GROUPS.find(function(g){return g.id===emp.payGroupId;})||PAYROLL_GROUPS[0];var period=PAY_PERIODS.find(function(p){return p.groupId===group.id&&p.status==='open';})||{from:today(),to:today(),attendanceFrom:today(),attendanceTo:today(),cutoff1:true,cutoff2:true};var draft=governanceDraft(emp,group,period);return {employee:emp.name,scenario:iLabel(emp),gross:draft.gross,net:draft.net,issues:draft.validationIssues.length};});audit('rule_simulation','Minimum/high-income regression scenarios');toast('Rule simulation completed.','success');render();};
  function iLabel(emp){return (emp.salaryPM||emp.rate*22)<20000?'Lower-paid employee':'Higher-paid employee';}

  function validationInventory(){
    var issues=[];USERS.filter(function(e){return e.role==='employee';}).forEach(function(emp){PayrollRuleEngine.validateEmployee(emp).forEach(function(issue){issues.push(Object.assign({employee:emp.name},issue));});});
    PayrollRuleEngine.validateAttendance(attendanceRecords()).forEach(function(issue){issues.push(Object.assign({employee:'Attendance'},issue));});
    PAYROLL_RULEBOOK.filter(function(rule){return !rule.source||!rule.formula;}).forEach(function(rule){issues.push({employee:rule.code,severity:'blocker',code:'RULE_INCOMPLETE',message:'Rule source or formula is missing'});});
    return issues;
  }
  function workflowLabel(run){var index=numberOr(run.approvalStage,1);return run.status==='locked'?'Locked':run.status==='pending_approval'?(PAYROLL_WORKFLOW[index]&&PAYROLL_WORKFLOW[index].label||'Final approval'):run.status;}
  function governanceDashboard(){
    var active=PAYROLL_RULEBOOK.filter(function(rule){return rule.status==='active';}).length,drafts=PAYROLL_RULEBOOK.filter(function(rule){return rule.status==='draft'||rule.status==='approved';}).length,issues=validationInventory(),blockers=issues.filter(function(issue){return issue.severity==='blocker';}).length;
    return '<div class="card" style="margin-top:1rem;border-left:3px solid var(--accent)"><div class="card-hd"><div><div class="card-title">Versioned Payroll Control Center</div><div class="card-sub">Every payroll amount now carries its rule, version, formula, source, and approval trail.</div></div><button class="btn btn-sm btn-primary" onclick="window._payrollAdminMode=\'governance\';goTab(6)">Open rulebook</button></div><div class="metrics" style="margin:0"><div class="metric"><div class="metric-label">Active Rules</div><div class="metric-val" style="font-size:20px">'+active+'</div></div><div class="metric"><div class="metric-label">Versions Awaiting Action</div><div class="metric-val" style="font-size:20px;color:var(--amber)">'+drafts+'</div></div><div class="metric"><div class="metric-label">Validation Blockers</div><div class="metric-val" style="font-size:20px;color:'+(blockers?'var(--red)':'var(--green)')+'">'+blockers+'</div></div><div class="metric"><div class="metric-label">Approval Steps</div><div class="metric-val" style="font-size:20px">'+PAYROLL_WORKFLOW.length+'</div></div></div></div>';
  }
  function tracePanel(){
    var drafts=Object.values(PAYROLL_DRAFT);if(!window._prPreview||!drafts.length)return'';
    var selected=PAYROLL_DRAFT[window._payrollTraceEmployee]||drafts[0];window._payrollTraceEmployee=selected.empId;
    return '<div class="card" style="margin-top:1rem;border-left:3px solid var(--blue)"><div class="card-hd"><div><div class="card-title">Calculation Trace</div><div class="card-sub">Select an employee to prove every amount from source to net pay.</div></div><select style="width:auto" onchange="window._payrollTraceEmployee=parseInt(this.value,10);render()">'+drafts.map(function(item){return '<option value="'+item.empId+'" '+(item.empId===selected.empId?'selected':'')+'>'+esc(item.name)+'</option>';}).join('')+'</select></div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px"><div class="metric"><div class="metric-label">Gross</div><div class="metric-val" style="font-size:17px">'+fmt(selected.gross)+'</div></div><div class="metric"><div class="metric-label">Deductions</div><div class="metric-val" style="font-size:17px;color:var(--red)">'+fmt(selected.totalDed)+'</div></div><div class="metric"><div class="metric-label">Net</div><div class="metric-val" style="font-size:17px;color:var(--green)">'+fmt(selected.net)+'</div></div><div class="metric"><div class="metric-label">Employer Cost</div><div class="metric-val" style="font-size:17px;color:var(--blue)">'+fmt(selected.employerCost)+'</div></div></div><div style="overflow-x:auto"><table><thead><tr><th>Component</th><th>Formula</th><th>Rule / Version</th><th>Legal or Policy Source</th><th>Amount</th></tr></thead><tbody>'+selected.calculationTrace.map(function(line){return '<tr><td><strong>'+esc(line.code)+'</strong><div style="font-size:10px;color:var(--txt3)">'+esc(line.name)+'</div></td><td style="font-size:11px">'+esc(line.formula||'Configured amount')+'</td><td><code>'+esc(line.ruleCode||'')+' v'+esc(line.ruleVersion||1)+'</code></td><td style="font-size:11px">'+esc(line.legalSource||'')+'</td><td class="mono" style="font-weight:700;color:'+(line.type==='earning'?'var(--green)':'var(--red)')+'">'+(line.type==='earning'?'+':'−')+fmt(line.amount)+'</td></tr>';}).join('')+'</tbody></table></div>'+((selected.validationIssues||[]).length?'<div style="margin-top:10px;padding:9px 11px;border-radius:7px;background:var(--amber-bg);color:var(--amber-txt);font-size:11px"><strong>Validation:</strong> '+selected.validationIssues.map(function(issue){return esc(issue.code+': '+issue.message);}).join(' · ')+'</div>':'')+'</div>';
  }
  function adminNav(active){var tabs=[['rulebook','Rulebook'],['statutory','Statutory Versions'],['components','Pay Components'],['calendar','Entity & Calendar'],['validation','Validation Center'],['workflow','Workflow & Locking'],['audit','Audit & Retro']];return '<div class="tabs" style="margin-bottom:1rem">'+tabs.map(function(item){return '<div class="tab '+(active===item[0]?'active':'')+'" onclick="window._govSub=\''+item[0]+'\';render()">'+item[1]+'</div>';}).join('')+'<div style="margin-left:auto"><button class="btn btn-sm" onclick="window._payrollAdminMode=\'core\';render()">Core setup</button></div></div>';}
  function rulebookView(){
    var grouped={};PAYROLL_RULEBOOK.forEach(function(rule){(grouped[rule.code]=grouped[rule.code]||[]).push(rule);});
    return '<div class="card"><div class="card-hd"><div><div class="card-title">Effective-Dated Payroll Rulebook</div><div class="card-sub">Never overwrite an active rate. Create, approve, and activate a new version.</div></div><button class="btn btn-primary btn-sm" onclick="runPayrollRuleSimulation()">Run rule simulation</button></div><div style="overflow-x:auto"><table><thead><tr><th>Rule</th><th>Source</th><th>Effective</th><th>Value</th><th>Version</th><th>Status</th><th>Action</th></tr></thead><tbody>'+Object.keys(grouped).sort().map(function(code){return grouped[code].sort(function(a,b){return b.version-a.version;}).map(function(rule,index){return '<tr><td><strong>'+esc(rule.code)+'</strong><div style="font-size:10px;color:var(--txt3)">'+esc(rule.name)+'</div></td><td style="font-size:11px">'+esc(rule.source)+'</td><td class="mono" style="font-size:11px">'+rule.effectiveFrom+(rule.effectiveTo?' → '+rule.effectiveTo:' onward')+'</td><td class="mono">'+rule.value+'</td><td>v'+rule.version+'</td><td><span class="badge '+(rule.status==='active'?'b-approved':rule.status==='draft'?'b-pending':'b-info')+'">'+rule.status+'</span></td><td>'+(index===0?'<div class="action-row"><button class="btn btn-sm" onclick="createPayrollRuleVersion(\''+rule.code+'\')">New version</button>'+(rule.status==='draft'?'<button class="btn btn-sm btn-success" onclick="approvePayrollRule('+rule.id+')">Approve</button>':'')+(rule.status==='approved'?'<button class="btn btn-sm btn-primary" onclick="activatePayrollRule('+rule.id+')">Activate</button>':'')+'</div>':'')+'</td></tr>';}).join('');}).join('')+'</tbody></table></div></div>'+simulationView();
  }
  function simulationView(){var rows=window._ruleSimulation||[];if(!rows.length)return'';return '<div class="card"><div class="card-title" style="margin-bottom:8px">Rule Simulation Results</div><table><thead><tr><th>Scenario</th><th>Employee</th><th>Gross</th><th>Net</th><th>Exceptions</th></tr></thead><tbody>'+rows.map(function(row){return '<tr><td>'+esc(row.scenario)+'</td><td>'+esc(row.employee)+'</td><td class="mono">'+fmt(row.gross)+'</td><td class="mono">'+fmt(row.net)+'</td><td>'+row.issues+'</td></tr>';}).join('')+'</tbody></table></div>';}
  function statutoryView(){var cards=[['SSS','15% total · 10% ER / 5% EE','MSC ₱5,000–₱35,000','SSS Circular 2024-006','01 Jan 2025'],['PhilHealth','5% total · equal sharing','MBS floor ₱10,000 · ceiling ₱100,000','PhilHealth Advisory 2025-0002','01 Jan 2025'],['Pag-IBIG','1% / 2% EE · 2% ER','Configured MFS ₱10,000','Pag-IBIG effective schedule','01 Feb 2024'],['BIR','TRAIN withholding tables','Daily, weekly, semi-monthly, monthly, annual','RR 11-2018 Annex E','01 Jan 2023'],['De Minimis','Category-based limits','Rice ₱2,500 monthly; other categories configurable','BIR RR 29-2025','01 Jan 2026']];return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem">'+cards.map(function(card){return '<div class="card" style="margin:0"><div class="card-hd"><div><div class="card-title">'+card[0]+'</div><div class="card-sub">Effective '+card[4]+'</div></div><span class="badge b-approved">Active</span></div><div style="font-size:13px;font-weight:700;margin-bottom:5px">'+card[1]+'</div><div style="font-size:11px;color:var(--txt2)">'+card[2]+'</div><div style="font-size:10px;color:var(--txt3);margin-top:8px">Source: '+card[3]+'</div></div>';}).join('')+'</div><div style="padding:10px 12px;background:var(--amber-bg);color:var(--amber-txt);border-radius:8px;margin-top:12px;font-size:11px">Rates remain effective-dated and configurable. Payroll administrators must validate newly issued agency schedules before activating a replacement version.</div>';}
  function componentsView(){return '<div class="card"><div class="card-hd"><div><div class="card-title">Pay Component Classification</div><div class="card-sub">Names never determine tax treatment; each code carries explicit flags.</div></div></div><div style="overflow-x:auto"><table><thead><tr><th>Code</th><th>Component</th><th>Class</th><th>Taxable</th><th>De Minimis</th><th>Annualized</th><th>Agency / Link</th></tr></thead><tbody>'+INCOME_TYPES.map(function(item){return '<tr><td><code>'+esc(item.code)+'</code></td><td>'+esc(item.name)+'</td><td><span class="badge b-info">'+esc(item.cat)+'</span></td><td>'+(item.taxable?'Yes':'No')+'</td><td>'+(item.deminimis?'Yes':'No')+'</td><td>'+(item.annualize?'Yes':'No')+'</td><td>'+esc(item.agency||item.attendanceCode||'—')+'</td></tr>';}).join('')+'</tbody></table></div></div>';}
  function calendarView(){return '<div class="card"><div class="card-hd"><div><div class="card-title">Legal Entity Payroll Identity</div><div class="card-sub">Government registrations and banking remain maintained in Company Settings.</div></div><button class="btn btn-sm" onclick="goView(\'company\')">Open Company Settings</button></div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px"><div><div class="metric-label">Registered Name</div><strong>'+esc(COMPANY.registeredName||COMPANY.name||'—')+'</strong></div><div><div class="metric-label">TIN</div><strong>'+esc(COMPANY.tin||'—')+'</strong></div><div><div class="metric-label">RDO</div><strong>'+esc(COMPANY.rdo||'—')+'</strong></div><div><div class="metric-label">Currency</div><strong>'+esc(COMPANY.currency||'PHP')+'</strong></div></div></div><div class="card"><div class="card-title" style="margin-bottom:8px">Payroll Calendar and Cutoff Controls</div><div style="overflow-x:auto"><table><thead><tr><th>Period</th><th>Attendance</th><th>Adjustment Cutoff</th><th>Approval Deadline</th><th>Bank File</th><th>Funding</th><th>Pay Date</th><th>Lock Date</th></tr></thead><tbody>'+PAY_PERIODS.map(function(period){return '<tr><td><strong>'+esc(period.label)+'</strong><div class="mono" style="font-size:10px">'+period.from+' → '+period.to+'</div></td><td class="mono" style="font-size:10px">'+(period.attendanceFrom||period.from)+' → '+(period.attendanceTo||period.to)+'</td><td>'+period.adjustmentCutoff+'</td><td>'+period.approvalDeadline+'</td><td>'+period.bankFileDate+'</td><td>'+period.fundingDeadline+'</td><td><strong>'+period.releaseDate+'</strong></td><td>'+period.lockDate+'</td></tr>';}).join('')+'</tbody></table></div></div>';}
  function validationView(){var issues=validationInventory();return '<div class="metrics"><div class="metric"><div class="metric-label">Blockers</div><div class="metric-val" style="color:var(--red)">'+issues.filter(function(i){return i.severity==='blocker';}).length+'</div></div><div class="metric"><div class="metric-label">Warnings</div><div class="metric-val" style="color:var(--amber)">'+issues.filter(function(i){return i.severity==='warning';}).length+'</div></div><div class="metric"><div class="metric-label">Employees Checked</div><div class="metric-val">'+USERS.filter(function(e){return e.role==='employee';}).length+'</div></div></div><div class="card"><table><thead><tr><th>Scope</th><th>Severity</th><th>Control</th><th>Finding</th></tr></thead><tbody>'+(issues.length?issues.map(function(issue){return '<tr><td>'+esc(issue.employee)+'</td><td><span class="badge '+(issue.severity==='blocker'?'b-rejected':'b-pending')+'">'+issue.severity+'</span></td><td><code>'+esc(issue.code)+'</code></td><td>'+esc(issue.message)+'</td></tr>';}).join(''):'<tr><td colspan="4" class="empty-state">All configured validation checks passed.</td></tr>')+'</tbody></table></div>';}
  function workflowView(){var pending=PAYROLLS.filter(function(run){return run.status==='pending_approval';});return '<div class="card"><div class="card-title" style="margin-bottom:12px">Maker–Checker–Approver Workflow</div><div style="display:grid;grid-template-columns:repeat('+PAYROLL_WORKFLOW.length+',1fr);gap:8px">'+PAYROLL_WORKFLOW.map(function(stage,index){return '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg)"><div style="font-size:10px;color:var(--txt3)">STEP '+(index+1)+'</div><div style="font-size:12px;font-weight:700;margin-top:3px">'+esc(stage.label)+'</div></div>';}).join('')+'</div><div style="font-size:11px;color:var(--txt3);margin-top:10px">The same user is blocked from consecutive stages. Platform-admin emergency overrides require confirmation and are written to the audit trail.</div></div><div class="card"><div class="card-title" style="margin-bottom:8px">Runs in Governance</div><table><thead><tr><th>Period</th><th>Group</th><th>Status / Stage</th><th>Prepared By</th><th>Audit Steps</th><th>Control</th></tr></thead><tbody>'+(PAYROLLS.length?PAYROLLS.slice().reverse().map(function(run){return '<tr><td class="mono">'+run.from+' – '+run.to+'</td><td>'+esc(run.groupName||'')+'</td><td><span class="badge '+(run.status==='locked'?'b-approved':'b-pending')+'">'+esc(workflowLabel(run))+'</span></td><td>'+esc(run.preparedBy||'—')+'</td><td>'+((run.workflow||[]).length)+'</td><td>'+(run.status==='pending_approval'?'<button class="btn btn-sm btn-success" onclick="approvePayroll('+run.id+')">Advance approval</button>':run.status==='locked'&&!(run.reopenRequest&&run.reopenRequest.status==='pending')?'<button class="btn btn-sm" onclick="requestPayrollReopen('+run.id+')">Request reopen</button>':'—')+'</td></tr>';}).join(''):'<tr><td colspan="6" class="empty-state">No payroll runs yet.</td></tr>')+'</tbody></table></div>';}
  function auditView(){var combined=PAYROLL_AUDIT.map(function(item){return Object.assign({source:'Payroll'},item);}).concat(PAYROLL_RULE_AUDIT.map(function(item){return Object.assign({source:'Rulebook'},item);})).sort(function(a,b){return String(b.at).localeCompare(String(a.at));});return '<div class="card"><div class="card-hd"><div><div class="card-title">Immutable Payroll Audit Trail</div><div class="card-sub">Posted results are corrected by reversal or retro variance, never silent editing.</div></div><span class="badge b-info">'+combined.length+' events</span></div><div style="overflow-x:auto"><table><thead><tr><th>Date / Time</th><th>Source</th><th>Action</th><th>User</th><th>Details</th></tr></thead><tbody>'+(combined.length?combined.slice(0,100).map(function(item){return '<tr><td class="mono" style="font-size:10px">'+esc(item.at||'')+'</td><td>'+esc(item.source)+'</td><td><code>'+esc(item.action||'')+'</code></td><td>'+esc(item.by||'')+'</td><td style="font-size:11px">'+esc(item.notes||item.details||'')+'</td></tr>';}).join(''):'<tr><td colspan="5" class="empty-state">No audit events yet.</td></tr>')+'</tbody></table></div></div><div class="card"><div class="card-title">Retroactive Correction Structure</div><div class="card-sub" style="margin-bottom:8px">Every correction stores original amount, corrected amount, variance, source period, processing period, and tax/contribution impact.</div><div style="font-size:12px;color:var(--txt2)">Use Payroll → Adjustments for prior-period corrections. Approved adjustments flow into a new payroll calculation trace and preserve the original locked result.</div></div>';}
  function governancePage(){var active=window._govSub||'rulebook';var content=active==='rulebook'?rulebookView():active==='statutory'?statutoryView():active==='components'?componentsView():active==='calendar'?calendarView():active==='validation'?validationView():active==='workflow'?workflowView():auditView();var top=['Dashboard','Compute','Adjustments','13th Month','Final Pay','Reports','Configuration'];return '<div class="page-header"><div><div class="page-title">Payroll Rulebook & Control Center</div><div class="page-sub">Effective-dated rules · calculation trace · validation · maker–checker–approver · immutable audit</div></div></div><div class="tabs">'+top.map(function(label,index){return '<div class="tab '+(tab===index?'active':'')+'" onclick="goTab('+index+')">'+label+'</div>';}).join('')+'</div>'+adminNav(active)+content;}

  var basePgPayroll=pgPayroll;
  window.pgPayroll=pgPayroll=function(){
    if(tab===6&&(window._payrollAdminMode||'governance')==='governance')return governancePage();
    var html=basePgPayroll();
    if(tab===0)html+=governanceDashboard();
    if(tab===1)html=html.replace(/Approve & lock/g,'Advance approval')+tracePanel();
    if(tab===6)html=html.replace('<div class="card">','<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btn-sm btn-primary" onclick="window._payrollAdminMode=\'governance\';render()">Open Rulebook & Governance</button></div><div class="card">');
    return html.replace(/Approve & lock/g,'Advance approval');
  };

  window.collectPayrollGovernanceState=function(){return {rulebook:PAYROLL_RULEBOOK,ruleAudit:PAYROLL_RULE_AUDIT,retro:PAYROLL_RETRO,workflow:PAYROLL_WORKFLOW};};
  window.applyPayrollGovernanceState=function(saved){if(!saved)return;replace(PAYROLL_RULEBOOK,saved.rulebook);replace(PAYROLL_RULE_AUDIT,saved.ruleAudit);replace(PAYROLL_RETRO,saved.retro);replace(PAYROLL_WORKFLOW,saved.workflow);nextRuleId=PAYROLL_RULEBOOK.reduce(function(max,rule){return Math.max(max,rule.id||0);},0)+1;};
  function replace(target,value){if(!Array.isArray(value))return;target.length=0;target.push.apply(target,value);}
  render();
}());
