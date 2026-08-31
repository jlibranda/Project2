'use strict';

const assert = require('node:assert/strict');
const engine = require('../public/payroll-rule-engine.js');
const timekeeping = require('../public/timekeeping-core.js');

const employee = {id:10,eid:'EMP-010',name:'Payroll Test',type:'regular',rate:1000,salaryPM:22000,hoursPerDay:8,tin:'123',sss:'123',ph:'123',pi:'123',bank:'Test Bank',bankAccount:'123',city:'Manila'};
const group = {code:'SEMI',freq:'semi-monthly',taxMethod:'semi-monthly',statutoryTiming:'every-2nd'};
const period = {from:'2026-08-01',to:'2026-08-15',cutoff1:true,cutoff2:false};
const rules = [
  {code:'OT_REGULAR_DAY',status:'active',effectiveFrom:'2025-01-01',effectiveTo:'2026-07-31',version:1,value:1.25,priority:100,coverage:{},source:'Old rule'},
  {code:'OT_REGULAR_DAY',status:'active',effectiveFrom:'2026-08-01',effectiveTo:'',version:2,value:1.30,priority:100,coverage:{},source:'New rule'},
  {code:'NIGHT_DIFFERENTIAL',status:'active',effectiveFrom:'2025-01-01',effectiveTo:'',version:1,value:.10,priority:100,coverage:{},source:'DOLE'},
  {code:'PROTECTED_NET_PAY',status:'active',effectiveFrom:'2025-01-01',effectiveTo:'',version:1,value:5000,priority:100,coverage:{},source:'Policy'}
];

assert.equal(engine.selectRule(rules,'OT_REGULAR_DAY','2026-08-15',{employee,group,period}).version,2,'latest effective rule must be selected');
assert.equal(engine.statutoryFactor(group,period),0,'Every 2nd cutoff must not deduct contributions on the first cutoff');
assert.equal(engine.statutoryFactor(group,{from:'2026-08-16',to:'2026-08-31',cutoff1:false,cutoff2:true}),1,'Every 2nd cutoff must deduct the full monthly contribution on the second cutoff');
assert.equal(engine.statutoryFactor(group,{from:'2026-08-01',to:'2026-08-15',cutoff1:true,cutoff2:true}),0,'Semi-monthly dates must resolve an invalid dual-cutoff first period as cutoff 1');
assert.equal(engine.recurringAllowanceFactor({frequency:'quarterly',quarterlyPattern:'quarter-end'},group,{from:'2026-06-01',to:'2026-06-15',releaseDate:'2026-06-20'}),1,'Quarter-end recurring allowance must be included in a June release');
assert.equal(engine.recurringAllowanceFactor({frequency:'quarterly',quarterlyPattern:'quarter-end'},group,{from:'2026-05-01',to:'2026-05-15',releaseDate:'2026-05-20'}),0,'Quarter-end recurring allowance must be excluded outside Mar/Jun/Sep/Dec');
assert.equal(engine.recurringAllowanceFactor({frequency:'monthly',timing:'every-2nd'},group,{from:'2026-08-01',to:'2026-08-15',cutoff1:true,cutoff2:false}),0,'Monthly allowance assigned to a semi-monthly group must honor its selected payout cutoff');
const result = engine.calculate({
  employee,group,period,rules,baseBasic:11000,defaultDivisor:22,
  attendance:{records:[],presentDays:10,absentDays:1,lateMinutes:30,undertimeMinutes:15,otHours:2,ndHours:4,restDayHolidayHours:0},
  adjustments:[{id:1,adjType:'Retro Pay',amount:500,taxable:true,reason:'Prior-period correction'}],
  loans:[{id:1,type:'Company Loan',status:'active',monthly:20000,balance:30000,priority:60}],
  statutory:()=>({sssEE:0,sssER:0,phEE:0,phER:0,piEE:0,piER:0}),tax:()=>0
});

