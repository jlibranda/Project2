(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.computeFixedTierOTPay = api.computeFixedTierOTPay;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Fixed Amount (tiered) Overtime Pay -- e.g. "first 2 hrs = P500, succeeding hrs = P50/hr".
  // Shared with payroll-governance.js's fixedTierOTPayAmount(), which drives the actual payroll
  // OT calculation via PayrollRuleEngine's otOverrideAmount.
  function computeFixedTierOTPay(hours, tiers) {
    var totalMinutes = Math.round(Math.max(0, Number(hours) || 0) * 60);
    if (!totalMinutes) return 0;
    var firstHours = Math.max(0, Number(tiers.firstHours) || 0);
    var firstMinutes = Math.round(firstHours * 60);
    var firstAmount = Number(tiers.firstAmount) || 0;
    var succeedingRate = Number(tiers.succeedingRate) || 0;
    if (!firstMinutes) return computeSucceedingTierPay(totalMinutes, succeedingRate, tiers);
    var firstTierMinutesWorked = Math.min(totalMinutes, firstMinutes);
    var firstTierPay;
    if (tiers.prorateFirstTier) {
      // Once the configured minimum is cleared, the FULL time worked so far is paid
      // proportionally -- the minimum is a gate, not a deduction from the paid time.
      var minMinutes = Math.max(0, Number(tiers.firstTierMinimumMinutes) || 0);
      firstTierPay = firstTierMinutesWorked < minMinutes ? 0 : firstAmount * (firstTierMinutesWorked / firstMinutes);
    } else {
      // Not prorated: the full first-tier amount is only earned by fully completing the
      // configured first-tier hours -- falling short of that pays nothing for this tier.
      firstTierPay = firstTierMinutesWorked >= firstMinutes ? firstAmount : 0;
    }
    var succeedingMinutesWorked = Math.max(0, totalMinutes - firstMinutes);
    var succeedingPay = computeSucceedingTierPay(succeedingMinutesWorked, succeedingRate, tiers);
    return firstTierPay + succeedingPay;
  }

  function computeSucceedingTierPay(succeedingMinutesWorked, succeedingRate, tiers) {
    if (!succeedingMinutesWorked) return 0;
    if (tiers.prorateSucceedingHours === false) {
      // Not prorated: succeeding time is only paid in completed whole hours, floored down --
      // less than a full additional hour earns nothing, and a partial hour past a completed
      // one still only pays for the completed hour(s).
      return Math.floor(succeedingMinutesWorked / 60) * succeedingRate;
    }
    // Default is prorated: once the configured minimum is cleared, the FULL succeeding time is
    // paid proportionally, same gate-not-deduction rule as the first tier above.
    var minMinutes = Math.max(0, Number(tiers.succeedingMinimumMinutes) || 0);
    return succeedingMinutesWorked < minMinutes ? 0 : succeedingRate * (succeedingMinutesWorked / 60);
  }

  return { computeFixedTierOTPay: computeFixedTierOTPay };
});
