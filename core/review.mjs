import { AppError, hash, uid, stamp, decode } from './io.mjs';

const copy = value => structuredClone(value);
const values = docs => Array.isArray(docs) ? docs : Object.values(docs || {});
export function reviewScope(project, documents, proposal) {
  const job = project.jobs.find(j => j.id === proposal.jobId);
  const documentId = job?.documentId || proposal.fact?.source_document_id;
  const sourceHash = job?.sourceHash || proposal.fact?.source_hash;
  const document = values(documents).find(d => d.id === documentId);
  const approval = job && project.approvals.find(a => a.id === job.approvalId);
  return { documentId, sourceHash, document, job, current: !!document && document.hash === sourceHash && (!approval || approval.status === 'active') };
}

// Lifecycle is anchored to the decision's job. A new-version withdrawal request
// intentionally refers to an old fact and must remain actionable.
export function syncReviewLifecycle(project, documents, events = [], at = stamp()) {
  let changed = false;
  const set = (o, key, value) => { if (o[key] !== value) { o[key] = value; changed = true; } };
  const factMap = new Map(events.filter(e => !e.damaged && !e.unreviewedExternal && !e.uncommitted).flatMap(e => e.facts.map(f => [f.id, f])));
  const replaced = new Set([...factMap.values()].filter(f => f.status === 'accepted').map(f => f.supersedes_fact_id).filter(Boolean));
  for (const p of project.proposals) {
    const scope = reviewScope(project, documents, p);
    const inactiveTarget = p.operation === 'withdraw' && factMap.has(p.fact.id) && (!['accepted', 'baseline_recorded'].includes(factMap.get(p.fact.id).status) || replaced.has(p.fact.id));
    if (p.status === 'pending' && (!scope.current || inactiveTarget)) {
      p.status = 'obsolete'; p.obsolete_at = at; p.obsolete_reason = inactiveTarget ? 'target_no_longer_active' : 'source_version_changed';
      p.obsolete_message = inactiveTarget ? '目标事实已经撤回或被替代，无须重复裁定。' : '原确认稿已经修订，此建议仅保留在旧版本历史中。';
      p.statusHistory = [...(p.statusHistory || []), { status: 'obsolete', at, reason: p.obsolete_reason }]; changed = true;
    } else if (p.status === 'obsolete' && p.obsolete_reason === 'source_version_changed' && scope.current && !inactiveTarget) {
      p.status = 'pending'; p.reactivated_at = at; p.statusHistory = [...(p.statusHistory || []), { status: 'pending', at, reason: 'exact_source_version_restored' }];
      delete p.obsolete_reason; delete p.obsolete_message; changed = true;
    }
  }
  for (const j of project.jobs) {
    const d = values(documents).find(d => d.id === j.documentId), current = !!d && d.hash === j.sourceHash;
    set(j, 'versionState', current ? 'current' : d ? 'historical' : 'missing_source');
    if (current && j.sourceChanged) set(j, 'sourceChanged', false);
    const chapterItems = (project.chapterReviews || []).filter(row => row.jobId === j.id && row.status === 'pending');
    const pendingChapterItems = chapterItems.filter(row => reviewScope(project, documents, row).current).length;
    set(j, 'pending', project.proposals.filter(p => p.jobId === j.id && p.status === 'pending').length + pendingChapterItems);
    set(j, 'obsoletePending', project.proposals.filter(p => p.jobId === j.id && p.status === 'obsolete').length + chapterItems.length - pendingChapterItems);
    if (!current && j.status !== 'superseded') {
      j.historicalStatus = j.status; j.status = 'superseded'; j.retired_at = at; j.retired_reason = '源稿已有其他版本，任务仅保留在章节归档历史中。'; changed = true;
    } else if (current && j.status === 'superseded') {
      j.status = ['running', 'applying', 'queued'].includes(j.historicalStatus) ? 'interrupted' : j.historicalStatus || 'interrupted'; changed = true;
    }
    if (current && j.status === 'partial' && !j.pending) set(j, 'status', 'completed');
    if (current && j.status === 'completed' && j.pending) set(j, 'status', 'partial');
  }
  if (project.reviewLifecycleVersion !== 1) { project.reviewLifecycleVersion = 1; changed = true; }
  return changed;
}

