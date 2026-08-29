'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core1601 = require('../public/bir-1601c-core');
const core1604 = require('../public/bir-1604c-core');
const PDFLib = require('../public/vendor/pdf-lib.min.js');
const BIR1604CPdf = require('../public/bir-1604c-pdf.js');

async function main() {
  const runs = [
    {id:1,status:'locked',bir1601CMonth:'2026-01',taxYear:2026,items:[{empId:1,eid:'E-1',name:'Ana',gross:30000,sss:1000,ph:750,pi:200,taxableCompensation:28050,tax:1082.50}]},
    {id:2,status:'locked',bir1601CMonth:'2026-06',taxYear:2026,items:[{empId:1,eid:'E-1',name:'Ana',gross:30000,sss:1000,ph:750,pi:200,taxableCompensation:28050,tax:1082.50},{empId:2,eid:'E-2',name:'Ben',gross:20000,taxableCompensation:15000,tax:0}]},
    {id:3,status:'locked',bir1601CMonth:'2027-01',taxYear:2027,items:[{empId:1,gross:99999,taxableCompensation:99999,tax:9999}]} // different year, must not leak in
  ];
  const summary = core1604.aggregateYear(core1601, 2026, runs, []);

  assert.strictEqual(summary.year, 2026);
  assert.strictEqual(summary.months.length, 12);
  assert.strictEqual(summary.employeeCount, 2, 'Ana and Ben, deduped across their two 2026 runs');
  assert.strictEqual(summary.totalCompensation, 80000, '30000 (Jan, Ana) + 30000 (Jun, Ana) + 20000 (Jun, Ben)');
  assert.strictEqual(summary.totalTaxesWithheld, 2165);
  const jan = summary.months.find(m => m.month === '2026-01');
  assert.strictEqual(jan.totalCompensation, 30000);
  const jun = summary.months.find(m => m.month === '2026-06');
  assert.strictEqual(jun.totalCompensation, 50000);
  const feb = summary.months.find(m => m.month === '2026-02');
  assert.strictEqual(feb.totalCompensation, 0, 'A month with no run must still appear, zeroed, not be skipped');
  assert.strictEqual(summary.months[0].monthName, 'January');
  assert.strictEqual(summary.months[11].monthName, 'December');
  // 2027 data must never leak into the 2026 rollup.
  const only2026 = core1604.aggregateYear(core1601, 2026, runs, []);
  assert.strictEqual(only2026.totalCompensation, 80000);

  const data = BIR1604CPdf.buildData({
    company: {registeredName:'Example Company, Inc.', taxIdentificationNo:'987-654-321-000', rdo:'43', registeredAddress:'456 Corporate Avenue, Makati City', zipCode:'1200'},
    year: 2026, summary: summary
  });
  assert.strictEqual(data.employeeCount, 2);
  assert.strictEqual(data.totalCompensation, 80000);
  assert.strictEqual(data.months.length, 12);

  const bytes = await BIR1604CPdf.render(data, PDFLib);
  assert.strictEqual(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF');
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1);

  const outputDir = path.join(__dirname, '..', 'output', 'pdf');
  fs.mkdirSync(outputDir, {recursive: true});
  const outputPath = path.join(outputDir, 'BIR_1604C_sample_2026.pdf');
  fs.writeFileSync(outputPath, bytes);
  console.log('BIR 1604-C tests passed:', outputPath);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
