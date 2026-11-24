import { AppError, decode, hash, stamp, uid } from './io.mjs';
import { recordMarkdown } from './catalog.mjs';
import { verifyFactEvidence } from './evidence.mjs';
import { assertReviewCurrent, recordDecision, reviewScope } from './review.mjs';

const hookStages = new Set(['introduced', 'progressing', 'paid_off']);
const eventLayers = new Set(['occurred', 'plan', 'belief']);

export function isRecordedEvent(event) {
  return !event.damaged && !event.unreviewedExternal && !event.uncommitted && !event.superseded && !event.withdrawn &&
    (event.editorial_status === 'accepted' || event.facts.some(fact => fact.status === 'accepted'));
}

export function chapterReviewEntries(job, event) {
  const { facts, hook_suggestions: hooks, ...envelope } = event;
  const row = kind => ({ id: uid('chapter-review'), eventId: event.id, jobId: job.id, kind, revision: 0, status: 'pending', created_at: stamp() });
  return [{ ...row('event'), title: event.title, evidence: event.editorial_evidence, event: envelope },
    ...(hooks || []).map(hook => ({ ...row('hook'), ...hook, hookStatus: hook.status, status: 'pending' }))];
}

function text(input, max, label) {
  if (typeof input !== 'string' || !input.trim() || input.length > max || input.includes('\0')) {
    throw new AppError('VALIDATION', `${label}不能为空或超过 ${max} 字`);
  }
  return input.trim();
}

function currentRecord(workspace, record, expectedRevision) {
  if (!record || record.damaged || record.externalPending || record.unreviewedExternal || record.uncommitted ||
      record.revision !== expectedRevision) throw new AppError('CONFLICT', '目标资料版本已变化，请重新打开核对');
  return workspace.project.managedHeads?.[`_创作管理/资料/${record.id}.md`]?.hash;
}

