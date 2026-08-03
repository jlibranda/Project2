'use strict';
const assert = require('assert');
const core = require('../public/payroll-preview-core');

const drafts = [
  {empId:1,eid:'EMP-001',name:'Ana Santos',pos:'Developer',department:'IT',net:12000,applyStatutory:true,calculationTrace:[{type:'earning',code:'BASIC',name:'Basic Pay',amount:10000},{type:'earning',code:'MOBILE',name:'Mobile Allowance',amount:500},{type:'statutory',code:'SSS',name:'SSS',amount:500,employerAmount:900},{type:'deduction',code:'LATE',name:'Late',amount:100}]},
  {empId:2,eid:'EMP-002',name:'Ben Cruz',pos:'Analyst',department:'Finance',net:0,applyStatutory:false,_edited:true,validationIssues:[{severity:'blocker'}],calculationTrace:[{type:'earning',code:'BASIC',name:'Basic Pay',amount:9000},{type:'earning',code:'ADJ',name:'Bonus Adjustment',amount:1000,ruleCode:'RETRO_ADJUSTMENT'}]}
];
assert.deepStrictEqual(core.terms('EMP-001\nEMP-002'),['emp-001','emp-002']);
assert.deepStrictEqual(core.filterDrafts(drafts,{search:'EMP-001\nBen Cruz'}).map(x=>x.empId),[1,2]);
assert.deepStrictEqual(core.filterDrafts(drafts,{department:'IT'}).map(x=>x.empId),[1]);
assert.deepStrictEqual(core.filterDrafts(drafts,{status:'blockers'}).map(x=>x.empId),[2]);
assert.deepStrictEqual(core.filterDrafts(drafts,{status:'adjustments'}).map(x=>x.empId),[2]);
assert.equal(core.paginate([1,2,3],2,2).items[0],3);
assert.equal(core.paginate([1,2,3],9,2).page,2);
assert.deepStrictEqual(core.componentColumns(drafts,'earning',['BASIC']).map(x=>x.code),['MOBILE','ADJ']);
const mobile=core.componentColumns(drafts,'earning',['BASIC']).find(x=>x.code==='MOBILE');
assert.equal(core.lineAmount(drafts[0],mobile),500);
assert.equal(core.employerAmount(drafts[0],'SSS'),900);
console.log('Payroll preview register tests passed.');
