(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PayrollRuleEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function money(value) { return Math.round((Number(value) || 0) * 100) / 100; }
  function number(value) { return Number(value) || 0; }
  function dateApplies(rule, date) {
    return (!rule.effectiveFrom || rule.effectiveFrom <= date) && (!rule.effectiveTo || rule.effectiveTo >= date);
  }
  function coverageApplies(rule, context) {
    var coverage = rule.coverage || {};
    if (coverage.employmentTypes && coverage.employmentTypes.length && coverage.employmentTypes.indexOf(context.employee.type) < 0) return false;
    if (coverage.payrollGroups && coverage.payrollGroups.length && coverage.payrollGroups.indexOf(context.group.code) < 0) return false;
    if (coverage.locations && coverage.locations.length && coverage.locations.indexOf(context.employee.workLocation || context.employee.city) < 0) return false;
    if (coverage.otEligible === true && context.employee.otEligible === false) return false;
    return true;
  }
  function selectRule(rules, code, date, context) {
    return (rules || []).filter(function (rule) {
      return rule.code === code && rule.status === 'active' && dateApplies(rule, date) && coverageApplies(rule, context);
    }).sort(function (left, right) {
      if (left.priority !== right.priority) return number(right.priority) - number(left.priority);
      if (left.effectiveFrom !== right.effectiveFrom) return String(right.effectiveFrom).localeCompare(String(left.effectiveFrom));
      return number(right.version) - number(left.version);
    })[0] || null;
  }
  function ruleValue(rules, code, date, context, fallback) {
    var rule = selectRule(rules, code, date, context);
    return { rule: rule, value: rule ? number(rule.value) : fallback };
  }
  function frequencyFactor(group) {
    var frequency = group && group.freq || 'monthly';
    if (frequency === 'semi-monthly') return 0.5;
    if (frequency === 'weekly') return 12 / 52;
    if (frequency === 'bi-weekly') return 12 / 26;
    return 1;
  }
  function cutoffNumber(group, period) {
    period = period || {};
    var first = period.cutoff1 === true;
    var second = period.cutoff2 === true;
    if (first && !second) return 1;
    if (second && !first) return 2;
    var fromDay = period.from ? Number(String(period.from).slice(8,10)) : 0;
    var toDay = period.to ? Number(String(period.to).slice(8,10)) : 0;
    if ((group && group.freq) === 'semi-monthly') {
      if (toDay && toDay <= 15) return 1;
      if (fromDay > 15) return 2;
    }
    if (first && second) return 'both';
    return null;
  }
  function statutoryFactor(group, period) {
    var timing = group.statutoryTiming || 'every-cutoff';
    var cutoff = cutoffNumber(group,period);
    if (timing === 'every-1st') return cutoff === 1 || cutoff === 'both' ? 1 : 0;
    if (timing === 'every-2nd') return cutoff === 2 || cutoff === 'both' ? 1 : 0;
    return timing === 'every-cutoff' ? frequencyFactor(group) : 1;
  }
  function addLine(lines, input) {
    var line = Object.assign({ quantity: 1, rate: 0, multiplier: 1, amount: 0, taxable: false, employerAmount: 0 }, input);
    line.amount = money(line.amount);
    line.employerAmount = money(line.employerAmount);
    lines.push(line);
    return line.amount;
  }
  function lineFromRule(rule, fallbackCode, fallbackSource) {
    return {
      ruleCode: rule ? rule.code : fallbackCode,
      ruleVersion: rule ? rule.version : 1,
      legalSource: rule ? rule.source : fallbackSource,
      formula: rule ? rule.formula : ''
    };
  }
  function maxLoanDeduction(loans, scheduled, capacity) {
    var remainingCapacity = Math.max(0, capacity);
    var total = 0;
    var details = [];
    (loans || []).filter(function (loan) { return loan.status === 'active'; }).sort(function (a,b) {
      return number(a.priority || 60) - number(b.priority || 60);
    }).forEach(function (loan) {
      var due = Math.min(number(loan.balance), number(loan.monthly) * scheduled);
      var actual = Math.min(due, remainingCapacity);
      remainingCapacity -= actual;
      total += actual;
      details.push({ id:loan.id, type:loan.type, scheduled:money(due), deducted:money(actual), carriedForward:money(due-actual), balanceBefore:money(loan.balance) });
    });
    return { amount:money(total), details:details };
  }
  function validateEmployee(employee) {
    var issues = [];
    if (!employee.eid) issues.push({severity:'blocker',code:'EMP_ID_MISSING',message:'Employee ID is missing'});
    if (!employee.salaryPM && !employee.rate) issues.push({severity:'blocker',code:'SALARY_MISSING',message:'No salary record'});
    if (!employee.tin) issues.push({severity:'warning',code:'TIN_MISSING',message:'TIN is missing'});
    if (!employee.sss) issues.push({severity:'warning',code:'SSS_MISSING',message:'SSS number is missing'});
    if (!employee.ph) issues.push({severity:'warning',code:'PHIC_MISSING',message:'PhilHealth number is missing'});
    if (!employee.pi) issues.push({severity:'warning',code:'HDMF_MISSING',message:'Pag-IBIG MID is missing'});
    if (!employee.bank || !employee.bankAccount) issues.push({severity:'blocker',code:'BANK_MISSING',message:'Bank payment details are incomplete'});
    if (!employee.workLocation && !employee.city) issues.push({severity:'warning',code:'LOCATION_MISSING',message:'Work location is missing'});
    if (employee.effectiveTermDate && employee.hired && employee.effectiveTermDate < employee.hired) issues.push({severity:'blocker',code:'INVALID_SEPARATION',message:'Separation date is before hire date'});
    return issues;
  }
  function validateAttendance(records) {
    var issues = [];
    (records || []).forEach(function (record) {
      if ((record.tin && !record.tout) || (!record.tin && record.tout)) issues.push({severity:'blocker',code:'MISSING_PUNCH',date:record.date,message:'Missing Time In or Time Out'});
      if (number(record.ot) > 0 && record.approvalStatus !== 'approved') issues.push({severity:'blocker',code:'OT_NOT_APPROVED',date:record.date,message:'Overtime is not approved'});
      if (record.status === 'leave' && number(record.ot) > 0) issues.push({severity:'blocker',code:'LEAVE_OT_OVERLAP',date:record.date,message:'Leave and overtime overlap'});
    });
    return issues;
  }
  function calculate(input) {
    var employee = input.employee;
    var group = input.group;
    var period = input.period;
    var attendance = input.attendance || {records:[],absentDays:0,lateMinutes:0,undertimeMinutes:0,otHours:0,ndHours:0,presentDays:0,restDayHolidayHours:0};
    var context = {employee:employee,group:group,period:period};
    var date = period.to;
    var rules = input.rules || [];
    var lines = [];
    var daily = number(employee.rate);
    var monthly = number(employee.salaryPM) || daily * number(employee.dailyDivisor || input.defaultDivisor || 22);
    var divisor = number(employee.annualWorkdays || (daily ? monthly * 12 / daily : 261));
    if (!daily) daily = monthly * 12 / divisor;
    var hoursPerDay = number(employee.hoursPerDay || 8);
    var hourly = daily / hoursPerDay;
    var minute = hourly / 60;
    var baseBasic = number(input.baseBasic);
    var factor = frequencyFactor(group);

    addLine(lines,Object.assign({code:'BASIC',name:'Basic Pay',type:'earning',amount:baseBasic,taxable:true,rate:baseBasic,formula:group.freq==='semi-monthly'?'Monthly salary ÷ 2':'Configured payroll-frequency basic pay'},lineFromRule(selectRule(rules,'BASIC_PAY',date,context),'BASIC_PAY','Employment contract / company compensation policy')));

    var regularOt = ruleValue(rules,'OT_REGULAR_DAY',date,context,1.25);
    if (attendance.otHours) addLine(lines,Object.assign({code:'OT_REG',name:'Regular-Day Overtime',type:'earning',quantity:attendance.otHours,rate:hourly,multiplier:regularOt.value,amount:hourly*regularOt.value*attendance.otHours,taxable:true,formula:'Hourly rate × approved OT hours × '+regularOt.value},lineFromRule(regularOt.rule,'OT_REGULAR_DAY','Labor Code / DOLE')));

    var restPremium = ruleValue(rules,'REST_HOLIDAY_WORK',date,context,1.30);
    if (attendance.restDayHolidayHours) addLine(lines,Object.assign({code:'RDH',name:'Rest Day / Holiday Work',type:'earning',quantity:attendance.restDayHolidayHours,rate:hourly,multiplier:restPremium.value,amount:hourly*restPremium.value*attendance.restDayHolidayHours,taxable:true,formula:'Hourly rate × approved hours × '+restPremium.value},lineFromRule(restPremium.rule,'REST_HOLIDAY_WORK','Labor Code / DOLE')));

    var ndRule = ruleValue(rules,'NIGHT_DIFFERENTIAL',date,context,0.10);
    if (attendance.ndHours) addLine(lines,Object.assign({code:'ND',name:'Night Shift Differential',type:'earning',quantity:attendance.ndHours,rate:hourly,multiplier:ndRule.value,amount:hourly*ndRule.value*attendance.ndHours,taxable:true,formula:'Hourly rate × qualified NSD hours × '+ndRule.value},lineFromRule(ndRule.rule,'NIGHT_DIFFERENTIAL','Labor Code / DOLE')));

    var allowanceFactor = factor;
    if (number(employee.mobileAllowance)) addLine(lines,{code:'MOBILE',name:'Mobile Allowance',type:'earning',amount:number(employee.mobileAllowance)*allowanceFactor,taxable:true,formula:'Monthly allowance × payroll-frequency factor',ruleCode:'COMPONENT_MOBILE',ruleVersion:1,legalSource:'Company policy'});
    if (number(employee.riceAllowance)) {
      var riceRule = ruleValue(rules,'DEMINIMIS_RICE_MONTHLY',date,context,2500);
      var ricePaid = number(employee.riceAllowance)*allowanceFactor;
      var riceExempt = Math.min(ricePaid,riceRule.value*allowanceFactor);
      if (riceExempt) addLine(lines,Object.assign({code:'RICE',name:'Rice Subsidy – Non-Taxable',type:'earning',amount:riceExempt,taxable:false,formula:'Lower of benefit paid or remaining configured de minimis limit'},lineFromRule(riceRule.rule,'DEMINIMIS_RICE_MONTHLY','BIR RR 29-2025')));
      if (ricePaid>riceExempt) addLine(lines,{code:'RICE_TX',name:'Rice Subsidy – Taxable Excess',type:'earning',amount:ricePaid-riceExempt,taxable:true,formula:'Benefit paid − non-taxable portion',ruleCode:'DEMINIMIS_EXCESS',ruleVersion:1,legalSource:'BIR'});
    }
    (input.adjustments || []).forEach(function (adjustment) {
      var isDeduction = number(adjustment.amount) < 0;
      addLine(lines,{code:adjustment.payItemCode||'ADJUST',name:adjustment.adjType||'Payroll Adjustment',type:isDeduction?'deduction':'earning',amount:Math.abs(number(adjustment.amount)),taxable:!isDeduction&&adjustment.taxable!==false,formula:'Approved adjustment from source period',ruleCode:'RETRO_ADJUSTMENT',ruleVersion:1,legalSource:adjustment.reason||'Approved payroll adjustment',sourceTransaction:adjustment.id});
    });

    var absentRule = ruleValue(rules,'ABSENCE_DEDUCTION',date,context,1);
    if (attendance.absentDays) addLine(lines,Object.assign({code:'ABSENT',name:'Unpaid Absence',type:'deduction',quantity:attendance.absentDays,rate:daily,multiplier:absentRule.value,amount:daily*attendance.absentDays*absentRule.value,formula:'Daily rate × unpaid absence days'},lineFromRule(absentRule.rule,'ABSENCE_DEDUCTION','Labor standards / company attendance policy')));
    var lateRounding = ruleValue(rules,'LATE_ROUNDING_MINUTES',date,context,1).value;
    var lateMinutes = lateRounding>1?Math.ceil(number(attendance.lateMinutes)/lateRounding)*lateRounding:number(attendance.lateMinutes);
    if (lateMinutes) addLine(lines,{code:'LATE',name:'Late Deduction',type:'deduction',quantity:lateMinutes,rate:minute,amount:lateMinutes*minute,formula:'Chargeable late minutes × minute rate',ruleCode:'LATE_DEDUCTION',ruleVersion:1,legalSource:'Company attendance policy'});
    var utMinutes = number(attendance.undertimeMinutes);
    if (utMinutes) addLine(lines,{code:'UNDERTIME',name:'Undertime Deduction',type:'deduction',quantity:utMinutes,rate:minute,amount:utMinutes*minute,formula:'Chargeable undertime minutes × minute rate; no double deduction',ruleCode:'UNDERTIME_DEDUCTION',ruleVersion:1,legalSource:'Company attendance policy'});

    var credits = lines.filter(function (line) { return line.type === 'earning'; }).reduce(function (sum,line) { return sum+line.amount; },0);
    var attendanceDeductions = lines.filter(function (line) { return line.type === 'deduction'; }).reduce(function (sum,line) { return sum+line.amount; },0);
    var statFactor = statutoryFactor(group,period);
    var statutory = input.statutory(monthly,statFactor);
    addLine(lines,{code:'SSS',name:'SSS Employee Share',type:'statutory',amount:statutory.sssEE,employerAmount:statutory.sssER,formula:'Official effective-dated SSS contribution table × period factor',ruleCode:'SSS_2025',ruleVersion:1,legalSource:'SSS Circular 2024-006'});
    addLine(lines,{code:'PHIC',name:'PhilHealth Employee Share',type:'statutory',amount:statutory.phEE,employerAmount:statutory.phER,formula:'Monthly basic salary × 5% ÷ 2 × period factor, subject to floor/ceiling',ruleCode:'PHIC_2025',ruleVersion:1,legalSource:'PhilHealth Advisory 2025-0002'});
    addLine(lines,{code:'HDMF',name:'Pag-IBIG Employee Share',type:'statutory',amount:statutory.piEE,employerAmount:statutory.piER,formula:'Compensation base × configured rate × period factor',ruleCode:'HDMF_2024',ruleVersion:1,legalSource:'Pag-IBIG effective contribution schedule'});
    var taxableCredits = lines.filter(function (line) { return line.type === 'earning' && line.taxable; }).reduce(function (sum,line) { return sum+line.amount; },0);
    var taxableCompensation = Math.max(0,taxableCredits-statutory.sssEE-statutory.phEE-statutory.piEE);
    var tax = money(input.tax(taxableCompensation,group.taxMethod||group.freq));
    addLine(lines,{code:'TAX',name:'Withholding Tax',type:'statutory',amount:tax,formula:'BIR withholding table applied to taxable compensation after mandatory employee contributions',ruleCode:'BIR_ANNEX_E_2023',ruleVersion:1,legalSource:'BIR RR 11-2018 Annex E'});
    var mandatory = statutory.sssEE+statutory.phEE+statutory.piEE+tax;
    var protectedNetRule = ruleValue(rules,'PROTECTED_NET_PAY',date,context,0);
    var capacity = credits-attendanceDeductions-mandatory-protectedNetRule.value;
    var loanFrequencyFactor = frequencyFactor(group);
    var loanResult = maxLoanDeduction(input.loans,loanFrequencyFactor,capacity);
    if (loanResult.amount) addLine(lines,{code:'LOAN',name:'Loan Amortization',type:'deduction',amount:loanResult.amount,formula:(group.freq==='semi-monthly'?'Monthly amortization × 50% per cutoff':'Monthly amortization × payroll-frequency factor')+'; capped by balance and deduction capacity',ruleCode:'LOAN_WATERFALL',ruleVersion:1,legalSource:'Loan authorization / company policy'});
    var totalDeductions = money(attendanceDeductions+mandatory+loanResult.amount);
    var net = money(Math.max(0,credits-totalDeductions));
    var employerContributions = money(statutory.sssER+statutory.phER+statutory.piER);
    var issues = validateEmployee(employee).concat(validateAttendance(attendance.records));
    if (net === 0) issues.push({severity:'warning',code:'ZERO_NET',message:'Employee has zero net pay'});
    if (attendance.records.some(function (record) { return record.approvalStatus !== 'approved'; })) issues.push({severity:'blocker',code:'UNAPPROVED_ATTENDANCE',message:'Unapproved attendance exists in the payroll period'});
    return {
      rates:{monthly:money(monthly),daily:money(daily),hourly:money(hourly),minute:money(minute),annualWorkdays:money(divisor)},
      lines:lines,issues:issues,loanSchedule:loanResult.details,
      basic:money(baseBasic),ot:money(lines.filter(function(l){return l.code==='OT_REG'||l.code==='RDH';}).reduce(function(s,l){return s+l.amount;},0)),nd:money(lines.filter(function(l){return l.code==='ND';}).reduce(function(s,l){return s+l.amount;},0)),
      gross:money(credits),attendanceDeduction:money(attendanceDeductions),sss:money(statutory.sssEE),ph:money(statutory.phEE),pi:money(statutory.piEE),tax:tax,loan:loanResult.amount,totalDed:totalDeductions,net:net,
      taxableCompensation:money(taxableCompensation),employerContributions:employerContributions,employerCost:money(credits+employerContributions),statutoryFactor:statFactor
    };
  }
  return { money:money, selectRule:selectRule, frequencyFactor:frequencyFactor, cutoffNumber:cutoffNumber, statutoryFactor:statutoryFactor, validateEmployee:validateEmployee, validateAttendance:validateAttendance, calculate:calculate };
});
