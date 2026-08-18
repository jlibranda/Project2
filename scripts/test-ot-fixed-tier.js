'use strict';

const assert = require('node:assert/strict');
const { computeFixedTierOTPay } = require('../public/ot-fixed-tier.js');

// Baseline tiers: first 2 hrs = P500, succeeding = P50/hr, both prorated, no minimum gate.
const prorated = { firstHours: 2, firstAmount: 500, prorateFirstTier: true, firstTierMinimumMinutes: 0, succeedingRate: 50, prorateSucceedingHours: true, succeedingMinimumMinutes: 0 };

assert.equal(computeFixedTierOTPay(0, prorated), 0);
assert.equal(computeFixedTierOTPay(2, prorated), 500, 'exactly the first tier boundary pays the full first-tier amount');
assert.equal(computeFixedTierOTPay(1, prorated), 250, 'half the first tier, prorated, pays half the first-tier amount');
assert.equal(computeFixedTierOTPay(2 + 10 / 60, prorated), 500 + (10 / 60) * 50, '2h10m: 500 + 10/60 x 50 (rounding to centavos is the caller\'s job, not this pure function\'s)');
assert.equal(computeFixedTierOTPay(2.25, prorated), 512.5, '2h15m succeeding prorates by the quarter hour');
assert.equal(computeFixedTierOTPay(3, prorated), 550, '3h: 500 + 1h x 50');

// prorateFirstTier: false -- all-or-nothing. Falling short of the full first-tier hours pays
// nothing for that tier; only fully completing it earns the flat amount.
const flatFirst = Object.assign({}, prorated, { prorateFirstTier: false });
assert.equal(computeFixedTierOTPay(1, flatFirst), 0, '1h of a 2h first tier, not prorated, earns nothing');
assert.equal(computeFixedTierOTPay(1.9, flatFirst), 0, '1h54m still short of the full 2h tier earns nothing');
assert.equal(computeFixedTierOTPay(2, flatFirst), 500, 'exactly completing the first tier earns the flat amount');
assert.equal(computeFixedTierOTPay(2.5, flatFirst), 500 + 25, 'first tier flat once completed, succeeding still prorates by default');

// prorateSucceedingHours: false -- succeeding pay only in completed whole hours, floored down.
const flatSucceeding = Object.assign({}, prorated, { prorateSucceedingHours: false });
assert.equal(computeFixedTierOTPay(2.5, flatSucceeding), 500, '30 min of succeeding time, not a full hour, earns nothing extra');
assert.equal(computeFixedTierOTPay(2 + 100 / 60, flatSucceeding), 550, '1h40m succeeding pays for 1 completed hour only, not 1.667');
assert.equal(computeFixedTierOTPay(4, flatSucceeding), 500 + 100, '2h succeeding, both fully completed, pays for both hours');

// Both tiers flat/all-or-nothing at once.
const bothFlat = Object.assign({}, prorated, { prorateFirstTier: false, prorateSucceedingHours: false });
assert.equal(computeFixedTierOTPay(1.5, bothFlat), 0, 'first tier not completed => zero, regardless of succeeding rules');
assert.equal(computeFixedTierOTPay(2, bothFlat), 500, 'first tier completed exactly, no succeeding time yet');
assert.equal(computeFixedTierOTPay(2 + 59 / 60, bothFlat), 500, 'succeeding time short of 1h, floored to zero');
assert.equal(computeFixedTierOTPay(3, bothFlat), 550, 'succeeding time exactly 1h, pays for that completed hour');

// Minimum-minutes gate on a prorated tier: a gate, not a deduction -- once cleared, the FULL
// time worked so far is paid proportionally, not just the excess past the minimum.
const firstTierGated = Object.assign({}, prorated, { firstTierMinimumMinutes: 30 });
assert.equal(computeFixedTierOTPay(20 / 60, firstTierGated), 0, '20 min, below the 30-min minimum, pays nothing');
assert.equal(computeFixedTierOTPay(45 / 60, firstTierGated), 500 * (45 / 120), '45 min clears the 30-min gate: the FULL 45 min is prorated, not just the 15 min past the gate');

const succeedingGated = Object.assign({}, prorated, { succeedingMinimumMinutes: 15 });
assert.equal(computeFixedTierOTPay(2 + 10 / 60, succeedingGated), 500, '10 min of succeeding time, below the 15-min minimum, pays nothing extra');
assert.equal(computeFixedTierOTPay(2 + 50 / 60, succeedingGated), 500 + 50 * (50 / 60), '50 min clears the 15-min gate: the FULL 50 min is prorated, not just the 35 min past the gate');

// A zero minimum (the default) means proration starts the instant the tier boundary is
// crossed -- no extra grace beyond the tier structure itself.
assert.equal(computeFixedTierOTPay(2 + 1 / 60, prorated), 500 + 50 / 60, '1 minute past the boundary, with a zero minimum, is already prorated');

// firstHours of 0 (misconfigured) skips first-tier logic entirely and treats all time as
// succeeding, respecting whichever succeeding mode is configured.
const noFirstTier = Object.assign({}, prorated, { firstHours: 0 });
assert.equal(computeFixedTierOTPay(1.5, noFirstTier), 75, 'firstHours=0: all 1.5h treated as succeeding, prorated');
const noFirstTierFlat = Object.assign({}, flatSucceeding, { firstHours: 0 });
assert.equal(computeFixedTierOTPay(1.5, noFirstTierFlat), 50, 'firstHours=0 with flat succeeding: floors to 1 completed hour');

console.log('OT fixed-tier tests passed.');