assert.equal(result.basic,11000);
assert.equal(result.ot,325,'OT must use the effective 130% rule');
assert.equal(result.nd,50);
assert.equal(result.attendanceDeduction,1093.75);
assert.ok(result.loan < 10000,'loan must be capped by available deduction capacity and protected net');
assert.equal(result.net,5000,'protected minimum net pay must be honored');
assert.ok(result.lines.every(line=>line.ruleCode&&line.ruleVersion&&line.legalSource),'every result line must retain a calculation source');
assert.ok(result.lines.some(line=>line.code==='ADJUST'&&line.sourceTransaction===1),'retro adjustment must keep its source transaction');
assert.equal(result.employerCost,result.gross,'employer cost must reconcile when employer contributions are zero');

const loanBase = {
  employee,period,rules:[],baseBasic:11000,defaultDivisor:22,
  attendance:{records:[],presentDays:10,absentDays:0,lateMinutes:0,undertimeMinutes:0,otHours:0,ndHours:0,restDayHolidayHours:0},
  adjustments:[],loans:[{id:2,type:'Company Loan',status:'active',monthly:1000,balance:5000}],
  statutory:()=>({sssEE:0,sssER:0,phEE:0,phER:0,piEE:0,piER:0}),tax:()=>0
};
const semiMonthlyLoan = engine.calculate({...loanBase,group});
const monthlyLoan = engine.calculate({...loanBase,group:{code:'MNTH',freq:'monthly',taxMethod:'monthly',statutoryTiming:'every-cutoff'},period:{from:'2026-08-01',to:'2026-08-31',cutoff1:true,cutoff2:true},baseBasic:22000});
assert.equal(semiMonthlyLoan.loan,500,'Semi-monthly payroll must deduct half of the monthly loan amortization per cutoff');
assert.equal(monthlyLoan.loan,1000,'Monthly payroll must deduct the full monthly loan amortization');

const contributionByFactor = (monthly,factor)=>({sssEE:1000*factor,sssER:2000*factor,phEE:500*factor,phER:500*factor,piEE:200*factor,piER:200*factor});
const firstCutoffStatutory = engine.calculate({...loanBase,group,loans:[],statutory:contributionByFactor});
const secondCutoffStatutory = engine.calculate({...loanBase,group,period:{from:'2026-08-16',to:'2026-08-31',cutoff1:false,cutoff2:true},loans:[],statutory:contributionByFactor});
assert.deepEqual([firstCutoffStatutory.sss,firstCutoffStatutory.ph,firstCutoffStatutory.pi],[0,0,0],'First cutoff statutory contributions must all be zero for Every 2nd timing');
assert.deepEqual([secondCutoffStatutory.sss,secondCutoffStatutory.ph,secondCutoffStatutory.pi],[1000,500,200],'Second cutoff must deduct the full monthly statutory contributions');

const recurringBase = {...loanBase,group,loans:[],adjustments:[],tax:()=>0,recurringAllowances:[
  {id:'RA-LOAD',payItemCode:'LOAD',name:'Load/Mobile Allowance',payoutAmount:500,taxable:false,deminimis:false},
  {id:'RA-RICE',payItemCode:'RICE',name:'Rice Subsidy',payoutAmount:1500,taxable:false,deminimis:true,exemptLimit:1250}
]};
const recurringResult = engine.calculate(recurringBase);
assert.equal(recurringResult.gross,13000,'eligible recurring allowances must be included in gross pay');
assert.equal(recurringResult.taxableCompensation,11250,'non-taxable allowance and de minimis exempt portion must be excluded from taxable compensation');
assert.ok(recurringResult.lines.some(line=>line.code==='LOAD'&&line.taxable===false),'Income Type classification must control recurring allowance taxability');
assert.ok(recurringResult.lines.some(line=>line.code==='RICE_TX'&&line.amount===250&&line.taxable===true),'de minimis excess must be split into a taxable line');
const excludedRecurring = engine.calculate({...recurringBase,recurringAllowances:[]});
assert.equal(excludedRecurring.gross,11000,'an excluded calendar period must be able to pass no recurring allowances');

const annualBenefitResult = engine.calculate({...loanBase,group,loans:[],baseBasic:11000,
  adjustments:[{id:91,payItemCode:'BONUS',adjType:'Performance Bonus',amount:50000,taxable:false,benefitTreatment:'annual-benefit-bucket'}],
  annualBenefitContext:{limit:90000,previousEmployerNonTaxable:60000,currentEmployerYtdNonTaxable:10000},tax:()=>0});
