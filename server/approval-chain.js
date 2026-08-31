// Backend-authoritative port of the approval-chain logic that already lives client-side
// (getApprovalChain/resolveApprovalDelegate in public/index.html, applyAttendanceDecision/
// applyLeaveDecision in public/compliance.js). Ported byte-for-byte where the original logic is
// itself the source of truth (chain resolution, layer advancement, delegation), with one
// deliberate, necessary addition: the client-side functions had NO check at all when a record's
// approval chain is empty (any caller who could reach the handler could act), and neither
// blocked someone from approving their own request. Both are closed here -- see
// canActOnRecord's own comment -- because this module is what the API layer now trusts instead
// of the client's own computation of "am I allowed to do this".
const { resolveCaller, isAdminCaller } = require('./authorization');

// Resolves the full approval chain for an employee identified by the STRING employee code
// (USER.eid) -- exact port of getApprovalChain(empEid) in public/index.html.
function getApprovalChain(state, empEid, maxLayersOverride) {
  const users = state.users || [];
  const approvalConfig = state.approvalConfig || {};
  const emp = users.find(u => u.eid === empEid);
  if (!emp) return [];
  const empCfg = (approvalConfig.perEmployee && approvalConfig.perEmployee[empEid]) || {};
  const numLayers = Math.min(
    maxLayersOverride || empCfg.layers || approvalConfig.defaultLayers || 1,
    approvalConfig.maxLayers || 4
  );
  const overrides = empCfg.overrides || {};

  // Natural chain positions via the immediate-head hierarchy. A head who has resigned/been
  // terminated (active===false) is skipped -- the walk continues up through THEIR
  // immediateHeadEid instead.
  const natural = [];
  let curEid = empEid;
  const visited = new Set([empEid]);
  for (let i = 0; i < numLayers; i++) {
    let head = null, probeEid = curEid;
    for (;;) {
      const probe = users.find(u => u.eid === probeEid);
      const candidate = probe ? users.find(u => u.eid === probe.immediateHeadEid) : null;
      if (!candidate || visited.has(candidate.eid)) break;
      if (candidate.active === false) { visited.add(candidate.eid); probeEid = candidate.eid; continue; }
      head = candidate; break;
    }
    natural.push(head);
    if (head) { visited.add(head.eid); curEid = head.eid; }
    else { for (let j = i + 1; j < numLayers; j++) natural.push(null); break; }
  }

  const chain = [];
  for (let i = 0; i < numLayers; i++) {
    const layerNum = i + 1;
    const overrideEid = overrides[String(layerNum)];
    if (overrideEid) {
      const ov = users.find(u => u.eid === overrideEid);
      if (ov) { chain.push({ layer: layerNum, approver: ov, mode: 'custom' }); continue; }
    }
    if (natural[i]) chain.push({ layer: layerNum, approver: natural[i], mode: 'chain' });
  }
  chain.forEach(entry => {
    const delegate = resolveApprovalDelegate(state, entry.approver);
    if (delegate && delegate.eid !== entry.approver.eid) entry.approver = delegate;
  });
  return chain;
}

function resolveApprovalDelegate(state, approverEmp) {
  const d = approverEmp && approverEmp.approvalDelegate;
  if (!d || !d.toEid) return null;
  const todayStr = new Date().toISOString().slice(0, 10);
  if (d.from && todayStr < d.from) return null;
  if (d.to && todayStr > d.to) return null;
  const users = state.users || [];
  const delegate = users.find(u => u.eid === d.toEid);
  return delegate && delegate.active !== false ? delegate : null;
}

// ATT/LEAVES records reference the target employee by NUMERIC USER.id (confusingly, in a field
// also called `eid`) -- resolves that to the employee's STRING .eid code and calls the chain
// resolver above, exactly mirroring what applyAttendanceDecision/applyLeaveDecision already do
// client-side before calling getApprovalChain(emp.eid).
function getApprovalChainForUserId(state, targetUserId, maxLayersOverride) {
  const users = state.users || [];
  const target = users.find(u => u.id === targetUserId);
  if (!target || target.eid == null) return [];
  return getApprovalChain(state, target.eid, maxLayersOverride);
}

