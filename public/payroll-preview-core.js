/* Payroll preview filtering, pagination, and dynamic component helpers. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PayrollPreviewCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function terms(value) {
    return String(value || '').split(/[\n\r\t,;]+/).map(function (item) { return item.trim().toLowerCase(); }).filter(Boolean);
  }
  function matchesSearch(draft, value) {
    var list = terms(value);
    if (!list.length) return true;
    var identity = [draft.eid,draft.name,draft.pos,draft.department].map(function (item) { return String(item || '').toLowerCase(); }).join(' ');
    return list.some(function (term) { return identity.indexOf(term) >= 0; });
  }
  function hasAdjustment(draft) {
    return (draft.calculationTrace || []).some(function (line) { return line.ruleCode === 'RETRO_ADJUSTMENT'; });
  }
  function matchesStatus(draft, status) {
    if (!status || status === 'all') return true;
    var issues = draft.validationIssues || [];
    if (status === 'issues') return issues.length > 0;
    if (status === 'blockers') return issues.some(function (issue) { return issue.severity === 'blocker'; });
    if (status === 'edited') return !!draft._edited;
    if (status === 'adjustments') return hasAdjustment(draft);
    if (status === 'zero-net') return Number(draft.net || 0) === 0;
    if (status === 'statutory') return !!draft.applyStatutory;
    if (status === 'no-statutory') return !draft.applyStatutory;
    return true;
  }
  function filterDrafts(drafts, options) {
    options = options || {};
    return (drafts || []).filter(function (draft) {
      return matchesSearch(draft,options.search) && (!options.department || options.department === 'all' || draft.department === options.department) && matchesStatus(draft,options.status);
    });
  }
  function paginate(items, page, pageSize) {
    var size = pageSize === 'all' ? Math.max(items.length,1) : Math.max(1,Number(pageSize || 25));
    var pages = Math.max(1,Math.ceil(items.length / size));
    var current = Math.min(Math.max(1,Number(page || 1)),pages);
    return {items:items.slice((current-1)*size,current*size),page:current,pages:pages,pageSize:pageSize === 'all' ? 'all' : size,total:items.length};
  }
  function needsPagination(result) {
    return !!result && Number(result.pages || 0) > 1;
  }
  function componentColumns(drafts, type, excludedCodes) {
    var excluded = new Set(excludedCodes || []), found = new Map();
    (drafts || []).forEach(function (draft) {
      (draft.calculationTrace || []).forEach(function (line) {
        if (line.type !== type || excluded.has(line.code)) return;
        var key = [line.type,line.code || '',line.name || ''].join('|');
        if (!found.has(key)) found.set(key,{key:key,type:line.type,code:line.code || '',name:line.name || line.code || 'Component'});
      });
    });
    return Array.from(found.values());
  }
  function lineAmount(draft, column) {
    return (draft.calculationTrace || []).filter(function (line) { return [line.type,line.code || '',line.name || ''].join('|') === column.key; }).reduce(function (sum,line) { return sum + Number(line.amount || 0); },0);
  }
  function employerAmount(draft, code) {
    return (draft.calculationTrace || []).filter(function (line) { return line.code === code; }).reduce(function (sum,line) { return sum + Number(line.employerAmount || 0); },0);
  }
  return {terms:terms,matchesSearch:matchesSearch,matchesStatus:matchesStatus,filterDrafts:filterDrafts,paginate:paginate,needsPagination:needsPagination,componentColumns:componentColumns,lineAmount:lineAmount,employerAmount:employerAmount};
}));
