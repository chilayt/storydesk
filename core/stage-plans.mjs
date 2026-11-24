import { AppError, uid } from './io.mjs';
import { isRecordedEvent } from './chapter-review.mjs';

const chapterNumber = value => Number.isInteger(value) && value >= 1 && value <= 99999;
const decisions = new Set(['pending', 'conflict', 'adopted']);

export function validateStageDetails(details, events, previous = {}) {
  if (details.fromChapter == null && details.toChapter == null && !details.milestones?.length) return;
  if (!chapterNumber(details.fromChapter) || !chapterNumber(details.toChapter) || details.toChapter < details.fromChapter) {
    throw new AppError('VALIDATION', '请填写阶段计划的起止章号');
  }
  const rows = details.milestones || [];
  if (!Array.isArray(rows) || rows.length > 30 || new Set(rows.map(row => row?.id)).size !== rows.length) {
    throw new AppError('VALIDATION', '阶段节点重复或超过 30 条');
  }
  for (const row of rows) {
    const validTitle = typeof row?.title === 'string' && row.title.trim() && row.title.length <= 120;
    if (!validTitle || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id) ||
      row.chapter != null && !chapterNumber(row.chapter) || !decisions.has(row.decision || 'pending') ||
      typeof (row.note ?? '') !== 'string' || (row.note || '').length > 500) {
      throw new AppError('VALIDATION', '请核对阶段节点的名称、章序和调整说明');
    }
    const event = events.find(e => e.id === row.eventId);
    const old = previous.milestones?.find(item => item.id === row.id);
    if (row.eventId && !event && old?.eventId !== row.eventId) throw new AppError('VALIDATION', '阶段节点的关联事件不存在');
    if (row.decision === 'adopted' && (old?.decision !== 'adopted' || old.eventId !== row.eventId) && !usableEvent(event)) {
      throw new AppError('VALIDATION', '请关联一条有效的已确认事件后采用实际变化');
    }
  }
}

function usableEvent(event) {
  return !!event && !event.stale && !event.externalPending && isRecordedEvent(event) &&
    (event.editorial_status === 'accepted' && event.editorial_layer === 'occurred' ||
      event.facts.some(fact => fact.status === 'accepted' && fact.layer === 'occurred'));
}

export function stagePlanProposal({ title, body, fromChapter, toChapter, nodes }, sourceDocIds) {
  if (typeof title !== 'string' || !title.trim() || title.length > 90 || title.includes('\0') ||
      typeof body !== 'string' || !body.trim() || body.length > 10000 || body.includes('\0') ||
      !chapterNumber(fromChapter) || !chapterNumber(toChapter) || !Array.isArray(nodes) || nodes.length > 30) {
    throw new AppError('VALIDATION', '请提供阶段名称、明确的起止章号、阶段说明和节点列表');
  }
  const milestones = nodes.map(node => ({
    id: uid('node'), title: typeof node?.title === 'string' ? node.title.trim() : '',
    chapter: node?.chapter ?? null, note: node?.note ?? '',
  }));
  const details = { fromChapter, toChapter, milestones, sourceDocIds };
  validateStageDetails(details, []);
  if (milestones.some(row => row.chapter != null && (row.chapter < fromChapter || row.chapter > toChapter))) {
    throw new AppError('VALIDATION', '节点章号应在阶段范围内，未定章号可以留空');
  }
  return { title: title.trim(), body: body.trim(), details };
}

export function stagePlans(workspace, beforeChapter = null) {
  const active = new Set(workspace.project.approvals.filter(a => a.status === 'active').map(a => a.id));
  const events = workspace.events.filter(event => usableEvent(event) && active.has(event.approval_id) &&
    (beforeChapter == null || event.source_chapter && event.source_chapter < beforeChapter));
  return workspace.records.filter(record => {
    const { fromChapter, toChapter } = record.details || {};
    return record.kind === 'plot_arc' && chapterNumber(fromChapter) && chapterNumber(toChapter) &&
      !record.damaged && !record.externalPending && !record.unreviewedExternal && !record.uncommitted &&
      !['candidate', 'unknown', 'abandoned'].includes(record.status) &&
      (beforeChapter == null || fromChapter <= beforeChapter && beforeChapter <= toChapter);
  }).map(record => {
    const { fromChapter, toChapter, milestones = [] } = record.details;
    const path = '_创作管理/资料/' + record.id + '.md';
    const nodes = (Array.isArray(milestones) ? milestones : []).filter(row => row?.id && typeof row.title === 'string').map(row => {
      const matches = row.eventId ? events.filter(event => event.id === row.eventId) :
        events.filter(event => event.title.trim() === row.title.trim() &&
          event.source_chapter >= fromChapter && event.source_chapter <= toChapter);
      const event = matches.length === 1 ? matches[0] : null;
      let state = event ? 'completed' : matches.length > 1 || row.eventId ? 'review' : 'pending';
      if (row.decision === 'conflict') state = 'conflict';
      else if (event && row.decision !== 'adopted' &&
        (row.chapter && event.source_chapter !== row.chapter || event.title.trim() !== row.title.trim())) state = 'changed';
      return { ...row, state, event: event ? { id: event.id, title: event.title, chapter: event.source_chapter,
        documentId: event.source_document_id, summary: event.summary?.slice(0, 170) || '' } : null };
    });
    return { id: record.id, title: record.title, path, hash: workspace.project.managedHeads?.[path]?.hash, fromChapter, toChapter, status: record.status,
      description: String(record.details.goal || record.body || '').slice(0, 340), nodes };
  });
}
