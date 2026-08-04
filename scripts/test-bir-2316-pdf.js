const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PDFLib = require('../public/vendor/pdf-lib.min.js');
const BIR2316Pdf = require('../public/bir-2316-pdf.js');

async function main() {
  const employee = {
    id: 1, eid: 'EMP-001', firstName: 'Juan', middleName: 'Santos', lastName: 'Dela Cruz',
    tin: '123-456-789-000', rdo: 'RDO 043', permanentAddress: '123 Example Street, Quezon City',
    zipCode: '1100', bday: '1990-01-15', contact: '09171234567'
  };
  const run = {
    status: 'locked', taxYear: 2026, from: '2026-01-01', to: '2026-12-31',
    items: [{
      empId: 1, gross: 500000, taxableCompensation: 390000,
      annualBenefitExempt: 70000, annualBenefitTaxable: 10000,
      sss: 15000, ph: 9000, pi: 6000, tax: 22500, taxRefund: 0,
      calculationTrace: [
        {type:'earning', code:'BASIC', name:'Basic Pay', taxable:true, amount:380000},
        {type:'earning', code:'MOBILE', name:'Mobile Allowance', taxable:true, amount:30000},
        {type:'earning', code:'BONUS_TX', name:'Bonus – Taxable Excess', taxable:true, annualBenefitBucket:true, amount:10000},
        {type:'earning', taxable:false, ruleCode:'DEMINIMIS_RICE', amount:10000}
      ]
    }]
  };
  const data = BIR2316Pdf.buildData({
    employee,
    company: {registeredName:'Example Company, Inc.', taxIdentificationNo:'987-654-321-000', registeredAddress:'456 Corporate Avenue, Makati City', zipCode:'1200', employerType:'main'},
    profile: {previousEmployerName:'Prior Employer Corp.', previousEmployerTin:'111-222-333-000', previousEmployerAddress:'789 Former Road, Manila', previousEmployerZip:'1000', previousEmployerTaxable:100000, previousEmployerTaxWithheld:5000},
    year: 2026,
    runs: [run],
    taxDueFunction: value => value * 0.055
  });

  assert.strictEqual(data.employeeName, 'Dela Cruz, Juan Santos');
  assert.strictEqual(data.grossPresent, 500000);
  assert.strictEqual(data.totalNonTaxable + data.totalTaxablePresent, data.grossPresent);
  assert.strictEqual(data.taxablePresent + data.previousTaxable, data.grossTaxable);
  assert.strictEqual(data.presentTax + data.previousTax, data.totalTaxWithheld);
  assert.strictEqual(data.taxableBasic, 350000);
  assert.strictEqual(data.taxableTransportation, 30000);
  assert.strictEqual(data.taxableBenefit, 10000);
  assert.strictEqual(data.taxableBasic + data.taxableTransportation + data.taxableBenefit + data.otherTaxable, data.totalTaxablePresent);

  const template = fs.readFileSync(path.join(__dirname, '..', 'public', 'forms', 'bir-form-2316-sep-2021.pdf'));
  const bytes = await BIR2316Pdf.render(template, data, PDFLib);
  assert.strictEqual(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF');
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1);
  const pageText = Buffer.from(bytes).toString('latin1');
  assert.ok(!pageText.includes('123-456-789-000'), 'TIN must be plotted per box, not as one dashed string');

  const outputDir = path.join(__dirname, '..', 'output', 'pdf');
  fs.mkdirSync(outputDir, {recursive: true});
  const outputPath = path.join(outputDir, 'BIR_2316_sample_EMP-001_2026.pdf');
  fs.writeFileSync(outputPath, bytes);
  console.log('BIR 2316 PDF mapping test passed:', outputPath);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
