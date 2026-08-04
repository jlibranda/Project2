const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PDFLib = require('../public/vendor/pdf-lib.min.js');
const BIR1601CPdf = require('../public/bir-1601c-pdf.js');

async function main() {
  const data = BIR1601CPdf.buildData({
    month: '2026-12',
    company: {
      registeredName: 'Example Company, Inc.', taxIdentificationNo: '987-654-321-000', rdo: '43',
      registeredAddress: '456 Corporate Avenue, Makati City', zipCode: '1200', contactNumber: '0281234567',
      emailAddress: 'payroll@example.ph', withholdingAgentCategory: 'private', authorizedAgent: 'Maria Santos', authorizedAgentTitle: 'Payroll Manager'
    },
    report: {
      totalCompensation: 528790, annualBenefitExempt: 70000, deMinimis: 12000,
      mandatoryContributions: 30000, otherNonTaxable: 8000, totalNonTaxable: 120000,
      taxableCompensation: 408790, taxableNotSubjectToWithholding: 0, totalTaxesWithheld: 43854,
      annualizationRefunds: 1500
    }
  });
  assert.strictEqual(data.month, '122026');
  assert.strictEqual(data.rdo, '043');
  assert.strictEqual(BIR1601CPdf.normalizeRdo('RDO 7'), '007');
  assert.strictEqual(data.item21, 120000);
  assert.strictEqual(data.item24, 408790);
  assert.strictEqual(data.item26, -1500);
  assert.strictEqual(data.item27, 42354);

  const template = fs.readFileSync(path.join(__dirname, '..', 'public', 'forms', 'bir-form-1601c-jan-2018.pdf'));
  const bytes = await BIR1601CPdf.render(template, data, PDFLib);
  assert.strictEqual(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF');
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 2);

  const outputDir = path.join(__dirname, '..', 'output', 'pdf');
  fs.mkdirSync(outputDir, {recursive: true});
  const outputPath = path.join(outputDir, 'BIR_1601C_sample_2026-12.pdf');
  fs.writeFileSync(outputPath, bytes);
  console.log('BIR 1601-C PDF mapping test passed:', outputPath);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