export async function assertReviewCurrent(workspace, proposal) {
  const scope = reviewScope(workspace.project, workspace.documents, proposal);
  const bytes = scope.document && await workspace.store.read(scope.document.path);
  if (!scope.current || !bytes || hash(bytes) !== scope.sourceHash) throw new AppError('STALE_REVIEW', '此项属于已修订的确认稿，请在章节归档历史中查看；旧版建议不会作为新版事实接受。');
  return scope;
}

export function recordDecision(proposal, before, action) {
  proposal.revision = (proposal.revision || 0) + 1;
  proposal.decisionHistory = [...(proposal.decisionHistory || []), { id: uid('decision'), at: stamp(), action, before: copy(before), after: { status: proposal.status, resolution: proposal.resolution || action, resolved_at: proposal.resolved_at, fact: copy(proposal.fact) } }];
}

function findRecord(workspace, recordId) {
  const match = /^(proposal|fact):([\w-]+)$/.exec(String(recordId));
  if (!match) throw new AppError('VALIDATION', '核对记录ID无效');
  let proposal, event, fact;
  if (match[1] === 'proposal') {
    proposal = workspace.project.proposals.find(p => p.id === match[2]);
    if (!proposal) throw new AppError('NOT_FOUND', '核对记录不存在');
    event = workspace.events.find(e => e.id === proposal.eventId); fact = event?.facts.find(f => f.id === proposal.fact.id) || proposal.fact;
  } else {
    event = workspace.events.find(e => e.facts.some(f => f.id === match[2])); fact = event?.facts.find(f => f.id === match[2]);
    if (!fact) throw new AppError('NOT_FOUND', '归档事实不存在');
  }
  const origin = event?.review_origin;
  const scope = proposal ? reviewScope(workspace.project, workspace.documents, proposal) : { documentId: event?.source_document_id || origin?.documentId, sourceHash: event?.source_hash || origin?.sourceHash };
  const document = workspace.documents.find(d => d.id === scope.documentId);
  const current = proposal ? scope.current : !event?.source_document_id || document?.hash === event?.source_hash;
  const digest = hash(Buffer.from(JSON.stringify({ status: proposal?.status, revision: proposal?.revision || 0, fact, documentHash: document?.hash || null })));
  return { recordId, proposal, event, fact, documentId: scope.documentId, sourceHash: scope.sourceHash,
    document: document || workspace.project.sourceHistory?.retired[scope.documentId], current, digest };
}

export function reviewRecords(workspace) {
  const records = workspace.project.proposals.filter(p => p.status !== 'pending').map(p => {
    const r = findRecord(workspace, `proposal:${p.id}`);
    const corrections = (workspace.project.reviewAudit || []).filter(a => a.recordId === r.recordId && a.action.startsWith('correct_current'));
    return { recordId: r.recordId, proposalId: p.id, documentId: r.documentId, sourceHash: r.sourceHash, chapter: r.document?.chapter ?? p.fact.source_chapter, title: r.document?.title || '源稿已移除', status: p.status, resolution: p.resolution, operation: p.operation || 'accept', fact: p.fact, reviewed_at: corrections.at(-1)?.at || p.resolved_at || p.obsolete_at || p.created_at, current: r.current, kind: 'proposal', obsolete_message: p.obsolete_message, correctionCount: corrections.length };
  });
  // A newer request to withdraw an automatic fact is a separate decision. It
  // must not hide the original accepted record while that request is pending.
  const proposed = new Set(workspace.project.proposals.filter(p => p.operation !== 'withdraw').map(p => p.fact.id));
  for (const e of workspace.events.filter(e => !e.damaged)) for (const f of e.facts.filter(f => !proposed.has(f.id) && ['accepted', 'withdrawn', 'rejected'].includes(f.status))) {
    const r = findRecord(workspace, `fact:${f.id}`);
    records.push({ recordId: r.recordId, documentId: r.documentId, sourceHash: r.sourceHash, chapter: r.document?.chapter ?? f.source_chapter, title: r.document?.title || '作者直接裁定', status: f.status === 'withdrawn' ? 'revoked' : f.status, fact: f, reviewed_at: f.author_reviewed_at || e.created_at, current: r.current, kind: e.review_origin ? 'correction' : e.source_document_id ? 'automatic' : 'author' });
  }
  return records.sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)));
}