assert.equal(annualBenefitResult.annualBenefitQualified,50000,'qualified bonus must enter the combined annual benefit bucket');
assert.equal(annualBenefitResult.annualBenefitExempt,20000,'only the remaining P20,000 of the shared exemption may be non-taxable');
assert.equal(annualBenefitResult.annualBenefitTaxable,30000,'the P30,000 excess must be taxable in payroll');
assert.ok(annualBenefitResult.lines.some(line=>line.code==='BONUS_TX'&&line.amount===30000&&line.taxable),'taxable benefit excess must be visible in the calculation trace');

const decimalDivisorEmployee = {...employee,rate:1000,salaryPM:22000,dailyDivisor:22.1234};
const decimalDivisorResult = engine.calculate({
  employee:decimalDivisorEmployee,group,period,rules,baseBasic:11000,defaultDivisor:22,
  attendance:{records:[],presentDays:10,absentDays:1,lateMinutes:30,undertimeMinutes:15,otHours:2,ndHours:0,restDayHolidayHours:0},
  adjustments:[],loans:[],statutory:()=>({sssEE:0,sssER:0,phEE:0,phER:0,piEE:0,piER:0}),tax:()=>0
});
assert.equal(decimalDivisorResult.rates.dailyDivisor,22.1234,'the payroll engine must preserve all four divisor decimal places');
assert.equal(decimalDivisorResult.rates.daily,994.42,'daily rate must be derived from monthly salary divided by the configured decimal divisor');
assert.equal(decimalDivisorResult.ot,323.19,'OT must use the daily rate produced by the decimal divisor, not a cached profile rate');
assert.equal(decimalDivisorResult.attendanceDeduction,1087.65,'absence, late, and undertime must use the decimal-divisor daily and minute rates');

// otOverrideAmount lets the caller (governanceDraft, which computes Fixed Amount tiered OT
// pay from per-day/per-week attendance records the engine itself never sees) replace the
// standard percentage-of-hourly-rate OT_REG amount, while everything else about the line
// (quantity in hours, for reporting) stays intact.
const otOverrideBase = {
  employee,group,period,rules,baseBasic:11000,defaultDivisor:22,
  attendance:{records:[],presentDays:10,absentDays:0,lateMinutes:0,undertimeMinutes:0,otHours:5,ndHours:0,restDayHolidayHours:0},
  adjustments:[],loans:[],statutory:()=>({sssEE:0,sssER:0,phEE:0,phER:0,piEE:0,piER:0}),tax:()=>0
};
const percentageOt = engine.calculate(otOverrideBase);
const fixedTierOt = engine.calculate({...otOverrideBase,otOverrideAmount:1050});
assert.notEqual(percentageOt.ot,1050,'sanity check: the percentage formula would not coincidentally already equal the fixed-tier amount');
assert.equal(fixedTierOt.ot,1050,'otOverrideAmount must replace the percentage formula amount');
const otRegLine = fixedTierOt.lines.find(line=>line.code==='OT_REG');
assert.equal(otRegLine.quantity,5,'the OT_REG line must keep reporting actual OT hours even when the amount is overridden');
assert.equal(otRegLine.formula,'Fixed Amount (tiered) overtime pay per employee-configured tiers','the formula text must reflect the override, for the calculation trace');
const zeroOtOverride = engine.calculate({...otOverrideBase,attendance:{...otOverrideBase.attendance,otHours:0},otOverrideAmount:0});
assert.ok(!zeroOtOverride.lines.some(line=>line.code==='OT_REG'),'zero OT hours must still omit the OT_REG line entirely, override or not');

