// Reusable backend snapshot-completeness validator for a payroll run's historical-replay data.
//
// public/payroll-governance.js's lockPayrollRun() already runs the equivalent check client-side
// (payrollSnapshotCompleteness()) before allowing a run to lock. That's necessary but not
// sufficient: there is no dedicated server-authoritative lock endpoint yet (generic PUT /api/state
// is now forbidden from performing a pending_approval -> locked transition at all -- see
// server/payroll-immutability.js), so nothing server-side has ever actually run this check. This
// module exists so the FUTURE dedicated lock endpoint (the "next phase" this pass hands off to)
// has a single, real, importable validator to call instead of re-deriving the same field list a
// second time -- the same completeness rule server/leave-payroll-reconciliation.js's own
// checkReconciliationEligibility() already enforces when it later reads a locked run back.
//
// Kept as its own module (rather than folding into payroll-immutability.js) because "is this run
// allowed to lock" and "has an already-locked run been tampered with" are different questions,
// even though they both exist to protect the same underlying guarantee.
'use strict';

// Mirrors public/payroll-governance.js's payrollSnapshotCompleteness() field-for-field -- keep
// both in sync if either changes; this is the server-side copy since payroll-governance.js is
// browser-only code (DOM/prompt/confirm dependencies) that can't be required() from Node.
function validatePayrollSnapshotCompleteness(run) {
  const missing = [];
  (run && run.items || []).forEach(item => {
    const label = (item && (item.eid || item.empId)) != null ? String(item.eid || item.empId) : 'unknown';
    if (!item || !Array.isArray(item.attendanceInputSnapshot)) missing.push(`${label}: missing attendanceInputSnapshot`);
    if (!item || !item.scheduleSnapshot || typeof item.scheduleSnapshot !== 'object') missing.push(`${label}: missing scheduleSnapshot`);
    if (!item || !item.attendanceSummary || typeof item.attendanceSummary !== 'object') missing.push(`${label}: missing attendanceSummary`);
    if (!item || !item.rates || !Number.isFinite(Number(item.rates.daily))) missing.push(`${label}: missing rate snapshot`);
  });
  if (!Array.isArray(run && run.ruleSnapshot) || !(run.ruleSnapshot || []).length) missing.push('run: missing ruleSnapshot');
  if (missing.length) return { ok: false, code: 'PAYROLL_SNAPSHOT_INCOMPLETE', missing };
  return { ok: true, missing: [] };
}

module.exports = { validatePayrollSnapshotCompleteness };
