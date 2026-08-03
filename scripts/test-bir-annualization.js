'use strict';
const assert=require('assert');
const core=require('../public/bir-annualization-core');

assert.equal(core.taxDue(250000,'annual'),0);
assert.equal(core.taxDue(300000,'annual'),7500);
assert.equal(core.taxDue(450000,'annual'),32500);
assert.equal(core.taxDue(50000,'monthly'),5208.4);
assert.equal(core.taxDue(25000,'semi-monthly'),2604.1);
const result=core.reconcile({currentTaxable:50000,ytdTaxable:300000,openingYtdTaxable:0,previousEmployerTaxable:100000,ytdTaxWithheld:20000,openingYtdTaxWithheld:0,previousEmployerTaxWithheld:5000,taxFunction:x=>core.taxDue(x,'annual')});
assert.deepStrictEqual(result,{currentTaxable:50000,ytdTaxable:300000,openingYtdTaxable:0,previousEmployerTaxable:100000,annualTaxable:450000,annualTax:32500,taxPaidBefore:25000,adjustment:7500,withholding:7500,refund:0});
const refund=core.reconcile({currentTaxable:10000,ytdTaxable:200000,ytdTaxWithheld:12000,taxFunction:x=>core.taxDue(x,'annual')});
assert.equal(refund.refund,12000);
assert.deepStrictEqual(core.validateProfile(null,2026,true),['Tax record for 2026 is missing. Confirm whether the employee had a previous employer.']);
assert.deepStrictEqual(core.validateProfile({year:2026,confirmed:true,hasPreviousEmployer:false},2026,true),[]);
console.log('BIR annualization tests passed.');