// exemptLateDeduction/exemptUndertimeDeduction are a per-employee payroll exception,
// independent of Schedule Type -- attendance stays untouched (the caller never alters
// attendance.lateMinutes/undertimeMinutes for this), only the deduction LINE is skipped.
const exemptAttendance = {records:[],presentDays:10,absentDays:0,lateMinutes:30,undertimeMinutes:15,otHours:0,ndHours:0,restDayHolidayHours:0};
const noExemptions = engine.calculate({employee,group,period,rules,baseBasic:11000,defaultDivisor:22,attendance:exemptAttendance,adjustments:[],loans:[],statutory:()=>({sssEE:0,sssER:0,phEE:0,phER:0,piEE:0,piER:0}),tax:()=>0});
assert.ok(noExemptions.lines.some(line=>line.code==='LATE'),'a non-exempt employee must still get the Late Deduction line');
assert.ok(noExemptions.lines.some(line=>line.code==='UNDERTIME'),'a non-exempt employee must still get the Undertime Deduction line');
const lateExemptEmployee = {...employee,exemptLateDeduction:true};
const lateExempt = engine.calculate({employee:lateExemptEmployee,group,period,rules,baseBasic:11000,defaultDivisor:22,attendance:exemptAttendance,adjustments:[],loans:[],statutory:()=>({sssEE:0,sssER:0,phEE:0,phER:0,piEE:0,piER:0}),tax:()=>0});
assert.ok(!lateExempt.lines.some(line=>line.code==='LATE'),'exemptLateDeduction must omit the Late Deduction line entirely');
assert.ok(lateExempt.lines.some(line=>line.code==='UNDERTIME'),'exemptLateDeduction must not affect the Undertime Deduction line');
assert.equal(lateExempt.attendanceDeduction,noExemptions.attendanceDeduction-noExemptions.lines.find(l=>l.code==='LATE').amount,'the exempted late amount must be fully removed from the attendance deduction total');
const bothExemptEmployee = {...employee,exemptLateDeduction:true,exemptUndertimeDeduction:true};
const bothExempt = engine.calculate({employee:bothExemptEmployee,group,period,rules,baseBasic:11000,defaultDivisor:22,attendance:exemptAttendance,adjustments:[],loans:[],statutory:()=>({sssEE:0,sssER:0,phEE:0,phER:0,piEE:0,piER:0}),tax:()=>0});
assert.equal(bothExempt.attendanceDeduction,0,'both toggles on, with no absences, must leave zero attendance deduction');

