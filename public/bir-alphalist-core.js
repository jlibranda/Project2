/* BIR Alphalist (Schedule 1 -- Alphalist of Employees Other Than MWEs, With/Without Tax
   Withheld, filed as an attachment to Form 1604-C) row builder. Browser global + CommonJS.

   Reuses BIR2316Pdf.buildData() (passed in explicitly, not read off a global -- same
   dependency-injection style as BIR1604CCore.aggregateYear()) as the ONE place that classifies
   an employee's gross pay into the non-taxable/taxable buckets BIR requires, so a given
   employee's Schedule 1 row and their own 2316 certificate can never disagree -- they're
   literally computed by the same function.

   NOTE ON FORMAT: this produces the DATA content BIR's Alphalist requires (one row per
   employee, the same column breakdown Schedule 1 asks for), exported as a CSV worksheet via
   the same downloadCsv() convention already used for the 1601-C and 2316 "CSV worksheet"
   buttons elsewhere in this app. It is NOT a byte-for-byte .DAT file for BIR's own Alphalist
   Data Entry and Validation Module -- that tool's exact fixed-format file structure is
   versioned (currently v7.4) and specified in Revenue Memorandum Circular annexes this
   environment could not reach to verify byte-for-byte. Use this worksheet as the source data
   to key into that module (or into an accountant's own extract program) until that exact
   format is confirmed. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BIRAlphalistCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function money(value) { return Math.round((Number(value) || 0) * 100) / 100; }
  function clean(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }

  var SCHEDULE_1_HEADERS = [
    'Seq. No.', 'TIN', 'Last Name', 'First Name', 'Middle Name', 'RDO Code', 'Employment Status',
    'Gross Compensation Income',
    '13th Month Pay and Other Benefits (Non-Taxable)', 'De Minimis Benefits', 'SSS/GSIS/PHIC/HDMF Contributions & Union Dues (EE Share)', 'Salaries & Other Non-Taxable Compensation (P250,000 & Below / Statutory MW)', 'Total Non-Taxable/Exempt Compensation Income',
    'Basic Salary (Taxable)', 'Representation', 'Transportation', 'Cost of Living Allowance (COLA)', 'Fixed Housing Allowance', 'Other Taxable Compensation', 'Total Taxable Compensation Income',
    'Tax Due', 'Tax Withheld'
  ];

  // bir2316Pdf: the BIR2316Pdf module (its buildData is the single source of truth for the
  // non-taxable/taxable breakdown). employees: array of employee records. company: COMPANY.
  // year: tax year. allRuns: the full approved/locked PAYROLLS array (+ optional final-pay-
  // normalized runs), matching what generateOfficial2316PDF/bir2316RunsForEmployee already
  // pass per employee -- buildData filters internally by employee and year, so the same full
  // list can be reused for every row. profileForEmployee(emp): returns that employee's Tax
  // Year Record for `year` (or null). taxDueFunction(taxableIncome): annual BIR tax table.
  function buildSchedule1(bir2316Pdf, employees, company, year, allRuns, profileForEmployee, taxDueFunction) {
    var rows = [];
    (employees || []).forEach(function (emp) {
      var runsForEmp = typeof allRuns === 'function' ? allRuns(emp) : allRuns;
      var profile = (typeof profileForEmployee === 'function' ? profileForEmployee(emp) : null) || {};
      var data = bir2316Pdf.buildData({ employee: emp, company: company, profile: profile, year: year, runs: runsForEmp, taxDueFunction: taxDueFunction });
      // buildData's runsCount reflects how many runs exist for the YEAR, not for this specific
      // employee (an employee with zero items in every one of those runs still gets runsCount>0)
      // -- grossPresent is what actually reduces to zero when this employee has no compensation
      // to report for the year, so that's the real "nothing to report" signal.
      if (!data.grossPresent) return;
      rows.push({
        eid: emp.eid || '', tin: data.employeeTin, lastName: clean(emp.lastName), firstName: clean(emp.firstName), middleName: clean(emp.middleName),
        rdo: data.employeeRdo, employmentStatus: emp.active === false ? 'Separated' : 'Employed',
        grossCompensation: data.grossPresent,
        benefitExempt: data.benefitExempt, deMinimis: data.deMinimis, mandatory: data.mandatory, otherNonTaxable: data.otherNonTaxable, totalNonTaxable: data.totalNonTaxable,
        taxableBasic: data.taxableBasic, taxableRepresentation: data.taxableRepresentation, taxableTransportation: data.taxableTransportation, taxableCola: data.taxableCola, taxableHousing: data.taxableHousing,
        otherTaxable: money(data.taxableBenefit + data.taxableCommission + data.taxableProfitSharing + data.taxableDirectorFees + data.taxableHazard + data.taxableOvertime + data.otherTaxable),
        totalTaxable: data.totalTaxablePresent,
        taxDue: data.taxDue, taxWithheld: data.presentTax
      });
    });
    rows.sort(function (a, b) { return a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName); });
    rows.forEach(function (row, index) { row.seq = index + 1; });
    var totals = rows.reduce(function (t, r) {
      t.grossCompensation += r.grossCompensation; t.totalNonTaxable += r.totalNonTaxable; t.totalTaxable += r.totalTaxable;
      t.taxDue += r.taxDue; t.taxWithheld += r.taxWithheld; return t;
    }, { grossCompensation: 0, totalNonTaxable: 0, totalTaxable: 0, taxDue: 0, taxWithheld: 0 });
    Object.keys(totals).forEach(function (key) { totals[key] = money(totals[key]); });
    return { year: year, rows: rows, totals: totals };
  }

  function toCsvRows(schedule) {
    var out = [SCHEDULE_1_HEADERS.slice()];
    schedule.rows.forEach(function (r) {
      out.push([r.seq, r.tin, r.lastName, r.firstName, r.middleName, r.rdo, r.employmentStatus,
        r.grossCompensation, r.benefitExempt, r.deMinimis, r.mandatory, r.otherNonTaxable, r.totalNonTaxable,
        r.taxableBasic, r.taxableRepresentation, r.taxableTransportation, r.taxableCola, r.taxableHousing, r.otherTaxable, r.totalTaxable,
        r.taxDue, r.taxWithheld]);
    });
    out.push([]);
    out.push(['TOTAL', '', '', '', '', '', '', schedule.totals.grossCompensation, '', '', '', '', schedule.totals.totalNonTaxable, '', '', '', '', '', '', schedule.totals.totalTaxable, schedule.totals.taxDue, schedule.totals.taxWithheld]);
    return out;
  }

  return { SCHEDULE_1_HEADERS: SCHEDULE_1_HEADERS, buildSchedule1: buildSchedule1, toCsvRows: toCsvRows, money: money };
}));
