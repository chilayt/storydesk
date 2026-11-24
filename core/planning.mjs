import { AppError, decode, encode, hash, jsonOr, stamp, uid } from './io.mjs';
import fs from 'node:fs/promises';

const folder = '_创作管理/大纲';
const planPrefix = 'outline_';

export function planningTarget(id) {
  if (typeof id !== 'string' || !id.startsWith(planPrefix)) return null;
  if (id === 'outline_work') return { type: 'work', title: '全书大纲', path: `${folder}/全书大纲.md` };
  if (id === 'outline_stage') return { type: 'stage', title: '阶段规划', path: '_创作管理/阶段讨论/讨论锚点.md' };
  const match = /^outline_(volume|chapter)_([1-9]\d{0,4})$/.exec(id);
  if (!match) throw new AppError('VALIDATION', '规划范围无效');
  const type = match[1], number = Number(match[2]);
  const title = type === 'volume' ? `第${number}卷大纲` : `第${number}章章纲`;
  return { type, number, title, path: `${folder}/${title}.md` };
}

export async function planningSource(workspace, id, target) {
  const bytes = await workspace.store.read(target.path);
  const recovery = await workspace.store.read(`_创作管理/草稿恢复/${id}.json`);
  let draft = null;
  try { draft = recovery ? JSON.parse(recovery.toString('utf8')) : null; } catch { throw new AppError('DAMAGED_DATA', '大纲恢复草稿无法读取，请保留文件并检查'); }
  if (draft && (draft.workId !== workspace.project.id || typeof draft.text !== 'string' || typeof draft.baseHash !== 'string')) {
    throw new AppError('DAMAGED_DATA', '大纲恢复草稿与当前作品不一致');
  }
  const lastChapter = Math.max(0, ...workspace.documents.filter(d => d.kind === 'chapter').map(d => d.chapter || 0));
  const chapter = target.type === 'chapter' ? target.number : lastChapter + 1;
  return {
    id, kind: 'outline', chapter, title: target.title, path: target.path,
    hash: hash(bytes || Buffer.alloc(0)), text: bytes ? decode(bytes).text : '', planning: target, draft,
  };
}