export const reviewMethods = {
  async reviewHistory() { return reviewRecords(this); },
  async reviewRecord({ recordId }) {
    const r = findRecord(this, recordId), c = this.project.characters.find(c => c.id === r.fact.entity_id && c.status !== 'merged');
    const detail = c ? await this.getCharacter(c.id, null) : null;
    const source = detail?.primarySourceId ? await this.snapshotDocument(this.doc(detail.primarySourceId)) : null;
    const baseline = !['belief','plan'].includes(r.fact.layer) && (r.fact.field.startsWith('base.') || r.fact.layer === 'baseline' || r.fact.status === 'baseline_recorded');
    const allFacts = new Map(this.events.filter(e => !e.damaged && !e.uncommitted && !e.unreviewedExternal && !e.withdrawn && !e.superseded).flatMap(e => e.facts.map(f => [f.id, f])));
    const replacesRecord = f => { const seen = new Set(); while (f?.supersedes_fact_id && !seen.has(f.id)) { seen.add(f.id); if (f.supersedes_fact_id === r.fact.id) return true; f = allFacts.get(f.supersedes_fact_id); } return false; };
    const sameField = (detail?.facts || []).filter(f => f.field === r.fact.field);
    const sameSlot = f => {
      if (['belief','plan'].includes(r.fact.layer) ? f.layer !== r.fact.layer : !['occurred','ruling'].includes(f.layer)) return false;
      if (f.field === 'skill') return f.value?.skillName === r.fact.value?.skillName;
      if (f.field === 'relationship') return f.value?.otherId === r.fact.value?.otherId && f.value?.type === r.fact.value?.type;
      return true;
    };
    const currentFact = sameField.filter(replacesRecord).at(-1) || sameField.filter(sameSlot).at(-1);
    const currentValue = baseline ? detail?.baseline?.fields.find(f => f.field === r.fact.field.replace(/^base\./, ''))?.value : currentFact?.value;
    const currentDigest = hash(Buffer.from(JSON.stringify({ digest: r.digest, characterRevision: c?.revision, baseline: detail?.baseline?.fields, facts: this.visibleFacts().filter(f => f.entity_id === r.fact.entity_id && f.field === r.fact.field), sourceHash: source?.hash })));
    const legacy = r.proposal && r.proposal.status !== 'pending' && !r.proposal.decisionHistory?.length ? [{ id: `legacy_${r.proposal.id}`, at: r.proposal.resolved_at || r.proposal.obsolete_at, action: r.proposal.resolution || r.proposal.status, legacy: true, after: { status: r.proposal.status, fact: r.proposal.fact } }] : [];
    return { ...r, document: r.document ? { id: r.document.id, title: r.document.title, chapter: r.document.chapter } : null, currentValue, currentFactId: currentFact?.id, baseline, currentDigest, characterRevision: c?.revision, primarySourceHash: source?.hash, baselineFields: detail?.baseline?.fields || [], canCorrect: !!c, canReconsider: !!r.proposal && r.current && ['accepted', 'rejected'].includes(r.proposal.status) && (r.proposal.operation !== 'withdraw' || r.proposal.status === 'rejected') && !baseline, canWithdraw: !!r.event && !r.event.damaged && !r.event.uncommitted && !r.event.unreviewedExternal && r.fact.status === 'accepted' && !baseline && r.proposal?.operation !== 'withdraw', history: [...legacy, ...(r.proposal?.decisionHistory || []), ...(this.project.reviewAudit || []).filter(a => a.recordId === recordId)] };
  },
  async reviewSource({ recordId }) {
    const r = findRecord(this, recordId), f = r.fact;
    if (!f.source_document_id || !f.source_hash) return { authorRuling: true, text: '', title: '作者裁定，不以原文句子作证' };
    const approval = this.project.approvals.find(a => a.documentId === f.source_document_id && a.sourceHash === f.source_hash);
    const snapshot = approval?.snapshot || `_创作管理/历史/文档版本/${f.source_document_id}/${f.source_hash}.md`;
    const b = await this.store.read(snapshot); if (!b || hash(b) !== f.source_hash) throw new AppError('SOURCE', '原确认稿快照缺失或损坏，未用新版稿件替代旧版证据');
    return { documentId: f.source_document_id, sourceHash: f.source_hash, title: r.document?.title || '原确认稿', text: decode(b).text, quote: f.evidence || '' };
  },
  async correctReviewedItem({ recordId, expectedCurrentDigest, value, layer = 'ruling', reason = '', effective = 'latest' }) {
    if (value === undefined || value === null || JSON.stringify(value).length > 10000) throw new AppError('VALIDATION', '更正内容不能为空或超过长度限制');
    const r = await this.reviewRecord({ recordId });
    if (!r.canCorrect || r.currentDigest !== expectedCurrentDigest) throw new AppError('CONFLICT', '核对记录或当前档案已经改变，请重新打开后再更正');
    if (!['latest','chapter'].includes(effective) || effective === 'chapter' && !Number.isInteger(r.document?.chapter)) throw new AppError('VALIDATION', '修正的生效范围无效');
    const reviewOrigin = { recordId, documentId: r.documentId || null, sourceHash: r.sourceHash || null, factId: r.fact.id, currentFactId: r.currentFactId || null, entityId: r.fact.entity_id, field: r.fact.field, reason: String(reason || '作者重新核对后更正').slice(0, 1800), before: r.currentValue ?? null, effective };
    if (r.baseline) {
      const field = r.fact.field.replace(/^base\./, ''), fields = copy(r.baselineFields);
      const target = fields.find(f => f.field === field);
      if (target) { target.value = typeof value === 'string' ? value : JSON.stringify(value); target.evidence = '作者重新核对后裁定'; }
      else fields.push({ field, value: typeof value === 'string' ? value : JSON.stringify(value), evidence: '作者重新核对后裁定' });
      return this.approveBaseline({ characterId: r.fact.entity_id, fields, expectedSourceHash: r.primarySourceHash, reviewOrigin });
    }
    return this.updateField({ entityId: r.fact.entity_id, field: r.fact.field, value, layer, chapter: effective === 'chapter' ? r.document.chapter : null, expectedRevision: r.characterRevision, reviewOrigin });
  },
  async withdrawReviewedItem({ recordId, expectedDigest, reason = '' }) {
    const r = await this.reviewRecord({ recordId });
    if (!r.canWithdraw || r.digest !== expectedDigest) throw new AppError('CONFLICT', '这条事实已被修改、撤回或不可写，请刷新后核对');
    const next = copy(this.project), event = copy(r.event), fact = event.facts.find(f => f.id === r.fact.id);
    fact.status = 'withdrawn'; fact.author_reviewed_at = stamp(); event.revision++; event.updated_at = stamp();
    if (r.proposal) { const p = next.proposals.find(p => p.id === r.proposal.id), before = { status: p.status, resolution: p.resolution, resolved_at: p.resolved_at, fact: copy(p.fact) }; p.status = 'revoked'; p.fact = copy(fact); p.resolved_at = stamp(); p.resolution = 'withdraw_applied'; recordDecision(p, before, 'withdraw_applied'); }
    next.reviewAudit ||= []; next.reviewAudit.push({ id: uid('review'), recordId, action: 'withdraw_applied', at: stamp(), reason: String(reason || '作者重新核对后撤回').slice(0, 1800), before: copy(r.fact), after: copy(fact) });
    const ep = `_创作管理/事件/${event.id}.md`, b = await this.store.read(ep);
    const merged = this.events.map(e => e.id === event.id ? event : e);
    syncReviewLifecycle(next, this.documents, merged);
    return this.commit('作者撤回一条已归档事实', [{ path: ep, expectedHash: hash(b), text: this.eventMarkdown(event, decode(b).text) }, ...await this.projectionChanges(new Set([fact.entity_id]), merged)], next);
  },
  async approvedSource({ approvalId }) {
    const a = this.project.approvals.find(a => a.id === approvalId && a.documentId && a.sourceHash);
    if (!a) throw new AppError('NOT_FOUND', '确认版本不存在');
    const b = await this.store.read(a.snapshot); if (!b || hash(b) !== a.sourceHash) throw new AppError('SOURCE', '确认稿快照缺失或损坏');
    return { title: this.documents.find(d => d.id === a.documentId)?.title || '原确认稿', sourceHash: a.sourceHash, text: decode(b).text };
  }
};
