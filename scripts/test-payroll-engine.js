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

console.log('Payroll rule engine tests passed.');
