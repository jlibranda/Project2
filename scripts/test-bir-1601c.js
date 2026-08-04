'use strict';
const assert = require('assert');
const core = require('../public/bir-1601c-core');

const runs = [
  {id:1,status:'locked',releaseDate:'2026-06-05',items:[{empId:1,eid:'E-1',name:'Ana',gross:30000,sss:1000,ph:750,pi:200,taxableCompensation:28050,tax:1082.50}]},
  {id:2,status:'pending_approval',releaseDate:'2026-06-20',items:[{gross:99999,tax:9999}]},
  {id:3,status:'locked',releaseDate:'2026-05-20',items:[{gross:15000,tax:0}]}
];
const finalPays = [
  {id:1,status:'released',releaseDate:'2026-06-18',empId:2,eid:'E-2',employeeName:'Ben',grossFP:50000,nonTaxableCompensation:20000,taxableCompensation:30000,taxWithheld:1500},
  {id:2,status:'draft',releaseDate:'2026-06-22',grossFP:100000,taxWithheld:10000}
];
const june = core.aggregate('2026-06', runs, finalPays);
assert.strictEqual(june.entries.length, 2, 'Only locked payroll and released final pay belong in June');
assert.strictEqual(june.totalCompensation, 80000);
assert.strictEqual(june.totalTaxesWithheld, 2582.50);
assert.strictEqual(june.annualizationRefunds, 0);
assert.strictEqual(june.taxRequiredForRemittance, 2582.50);
const refundMonth = core.aggregate('2026-06', [{id:5,status:'locked',bir1601CMonth:'2026-06',items:[{empId:1,gross:30000,taxableCompensation:30000,tax:0,taxRefund:500}]}], []);
assert.strictEqual(refundMonth.annualizationRefunds, 500);
assert.strictEqual(refundMonth.taxRequiredForRemittance, 0);
assert.strictEqual(refundMonth.excessAnnualizationCredit, 500);
assert.strictEqual(core.aggregate('2026-05', runs, finalPays).entries.length, 1);
const manualMonthRun = {id:4,status:'locked',releaseDate:'2026-06-30',bir1601CMonth:'2026-07',items:[{empId:3,eid:'E-3',name:'Cara',gross:20000,taxableCompensation:20000,tax:250}]};
assert.strictEqual(core.aggregate('2026-06',[manualMonthRun],[]).entries.length,0,'Manual BIR month must override the payment month');
assert.strictEqual(core.aggregate('2026-07',[manualMonthRun],[]).entries.length,1,'Run must appear in its manually selected BIR month');
const benefitMonth=core.aggregate('2026-12',[{id:6,status:'approved',bir1601CMonth:'2026-12',items:[{empId:4,gross:50000,taxableCompensation:30000,annualBenefitExempt:20000,annualBenefitTaxable:30000,tax:1000}]}],[]);
assert.strictEqual(benefitMonth.annualBenefitExempt,20000,'1601-C Item 17 control must aggregate the system-classified exempt benefit portion');
assert.strictEqual(benefitMonth.annualBenefitTaxable,30000,'the taxable excess must remain separately auditable');
const annualized = core.annualizedTermination({priorTaxable:300000,previousEmployerTaxable:100000,finalTaxable:50000,priorTaxWithheld:20000,previousEmployerTaxWithheld:5000,taxFunction:income=>income<=400000?22500:22500+(income-400000)*.20});
assert.deepStrictEqual(annualized,{annualTaxable:450000,annualTax:32500,adjustment:7500,withholding:7500,refund:0});
console.log('BIR 1601-C tests passed.');
