/* Payroll adjustment lifecycle helpers. Browser global + CommonJS for tests. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PayrollAdjustmentCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function isReady(record) {
    if (!record || record.status === 'applied' || record.processStatus === 'applied') return false;
    return !record.status || record.status === 'ready' || record.status === 'approved' || record.status === 'pending';
  }
  function canDelete(record) {
    return !!record && record.status !== 'applied' && record.processStatus !== 'applied' && !record.payrollRunId;
  }
  function deletableIds(records, selectedIds) {
    var selected = new Set((selectedIds || []).map(Number));
    return (records || []).filter(function (record) { return selected.has(Number(record.id)) && canDelete(record); }).map(function (record) { return record.id; });
  }
  return {isReady:isReady, canDelete:canDelete, deletableIds:deletableIds};
}));
