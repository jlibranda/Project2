/* Pure BIR 1601-C reporting helpers. Browser global + CommonJS for tests. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BIR1601CCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function money(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function reportingMonth(date) {
    var value = String(date || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(0, 7) : '';
  }

  function runMonth(run) {
    return run.bir1601CMonth || reportingMonth(run.releaseDate || run.on || run.to);
  }

  function finalPayMonth(record) {
    return record.bir1601CMonth || reportingMonth(record.releaseDate || record.releasedAt);
  }

  function annualizedTermination(input) {
    var priorTaxable = Number(input.priorTaxable) || 0;
    var previousEmployerTaxable = Number(input.previousEmployerTaxable) || 0;
    var finalTaxable = Number(input.finalTaxable) || 0;
    var priorTaxWithheld = Number(input.priorTaxWithheld) || 0;
    var previousEmployerTaxWithheld = Number(input.previousEmployerTaxWithheld) || 0;
    var annualTaxable = money(priorTaxable + previousEmployerTaxable + finalTaxable);
    var annualTax = money(input.taxFunction(annualTaxable));
    var adjustment = money(annualTax - priorTaxWithheld - previousEmployerTaxWithheld);
    return {
      annualTaxable: annualTaxable,
      annualTax: annualTax,
      adjustment: adjustment,
      withholding: money(Math.max(0, adjustment)),
      refund: money(Math.max(0, -adjustment))
    };
  }

  function aggregate(month, runs, finalPays) {
    var entries = [];
    (runs || []).filter(function (run) {
      return (run.status === 'approved' || run.status === 'locked') && run.includeIn1601C !== false && runMonth(run) === month;
    }).forEach(function (run) {
      (run.items || []).forEach(function (item) {
        var mandatory = money((item.sss || 0) + (item.ph || 0) + (item.pi || 0));
        var taxable = money(item.taxableCompensation || 0);
        var gross = money(item.gross || 0);
        var annualBenefitExempt = money(item.annualBenefitExempt || 0);
        var annualBenefitTaxable = money(item.annualBenefitTaxable || 0);
        var totalNonTaxable = money(Math.max(0, gross - taxable));
        entries.push({
          source: run.type === '13th-month' ? '13th Month Payroll' : 'Regular Payroll',
          sourceId: run.id,
          employeeId: item.empId,
          employeeNo: item.eid || '',
          employeeName: item.name || '',
          releaseDate: run.releaseDate || run.on || '',
          gross: gross,
          mandatory: mandatory,
          annualBenefitExempt: annualBenefitExempt,
          annualBenefitTaxable: annualBenefitTaxable,
          otherNonTaxable: money(Math.max(0, totalNonTaxable - mandatory - annualBenefitExempt)),
          totalNonTaxable: totalNonTaxable,
          taxable: taxable,
          tax: money(item.tax || 0),
          taxRefund: money(item.taxRefund || 0),
          netTax: money((item.tax || 0) - (item.taxRefund || 0))
        });
      });
    });
    (finalPays || []).filter(function (record) {
      return record.status === 'released' && record.includeIn1601C !== false && finalPayMonth(record) === month;
    }).forEach(function (record) {
      entries.push({
        source: 'Final Pay', sourceId: record.id, employeeId: record.empId,
        employeeNo: record.eid || '', employeeName: record.employeeName || '',
        releaseDate: record.releaseDate || '', gross: money(record.grossFP), mandatory: 0,
        annualBenefitExempt: money(record.annualBenefitExempt || 0),
        annualBenefitTaxable: money(record.annualBenefitTaxable || 0),
        otherNonTaxable: money(Math.max(0,Number(record.nonTaxableCompensation||0)-Number(record.annualBenefitExempt||0))),
        totalNonTaxable: money(record.nonTaxableCompensation),
        taxable: money(record.taxableCompensation), tax: money(record.taxWithheld),
        taxRefund: money(record.taxRefund),
        netTax: money((record.taxWithheld || 0) - (record.taxRefund || 0))
      });
    });
    function sum(key) { return money(entries.reduce(function (total, row) { return total + (Number(row[key]) || 0); }, 0)); }
    var netTax = sum('netTax');
    return {
      month: month, entries: entries,
      regularRunCount: new Set(entries.filter(function (e) { return e.source !== 'Final Pay'; }).map(function (e) { return e.sourceId; })).size,
      finalPayCount: entries.filter(function (e) { return e.source === 'Final Pay'; }).length,
      totalCompensation: sum('gross'), mandatoryContributions: sum('mandatory'),
      annualBenefitExempt:sum('annualBenefitExempt'), annualBenefitTaxable:sum('annualBenefitTaxable'),
      otherNonTaxable: sum('otherNonTaxable'), totalNonTaxable: sum('totalNonTaxable'),
      taxableCompensation: sum('taxable'), totalTaxesWithheld: sum('tax'),
      annualizationRefunds: sum('taxRefund'), taxRequiredForRemittance: money(Math.max(0, netTax)),
      excessAnnualizationCredit: money(Math.max(0, -netTax))
    };
  }

  return {money:money, reportingMonth:reportingMonth, runMonth:runMonth, annualizedTermination:annualizedTermination, aggregate:aggregate};
}));
