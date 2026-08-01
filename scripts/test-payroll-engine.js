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

console.log('Payroll rule engine tests passed.');
