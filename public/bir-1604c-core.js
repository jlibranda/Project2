/* Pure BIR 1604-C (Annual Information Return of Income Taxes Withheld on Compensation)
   aggregation helpers. Browser global + CommonJS for tests. Built entirely on top of
   BIR1601CCore.aggregate() -- the annual return is, by definition, the sum of the same 12
   monthly 1601-C aggregates already computed from approved/locked payroll and released final
   pay, so this file adds no new source-of-truth logic, only a year-wide rollup + monthly
   schedule. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BIR1604CCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function money(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // core1601 is the required BIR1601CCore module (passed in explicitly rather than read off a
  // global, so this stays testable/CommonJS-friendly the same way the rest of this codebase's
  // "core" modules are).
  function aggregateYear(core1601, year, runs, finalPays) {
    year = Number(year);
    var months = [];
    var employeeIds = {};
    for (var m = 1; m <= 12; m++) {
      var monthKey = year + '-' + String(m).padStart(2, '0');
      var agg = core1601.aggregate(monthKey, runs, finalPays);
      agg.entries.forEach(function (entry) { employeeIds[entry.employeeId] = true; });
      months.push({
        month: monthKey, monthName: MONTH_NAMES[m - 1],
        totalCompensation: agg.totalCompensation, totalNonTaxable: agg.totalNonTaxable,
        taxableCompensation: agg.taxableCompensation, totalTaxesWithheld: agg.totalTaxesWithheld,
        annualizationRefunds: agg.annualizationRefunds, taxRequiredForRemittance: agg.taxRequiredForRemittance,
        entryCount: agg.entries.length
      });
    }
    function sum(key) { return money(months.reduce(function (total, mo) { return total + (Number(mo[key]) || 0); }, 0)); }
    return {
      year: year, months: months,
      employeeCount: Object.keys(employeeIds).length,
      totalCompensation: sum('totalCompensation'), totalNonTaxable: sum('totalNonTaxable'),
      taxableCompensation: sum('taxableCompensation'), totalTaxesWithheld: sum('totalTaxesWithheld'),
      annualizationRefunds: sum('annualizationRefunds'), taxRequiredForRemittance: sum('taxRequiredForRemittance')
    };
  }

  return { money: money, MONTH_NAMES: MONTH_NAMES, aggregateYear: aggregateYear };
}));