export async function saveOutline(workspace, { documentId, expectedHash, text }, extra = () => [], { preserveRecovery = false } = {}) {
  const target = planningTarget(documentId);
  if (target?.type === 'stage') throw new AppError('VALIDATION', '请将阶段规划保存为剧情线');
  if (!target || typeof text !== 'string' || !text.trim() || text.length > 16000 || text.includes('\0')) {
    throw new AppError('VALIDATION', '请填写 1–16000 字符的大纲');
  }
  const before = await workspace.store.read(target.path);
  if (hash(before || Buffer.alloc(0)) !== expectedHash) throw new AppError('CONFLICT', '大纲已有新版本，请重新读取');
  const recoveryPath = `_创作管理/草稿恢复/${documentId}.json`;
  if (preserveRecovery && await workspace.store.read(recoveryPath)) {
    throw new AppError('UNSAVED_DRAFT', '大纲有作者的恢复稿，请先在章纲编辑器处理');
  }
  const clean = text.trim();
  const body = clean.startsWith(`# ${target.title}\n`) ? clean : `# ${target.title}\n\n${clean}`;
  const next = structuredClone(workspace.project);
  if (!next.sources.some(source => source.kind === 'plan' && source.path === folder)) {
    next.sources.push({ path: folder, kind: 'plan', depth: 0 });
  }
  const changes = extra({ path: target.path, title: target.title, kind: 'plan' });
  await workspace.commit('保存作者大纲', [{ path: target.path, expectedHash: before ? hash(before) : null,
    bytes: encode(`${body}\n`, before ? decode(before) : {}) }, ...changes], next);
  if (!preserveRecovery) await fs.unlink(await workspace.store.resolve(recoveryPath)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return workspace.documents.find(document => document.path === target.path);
}

export function chapterOutlineApprovals(workspace) {
  const byDocument = new Map(workspace.documents.filter(d => d.kind === 'plan' && d.chapterMaterial?.role === 'design')
    .map(d => [d.id, d.chapterMaterial.chapter]));
  const byChapter = new Map();
  for (const approval of workspace.project.approvals) {
    if (approval.kind !== 'plan' || approval.sceneId || approval.status !== 'active') continue;
    if (approval.purpose === 'chapter_outline') {
      byChapter.set(approval.chapter, approval);
    } else if (!approval.purpose && byDocument.has(approval.documentId)) {
      const chapter = byDocument.get(approval.documentId);
      if (byChapter.get(chapter)?.purpose !== 'chapter_outline') byChapter.set(chapter, approval);
    }
  }
  return byChapter;
}

export async function confirmChapterOutline(workspace, { documentId, expectedHash }) {
  const indexed = workspace.doc(documentId);
  const chapter = indexed.chapterMaterial?.chapter;
  if (indexed.kind !== 'plan' || indexed.chapterMaterial?.role !== 'design' || !Number.isInteger(chapter) || chapter < 1 || chapter > 99999) {
    throw new AppError('VALIDATION', '请选择一份明确归属章节的设计或章纲');
  }
  const document = await workspace.snapshotDocument(indexed);
  if (document.hash !== expectedHash) throw new AppError('CONFLICT', '设计版本已变化，请重新打开后确认');
  if (!document.text.replace(/^#\s+[^\r\n]*[\r\n]*/u, '').trim()) {
    throw new AppError('VALIDATION', '请先在设计稿里写入章纲内容');
  }
  const outlineId = 'outline_chapter_' + chapter;
  const recoveryIds = [documentId];
  if (planningTarget(outlineId).path === document.path) recoveryIds.push(outlineId);
  for (const id of recoveryIds) {
    const recovery = await jsonOr(await workspace.store.resolve('_创作管理/草稿恢复/' + id + '.json'), null);
    if (recovery && recovery.text !== document.text) {
      throw new AppError('UNSAVED_DRAFT', '这份设计还有恢复稿，请先保存或处理后再定案');
    }
  }
  const previous = chapterOutlineApprovals(workspace).get(chapter);
  if (previous?.purpose === 'chapter_outline' && previous.documentId === document.id && previous.sourceHash === document.hash) return previous;
  const next = structuredClone(workspace.project);
  for (const approval of next.approvals) {
    if (approval.purpose === 'chapter_outline' && approval.chapter === chapter && approval.status === 'active') approval.status = 'superseded';
  }
  const approval = { id: uid('approval'), work_id: next.id, kind: 'plan', purpose: 'chapter_outline', chapter,
    documentId: document.id, sourceHash: document.hash, snapshot: document.snapshot, start: 0, end: document.text.length,
    status: 'active', author: '作者', confirmed_at: stamp() };
  next.approvals.push(approval);
  await workspace.commit('作者确定章纲', [], next);
  return approval;
}

export function confirmedVolumeOutlines(workspace) {
  return workspace.project.approvals.filter(approval => approval.purpose === 'volume_outline' && approval.status === 'active')
    .flatMap(approval => {
      const document = workspace.documents.find(d => d.id === approval.documentId && d.kind === 'plan' &&
        d.hash === approval.sourceHash && !d.error);
      return document ? [{ approval, document }] : [];
    });
}

export async function confirmVolumeOutline(workspace, { documentId, expectedHash, fromChapter, toChapter }) {
  const d = await workspace.snapshotDocument(workspace.doc(documentId));
  if (d.kind !== 'plan' || !/(?:卷纲|卷.*大纲)/u.test(d.title)) throw new AppError('VALIDATION', '请选择一份卷纲');
  if (d.hash !== expectedHash) throw new AppError('CONFLICT', '卷纲版本已变化，请重新打开后确认');
  if (!Number.isInteger(fromChapter) || !Number.isInteger(toChapter) || fromChapter < 1 || toChapter < fromChapter || toChapter > 99999) {
    throw new AppError('VALIDATION', '请填写有效的起止章号');
  }
  if (confirmedVolumeOutlines(workspace).some(({ approval, document }) =>
    document.id !== d.id && fromChapter <= approval.toChapter && toChapter >= approval.fromChapter)) {
    throw new AppError('CONFLICT', '与另一份已定卷纲的章节范围重叠，请先调整卷纲对应的范围');
  }
  const next = structuredClone(workspace.project);
  for (const approval of next.approvals) {
    if (approval.purpose === 'volume_outline' && approval.documentId === d.id && approval.status === 'active') approval.status = 'superseded';
  }
  const approval = { id: uid('approval'), work_id: next.id, kind: 'plan', purpose: 'volume_outline', documentId: d.id,
    sourceHash: d.hash, snapshot: d.snapshot, fromChapter, toChapter, status: 'active', author: '作者', confirmed_at: stamp() };
  next.approvals.push(approval);
  await workspace.commit('作者确定卷纲和适用章序', [], next);
  return approval;
}