export const chapterReviewMethods = {
  async decideChapterReview({ id, expectedRevision, accept, title, summary, layer, storyTime, evidenceQuote, hookId, hookRevision, hookStatus }) {
    const item = (this.project.chapterReviews || []).find(row => row.id === id);
    if (!item || item.status !== 'pending' || item.revision !== expectedRevision || typeof accept !== 'boolean') {
      throw new AppError('CONFLICT', '此项已处理或有较新版本，请重新打开核对');
    }
    const { document } = await assertReviewCurrent(this, item);
    const next = structuredClone(this.project);
    const review = next.chapterReviews.find(row => row.id === id);
    const changes = [];
    let result;
    if (accept && item.kind === 'event') {
      const evidence = await verifyFactEvidence(this.store, document, item.evidence, evidenceQuote);
      if (!eventLayers.has(layer)) throw new AppError('VALIDATION', '请选择事件性质');
      const event = { ...item.event, title: text(title, 120, '事件标题'), summary: text(summary, 1500, '事件摘要'),
        story_time: String(storyTime || '').slice(0, 100), editorial_evidence: evidence, editorial_layer: layer,
        editorial_status: 'accepted', author_reviewed_at: stamp(), facts: next.proposals
          .filter(p => p.eventId === item.eventId && p.jobId === item.jobId && p.operation === 'accept')
          .map(p => ({ ...p.fact, status: p.status === 'rejected' ? 'rejected' : 'pending' })) };
      changes.push({ path: `_创作管理/事件/${event.id}.md`, expectedHash: null, text: this.eventMarkdown(event) },
        ...await this.projectionChanges(new Set(), [...this.events, event]));
      result = { eventId: event.id, title: event.title, summary: event.summary, layer, storyTime: event.story_time, evidence };
    }
    if (!accept && item.kind === 'event') {
      for (const p of next.proposals.filter(p => p.jobId === item.jobId && p.eventId === item.eventId && p.status === 'pending')) {
        const before = { status: p.status, fact: structuredClone(p.fact) };
        p.status = 'rejected'; p.resolution = 'reject_event'; p.resolved_at = stamp();
        recordDecision(p, before, 'reject_event');
      }
      for (const row of next.chapterReviews.filter(r => r.eventId === item.eventId && r.kind === 'hook' && r.status === 'pending')) {
        row.status = 'rejected'; row.revision++; row.resolved_at = stamp();
      }
    }
    if (accept && item.kind === 'hook') {
      const event = this.events.find(e => e.id === item.eventId && e.editorial_status === 'accepted' && isRecordedEvent(e) && !e.stale);
      if (!event) throw new AppError('VALIDATION', '请先核对关联事件');
      if (event.editorial_layer !== 'occurred') throw new AppError('VALIDATION', '计划和人物说法不能更新伏笔进展');
      const evidence = await verifyFactEvidence(this.store, document, item.evidence, evidenceQuote);
      if (!hookStages.has(hookStatus)) throw new AppError('VALIDATION', '请选择伏笔进展');
      const name = text(title, 120, '伏笔标题'), note = text(summary, 1500, '伏笔变化');
      const old = hookId ? this.records.find(row => row.id === hookId && row.kind === 'hook') : null;
      const oldHash = hookId ? currentRecord(this, old, hookRevision) : null;
      if (!old && this.records.some(r => r.kind === 'hook' && r.title.trim() === name)) {
        throw new AppError('VALIDATION', '已有同名伏笔，请选中该伏笔进行更新');
      }
      if (!old && hookStatus === 'paid_off') throw new AppError('VALIDATION', '请先选中实际回收的既有伏笔');
      const at = stamp(), chapter = document.chapter;
      const details = structuredClone(old?.details || {});
      const previous = (details.chapterUpdates || []).filter(update => update.documentId !== document.id || update.sourceHash === document.hash);
      const later = previous.some(update => (update.chapter ?? 0) > chapter) || (old?.details?.paidOffChapter ?? 0) > chapter;
      const update = { chapter, documentId: document.id, sourceHash: document.hash, eventId: event.id, status: hookStatus, summary: note, evidence, at };
      details.chapterUpdates = [...(details.chapterUpdates || []), update];
      details.relatedEventIds = [...new Set([...(details.relatedEventIds || []), event.id])];
      if (chapter && hookStatus === 'introduced' && !details.introducedChapter) details.introducedChapter = chapter;
      if (chapter && hookStatus === 'paid_off' && !later) details.paidOffChapter = chapter;
      if (JSON.stringify(details).length > 30000) throw new AppError('VALIDATION', '伏笔记录已到长度上限，请先整理其进展');
      const status = later ? old.status : hookStatus;
      const body = [old?.body, `## ${chapter ? `第${chapter}章` : document.title} · ${({ introduced: '埋设', progressing: '推进', paid_off: '回收' })[hookStatus]}\n\n${note}\n\n> ${evidence.evidence}`]
        .filter(Boolean).join('\n\n');
      const record = { id: old?.id || uid('record'), work_id: this.project.id, kind: 'hook', title: old?.title || name,
        status, participants: old?.participants || [], details, revision: (old?.revision || 0) + 1,
        created_at: old?.created_at || at, updated_at: at, updated_by: '作者' };
      changes.push({ path: `_创作管理/资料/${record.id}.md`, expectedHash: oldHash ?? null, text: recordMarkdown(record, body) });
      result = { recordId: record.id, title: record.title, summary: note, status: hookStatus, evidence };
    }
    if (accept && item.kind === 'withdraw_event') {
      const original = this.events.find(e => e.id === item.eventId && e.stale && isRecordedEvent(e));
      if (!original || original.revision !== item.eventRevision) throw new AppError('CONFLICT', '旧事件已更新，请在现行资料中重新核对');
      const path = `_创作管理/事件/${original.id}.md`;
      const head = this.project.managedHeads?.[path], bytes = await this.store.read(path);
      if (!bytes || !head || hash(bytes) !== head.hash) throw new AppError('CONFLICT', '旧事件已有外部修改');
      const event = { ...original, withdrawn: true, revision: original.revision + 1, updated_at: stamp(),
        facts: original.facts.map(f => f.status === 'accepted' ? { ...f, status: 'withdrawn' } : f) };
      const ids = new Set(original.facts.filter(f => f.status === 'accepted').map(f => f.entity_id));
      changes.push({ path, expectedHash: head.hash, text: this.eventMarkdown(event, decode(bytes).text) },
        ...await this.projectionChanges(ids, this.events.map(e => e.id === event.id ? event : e)));
      result = { eventId: event.id, title: event.title };
    }
    review.status = accept ? 'accepted' : 'rejected';
    review.revision++;
    review.resolved_at = stamp();
    if (result) review.result = result;
    await this.commit(accept ? '作者核对章节剧情并写回资料' : '作者保留原资料，拒绝章节建议', changes, next);
    return review;
  },
};

export function chapterReviewState(project, documents, row) {
  return row.status === 'pending' && !reviewScope(project, documents, row).current ? 'obsolete' : row.status;
}
