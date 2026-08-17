'use strict';

const assert = require('node:assert/strict');
const engine = require('../public/payroll-rule-engine.js');

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

console.log('Payroll rule engine tests passed.');