// ── Sixth-pass issue 19: TRUE end-to-end -- TimekeepingCore.periodSummary() feeding directly
// into PayrollRuleEngine.calculate() -- for a Half AM paid leave day with perfect PM attendance.
// Daily rate ₱1,000 (salaryPM 22000 ÷ divisor 22). Shift 09:00-18:00, break 12:00-13:00.
// This is the exact real-world call path (public/index.html's attendancePeriodSummary() wrapper
// feeds this same periodSummary() output straight into the payroll engine's `attendance` input)
// -- proves the fix flows through to an actual payroll run, not just the timekeeping layer alone.
const halfDayEmployee = {
  id: 60, eid: 'EMP-060', name: 'Half Day Payroll Test', type: 'regular', shiftId: 40,
  salaryPM: 22000, dailyDivisor: 22, hoursPerDay: 8, tin: '123', sss: '123', ph: '123', pi: '123',
  bank: 'Test Bank', bankAccount: '123', city: 'Manila'
};
const halfDayShiftDayForPayroll = { restDay: false, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' };
const halfDayShiftsForPayroll = [{
  id: 40, graceMinutes: 0,
  schedule: { mon: halfDayShiftDayForPayroll, tue: halfDayShiftDayForPayroll, wed: halfDayShiftDayForPayroll, thu: halfDayShiftDayForPayroll, fri: halfDayShiftDayForPayroll, sat: halfDayShiftDayForPayroll, sun: halfDayShiftDayForPayroll }
}];
const monthlyGroup = { code: 'MNTH', freq: 'monthly', taxMethod: 'monthly', statutoryTiming: 'every-cutoff' };
const monthlyPeriod = { from: '2026-08-01', to: '2026-08-31', cutoff1: true, cutoff2: true };
const noStatutory = () => ({ sssEE: 0, sssER: 0, phEE: 0, phER: 0, piEE: 0, piER: 0 });

// 2026-08-03 is a Monday -- a genuine scheduled workday, not a rest day.
const perfectHalfAmRecord = {
  id: 700, eid: 60, date: '2026-08-03', tin: '13:00', tout: '18:00', status: 'present',
  approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_am',
  lateMinutes: 240, undertimeMinutes: 0, ot: 0, nd: 0, restDayHolidayHours: 0 // stale full-shift-based stored figure, must be ignored
};
const perfectHalfAmSummary = timekeeping.periodSummary([perfectHalfAmRecord], halfDayEmployee, '2026-08-03', '2026-08-03', halfDayShiftsForPayroll);
assert.equal(perfectHalfAmSummary.lateMinutes, 0, 'issue 19 setup: periodSummary reports zero late minutes for perfect Half AM PM attendance');
assert.equal(perfectHalfAmSummary.undertimeMinutes, 0);
const perfectHalfAmPayroll = engine.calculate({
  employee: halfDayEmployee, group: monthlyGroup, period: monthlyPeriod, rules: [], baseBasic: 22000, defaultDivisor: 22,
  attendance: perfectHalfAmSummary, adjustments: [], loans: [], statutory: noStatutory, tax: () => 0
});
assert.equal(perfectHalfAmPayroll.attendanceDeduction, 0, 'issue 19/7: perfect Half AM + valid PM attendance produces ZERO attendance deduction end-to-end (no absence, no late, no undertime)');
assert.ok(!perfectHalfAmPayroll.lines.some(l => l.code === 'LATE' || l.code === 'UNDERTIME' || l.code === 'ABSENT'), 'issue 19: no LATE/UNDERTIME/ABSENT deduction line exists at all for a fully payable half-day-leave day');

// Half PM mirror (issue 21): AM attendance 09:00-12:00, leave covers PM.
const perfectHalfPmRecord = {
  id: 701, eid: 60, date: '2026-08-04', tin: '09:00', tout: '12:00', status: 'present',
  approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: 'half_pm',
  lateMinutes: 0, undertimeMinutes: 360, ot: 0, nd: 0, restDayHolidayHours: 0 // stale full-shift-based stored figure, must be ignored
};
const perfectHalfPmSummary = timekeeping.periodSummary([perfectHalfPmRecord], halfDayEmployee, '2026-08-04', '2026-08-04', halfDayShiftsForPayroll);
const perfectHalfPmPayroll = engine.calculate({
  employee: halfDayEmployee, group: monthlyGroup, period: monthlyPeriod, rules: [], baseBasic: 22000, defaultDivisor: 22,
  attendance: perfectHalfPmSummary, adjustments: [], loans: [], statutory: noStatutory, tax: () => 0
});
assert.equal(perfectHalfPmPayroll.attendanceDeduction, 0, 'issue 21: perfect Half PM + valid AM attendance also produces ZERO attendance deduction end-to-end');

// Issue 22 end-to-end: Half AM leave, PM Time In 13:30 (30 min late) -- payroll deducts exactly
// 30 minutes' worth of pay at the minute rate, never a ~4.5h figure against the 09:00 shift start.
const lateHalfAmRecord = { ...perfectHalfAmRecord, id: 702, tin: '13:30', lateMinutes: 270 };
const lateHalfAmSummary = timekeeping.periodSummary([lateHalfAmRecord], halfDayEmployee, '2026-08-03', '2026-08-03', halfDayShiftsForPayroll);
const lateHalfAmPayroll = engine.calculate({
  employee: halfDayEmployee, group: monthlyGroup, period: monthlyPeriod, rules: [], baseBasic: 22000, defaultDivisor: 22,
  attendance: lateHalfAmSummary, adjustments: [], loans: [], statutory: noStatutory, tax: () => 0
});
// daily=1000, hourly=125, minute=125/60 -> 30 * (125/60) = 62.5
assert.equal(lateHalfAmPayroll.attendanceDeduction, 62.5, 'issue 22: payroll deducts exactly 30 minutes of late pay (₱62.50), never a full-morning-absence figure');
assert.ok(!lateHalfAmPayroll.lines.some(l => l.code === 'ABSENT'), 'issue 22: no absence line, only a Late Deduction line, for a half-day-leave date with a late (but valid) worked half');

// Issue 23 end-to-end: Half AM leave, PM Time Out 17:00 (60 min undertime).
const undertimeHalfAmRecord = { ...perfectHalfAmRecord, id: 703, tout: '17:00', lateMinutes: 0, undertimeMinutes: 60 };
const undertimeHalfAmSummary = timekeeping.periodSummary([undertimeHalfAmRecord], halfDayEmployee, '2026-08-03', '2026-08-03', halfDayShiftsForPayroll);
const undertimeHalfAmPayroll = engine.calculate({
  employee: halfDayEmployee, group: monthlyGroup, period: monthlyPeriod, rules: [], baseBasic: 22000, defaultDivisor: 22,
  attendance: undertimeHalfAmSummary, adjustments: [], loans: [], statutory: noStatutory, tax: () => 0
});
assert.equal(undertimeHalfAmPayroll.attendanceDeduction, 125, 'issue 23: payroll deducts exactly 60 minutes of undertime pay (₱125.00)');

// ── Follow-up pass: TRUE end-to-end paid/unpaid half-day leave -- TimekeepingCore.periodSummary()
// feeding directly into PayrollRuleEngine.calculate() (issue 23, tests A-G). Daily rate ₱1,000
// (salaryPM 22000 ÷ divisor 22), same halfDayEmployee/halfDayShiftsForPayroll/monthlyGroup/
// monthlyPeriod fixtures as the perfect/late/undertime tests above.
function unpaidLeavePayrollScenario(date, dayType, tin, tout, status, paidLeaveFraction, unpaidLeaveFraction, absentWorkFraction) {
  const record = {
    id: 800 + Math.round(Math.random() * 1000), eid: 60, date, tin, tout, status,
    approvalStatus: 'approved', leaveFraction: 0.5, leaveDayType: dayType,
    paidLeaveFraction, unpaidLeaveFraction, absentWorkFraction,
    lateMinutes: 0, undertimeMinutes: 0, ot: 0, nd: 0, restDayHolidayHours: 0
  };
  const summary = timekeeping.periodSummary([record], halfDayEmployee, date, date, halfDayShiftsForPayroll);
  const payroll = engine.calculate({
    employee: halfDayEmployee, group: monthlyGroup, period: monthlyPeriod, rules: [], baseBasic: 22000, defaultDivisor: 22,
    attendance: summary, adjustments: [], loans: [], statutory: noStatutory, tax: () => 0
  });
  return { summary, payroll };
}

// Test A -- fully paid Half AM + perfect PM (2026-08-03 is a Monday).
let r = unpaidLeavePayrollScenario('2026-08-03', 'half_am', '13:00', '18:00', 'present', 0.5, 0, 0);
assert.equal(r.summary.unpaidLeaveDays, 0, 'Test A: fully paid + perfect work -> unpaidLeaveDays 0');
assert.equal(r.payroll.attendanceDeduction, 0, 'Test A: fully paid + perfect work -> attendanceDeduction ₱0');
assert.ok(!r.payroll.lines.some(l => l.code === 'UNPAID_LEAVE'), 'Test A: no UNPAID_LEAVE line at all');

// Test B -- fully unpaid Half AM + perfect PM.
r = unpaidLeavePayrollScenario('2026-08-04', 'half_am', '13:00', '18:00', 'present', 0, 0.5, 0);
assert.equal(r.summary.unpaidLeaveDays, 0.5, 'Test B: fully unpaid + perfect work -> unpaidLeaveDays 0.5');
assert.equal(r.payroll.attendanceDeduction, 500, 'Test B: unpaid leave deduction = ₱500');
assert.equal(r.payroll.lines.find(l => l.code === 'UNPAID_LEAVE').amount, 500, 'Test B: UNPAID_LEAVE line itself is exactly ₱500');
assert.ok(!r.payroll.lines.some(l => l.code === 'ABSENT'), 'Test B: absence deduction = ₱0 (no ABSENT line -- the other half was genuinely worked)');

// Test C -- 0.25 paid / 0.25 unpaid + perfect PM.
r = unpaidLeavePayrollScenario('2026-08-05', 'half_am', '13:00', '18:00', 'present', 0.25, 0.25, 0);
assert.equal(r.summary.unpaidLeaveDays, 0.25, 'Test C: 0.25 paid / 0.25 unpaid + perfect work -> unpaidLeaveDays 0.25');
assert.equal(r.payroll.attendanceDeduction, 250, 'Test C: unpaid leave deduction = ₱250');
assert.ok(!r.payroll.lines.some(l => l.code === 'ABSENT'), 'Test C: absence deduction = ₱0');

// Test D -- fully paid Half AM + NO PM work. periodSummary alone cannot show the full picture here
// (the paid credit-back is a separate payroll ADJUSTMENT created by leave-service.js at
// finalization, not part of attendance.unpaidLeaveDays) -- so this proves the attendance-only half
// of the equation: a full-day absence deduction of exactly ₱1,000, with unpaidLeaveDays
// contributing nothing extra (never ₱1,500 total once the ₱500 leave-pay credit is later applied
// on top, netting to the expected ₱500 total -- see scripts/test-security.js's real-approval-flow
// coverage of the ₱500 net result end to end through the actual leave-decision endpoint).
r = unpaidLeavePayrollScenario('2026-08-06', 'half_am', '', '', 'absent', 0.5, 0, 0.5);
assert.equal(r.summary.unpaidLeaveDays, 0, 'Test D: fully paid + no work -> unpaidLeaveDays 0 (not double-counted against the full-day absence)');
assert.equal(r.payroll.attendanceDeduction, 1000, 'Test D: attendance-only deduction is the full ₱1,000 absence (the ₱500 leave-pay credit-back is a separate adjustment, netting to ₱500 total)');
assert.ok(!r.payroll.lines.some(l => l.code === 'UNPAID_LEAVE'), 'Test D: no UNPAID_LEAVE line (the paid leave half has no unpaid loss of its own)');

// Test E -- fully unpaid Half AM + NO PM work. Expected total deduction ₱1,000 exactly (no
// separate credit-back exists for an unpaid leave portion when the work half is already absent --
// the single full-day absence deduction already covers the entire date).
r = unpaidLeavePayrollScenario('2026-08-07', 'half_am', '', '', 'absent', 0, 0.5, 0.5);
assert.equal(r.summary.unpaidLeaveDays, 0, 'Test E: fully unpaid + no work -> unpaidLeaveDays 0 (already covered by the full-day absence)');
assert.equal(r.payroll.attendanceDeduction, 1000, 'Test E: total deduction is exactly ₱1,000, never ₱1,500');
assert.ok(!r.payroll.lines.some(l => l.code === 'UNPAID_LEAVE'), 'Test E: no UNPAID_LEAVE line');

// Test F -- partial leave + 30-minute PM late.
r = unpaidLeavePayrollScenario('2026-08-10', 'half_am', '13:30', '18:00', 'present', 0.25, 0.25, 0);
assert.equal(r.summary.lateMinutes, 30, 'Test F: 30 minutes late on the worked half');
assert.equal(r.payroll.lines.find(l => l.code === 'UNPAID_LEAVE').amount, 250, 'Test F: ₱250 unpaid leave');
assert.equal(r.payroll.lines.find(l => l.code === 'LATE').amount, 62.5, 'Test F: PLUS a 30-minute late deduction (₱62.50)');
assert.equal(r.payroll.attendanceDeduction, 312.5, 'Test F: combined ₱250 + ₱62.50 = ₱312.50, no full absence deduction');

// Test G -- partial leave + 60-minute PM undertime.
r = unpaidLeavePayrollScenario('2026-08-11', 'half_am', '13:00', '17:00', 'present', 0.25, 0.25, 0);
assert.equal(r.summary.undertimeMinutes, 60, 'Test G: 60 minutes undertime on the worked half');
assert.equal(r.payroll.lines.find(l => l.code === 'UNPAID_LEAVE').amount, 250, 'Test G: ₱250 unpaid leave');
assert.equal(r.payroll.lines.find(l => l.code === 'UNDERTIME').amount, 125, 'Test G: PLUS a 60-minute undertime deduction (₱125)');
assert.equal(r.payroll.attendanceDeduction, 375, 'Test G: combined ₱250 + ₱125 = ₱375, no full absence deduction');

// Half PM mirrors of Tests A/B (2026-08-12 is a Wednesday).
r = unpaidLeavePayrollScenario('2026-08-12', 'half_pm', '09:00', '12:00', 'present', 0.5, 0, 0);
assert.equal(r.payroll.attendanceDeduction, 0, 'Half PM mirror of Test A: fully paid + perfect AM work -> ₱0 attendance deduction');
r = unpaidLeavePayrollScenario('2026-08-13', 'half_pm', '09:00', '12:00', 'present', 0, 0.5, 0);
assert.equal(r.payroll.attendanceDeduction, 500, 'Half PM mirror of Test B: fully unpaid + perfect AM work -> ₱500 unpaid leave deduction');

console.log('Payroll rule engine tests passed.');
