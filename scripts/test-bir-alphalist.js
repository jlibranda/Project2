'use strict';
const assert = require('assert');
const BIR2316Pdf = require('../public/bir-2316-pdf.js');
const AlphalistCore = require('../public/bir-alphalist-core.js');

function main() {
  const employees = [
    { id: 1, eid: 'EMP-001', firstName: 'Juan', middleName: 'Santos', lastName: 'Dela Cruz', tin: '123-456-789-000', rdo: '43' },
    { id: 2, eid: 'EMP-002', firstName: 'Ana', middleName: '', lastName: 'Reyes', tin: '234-567-890-000', rdo: '43' },
    { id: 3, eid: 'EMP-003', firstName: 'No', middleName: '', lastName: 'Compensation', tin: '345-678-901-000', rdo: '43' } // no runs this year -- must be excluded
  ];
  const company = { registeredName: 'Example Company, Inc.', taxIdentificationNo: '987-654-321-000', registeredAddress: '456 Corporate Avenue, Makati City' };
  const runs = [
    {
      status: 'locked', taxYear: 2026, from: '2026-01-01', to: '2026-12-31',
      items: [
        { empId: 1, gross: 500000, taxableCompensation: 390000, annualBenefitExempt: 70000, annualBenefitTaxable: 10000, sss: 15000, ph: 9000, pi: 6000, tax: 22500, taxRefund: 0,
          calculationTrace: [{ type: 'earning', code: 'BASIC', name: 'Basic Pay', taxable: true, amount: 380000 }, { type: 'earning', code: 'MOBILE', name: 'Mobile Allowance', taxable: true, amount: 10000 }] },
        { empId: 2, gross: 200000, taxableCompensation: 150000, annualBenefitExempt: 20000, annualBenefitTaxable: 0, sss: 10000, ph: 5000, pi: 3000, tax: 500, taxRefund: 0,
          calculationTrace: [{ type: 'earning', code: 'BASIC', name: 'Basic Pay', taxable: true, amount: 150000 }] }
      ]
    }
  ];
  const taxDueFunction = (value) => value * 0.05;

  const schedule = AlphalistCore.buildSchedule1(BIR2316Pdf, employees, company, 2026, runs, () => null, taxDueFunction);

  assert.strictEqual(schedule.rows.length, 2, 'Employee with no compensation this year must be excluded');
  assert.ok(schedule.rows.every(r => r.eid !== 'EMP-003'));

  // Alphabetical by last name -- Dela Cruz before Reyes.
  assert.strictEqual(schedule.rows[0].lastName, 'Dela Cruz');
  assert.strictEqual(schedule.rows[0].seq, 1);
  assert.strictEqual(schedule.rows[1].lastName, 'Reyes');
  assert.strictEqual(schedule.rows[1].seq, 2);

  const juan = schedule.rows[0];
  assert.strictEqual(juan.grossCompensation, 500000);
  // The row must reconcile internally exactly like the 2316 it's sourced from.
  assert.strictEqual(juan.totalNonTaxable + juan.totalTaxable, juan.grossCompensation);
  assert.strictEqual(juan.taxWithheld, 22500);

  assert.strictEqual(schedule.totals.grossCompensation, 700000);
  assert.strictEqual(schedule.totals.taxWithheld, 23000);
  assert.strictEqual(schedule.totals.grossCompensation, schedule.totals.totalNonTaxable + schedule.totals.totalTaxable);

  const csv = AlphalistCore.toCsvRows(schedule);
  assert.strictEqual(csv[0].length, AlphalistCore.SCHEDULE_1_HEADERS.length, 'Header row and data rows must have the same column count');
  assert.strictEqual(csv.length, 1 /*header*/ + 2 /*rows*/ + 1 /*blank*/ + 1 /*total*/);
  const totalRow = csv[csv.length - 1];
  assert.strictEqual(totalRow[0], 'TOTAL');
  assert.strictEqual(totalRow[7], 700000);

  console.log('BIR Alphalist tests passed.');
}

main();