// Backend-authoritative gate for "may this caller act on this record right now", combining:
//   1. Self-approval is never allowed, admin included -- the client-side version never checked
//      this at all (an admin's own submitted leave was approvable by that same admin through the
//      UI). No product policy in this app explicitly opts a role out of that rule, so it applies
//      unconditionally.
//   2. The caller must hold `basePermKey` (att_edit for attendance, leave_approve for leave) or
//      be an admin -- a floor requirement to act on this record TYPE at all. The original client
//      functions had no equivalent of this for the "empty chain" case (see point 3), which meant
//      literally any authenticated user who could reach the handler could act on a record with no
//      configured chain; this closes that.
//   3. If the record's current layer has a designated approver, the caller must be that specific
//      person (their delegate stands in for them) or an admin -- exact port of the client rule.
//      If the current layer has NO designated approver (empty/unconfigured chain), rule 2's base
//      permission is what authorizes the action instead, matching the product's existing
//      documented fallback ("any authorized user can act directly") without literally meaning
//      *any* authenticated session.
// statusField (optional, 6th arg): when given, the record must currently be 'pending' on that
// field or this refuses the action with a distinct `conflict: true` flag instead of the usual
// `allowed: false` -- callers map that to HTTP 409 rather than 403, since the problem isn't who's
// asking, it's that there's nothing left to decide. Neither applyAttendanceDecision nor
// applyLeaveDecision (their original client-side counterparts) ever checked this at all, so a
// second decision on an already-approved/rejected/cancelled record would just silently re-apply --
// re-flip status, append a duplicate approvalHistory entry, and (for leave, once finalization
// moved server-side) re-run balance/attendance/payroll side effects a second time. Checked before
// every other rule here so "is this record even still actionable" is answered uniformly regardless
// of who's asking, rather than leaking through a self-approval or permission check first.
function canActOnRecord(state, session, record, basePermKey, hasPermissionFn, statusField) {
  if (statusField && record[statusField] !== 'pending') {
    return { allowed: false, reason: 'This record is no longer pending approval.', conflict: true };
  }
  const caller = resolveCaller(state, session);
  const isAdmin = isAdminCaller(session, caller);
  if (caller && record.eid === caller.id) {
    return { allowed: false, reason: 'You cannot act on your own request.' };
  }
  if (!isAdmin && !hasPermissionFn(state, session, basePermKey)) {
    return { allowed: false, reason: 'You do not have permission to act on this record.' };
  }
  const chain = getApprovalChainForUserId(state, record.eid);
  const currentLayer = record.approvalLayer || 1;
  const layerEntry = chain.find(c => c.layer === currentLayer);
  if (layerEntry) {
    const isDesignatedApprover = !!(caller && layerEntry.approver.id === caller.id);
    if (!isDesignatedApprover && !isAdmin) {
      return { allowed: false, reason: `Only ${layerEntry.approver.name} (Layer ${currentLayer} approver) can act on this record.` };
    }
  }
  return { allowed: true, chain, currentLayer, layerEntry };
}

// Applies a decision to an already-authorized record (call canActOnRecord first). Mutates
// `record` in place and returns { final, message } -- exact port of applyAttendanceDecision/
// applyLeaveDecision's mutation logic, generalized over the one field-name difference between
// the two record types (statusField: 'status' for leave, 'approvalStatus' for attendance).
function applyChainDecision(record, decision, actorName, actorEid, chain, currentLayer, statusField) {
  const now = new Date().toISOString();
  if (decision === 'rejected') {
    record[statusField] = 'rejected';
    record.reviewedBy = actorName;
    record.reviewedAt = now;
    record.approvalHistory = (record.approvalHistory || []).concat([{ layer: currentLayer, decision: 'rejected', by: actorName, byEid: actorEid || null, at: now }]);
    return { final: true, message: 'Rejected.' };
  }
  record.approvalHistory = (record.approvalHistory || []).concat([{ layer: currentLayer, decision: 'approved', by: actorName, byEid: actorEid || null, at: now }]);
  if (chain.some(c => c.layer === currentLayer) && currentLayer < chain.length) {
    record.approvalLayer = currentLayer + 1;
    const next = chain.find(c => c.layer === currentLayer + 1);
    return { final: false, message: `Approved at Layer ${currentLayer}. Routed to Layer ${currentLayer + 1}${next ? ' (' + next.approver.name + ')' : ''}.` };
  }
  record[statusField] = 'approved';
  record.reviewedBy = actorName;
  record.reviewedAt = now;
  return { final: true, message: 'Approved.' };
}

// Force-approve: admin-only (checked by the caller before this is invoked), skips remaining
// layers without evaluating the chain at all. Exact port of forceApproveAttendance in
// public/compliance.js -- does NOT advance approvalLayer, and suffixes reviewedBy with
// ' (forced)' so the distinction from a normal chain approval is visible on the record itself.
function applyForceApprove(record, actorName, actorEid, statusField) {
  const now = new Date().toISOString();
  record[statusField] = 'approved';
  record.reviewedBy = actorName + ' (forced)';
  record.reviewedAt = now;
  record.approvalHistory = (record.approvalHistory || []).concat([{ layer: record.approvalLayer || 1, decision: 'force-approved', by: actorName, byEid: actorEid || null, at: now }]);
}

module.exports = { getApprovalChain, getApprovalChainForUserId, resolveApprovalDelegate, canActOnRecord, applyChainDecision, applyForceApprove };
