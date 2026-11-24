import { AppError, decode, encode, hash, stamp } from './io.mjs';
import { isImportedTextPath } from './text-import.mjs';

const labels = { chapter: '正文', draft: '草稿', plan: '章纲 剧情设计', reference: '资料 文本', character: '人物档案', attachment: '地图' };
const pinned = doc => ({ documentId: doc.id, sourceHash: doc.hash, title: doc.title, path: doc.path, kind: doc.kind });
const lineText = value => value.replace(/\r\n?/gu, '\n');
const changePath = id => `_创作管理/草稿修改痕迹/${id}.json`;

function visibleDocuments(workspace) {
  const hidden = new Set(workspace.project.hiddenChapterMaterials || []);
  return workspace.documents.filter(doc => !doc.error && !doc.historical && !doc.generated && !hidden.has(doc.id));
}

export function workspaceFile(workspace, id) {
  return typeof id === 'string' ? visibleDocuments(workspace).find(doc => doc.id === id) : undefined;
}

function canArchive(workspace, doc) {
  return !doc.readOnly && (doc.kind === 'draft' || doc.kind === 'reference' && isImportedTextPath(doc.path)) &&
    !workspace.project.approvals.some(row => row.documentId === doc.id && row.status === 'active');
}

export function workspaceFileInfo(workspace, doc) {
  return { ...pinned(doc), chapter: doc.chapter, canEdit: doc.kind === 'draft' && !doc.readOnly,
    canArchive: canArchive(workspace, doc) };
}

export function findWorkspaceFiles(workspace, query) {
  const terms = String(query || '').trim().toLowerCase().normalize('NFKC').split(/\s+/u).filter(Boolean);
  if (!terms.length || terms.length > 8) return [];
  return visibleDocuments(workspace).filter(doc => {
    const chapter = doc.chapter ?? doc.draftChapterHint;
    const target = [doc.title, doc.path, labels[doc.kind], chapter && `第${chapter}章`].filter(Boolean).join(' ').toLowerCase().normalize('NFKC');
    return terms.every(term => target.includes(term));
  }).slice(0, 15).map(doc => workspaceFileInfo(workspace, doc));
}

async function currentDocument(workspace, documentId, sourceHash, check) {
  const registered = workspaceFile(workspace, documentId);
  if (!registered || !check(registered)) throw new AppError('READ_ONLY', '文件当前不可修改，请核对文件类型和状态');
  const current = await workspace.readDocument(documentId);
  if (current.hash !== sourceHash) throw new AppError('CONFLICT', '文件已变化，请按当前版本重新处理');
  if (current.draft && current.draft.text !== current.text) throw new AppError('UNSAVED_DRAFT', '文件有未保存编辑，请先保存或处理恢复稿');
  return current;
}

export async function prepareWorkspaceEdit(workspace, { documentId, sourceHash, edits, selection }) {
  const document = await currentDocument(workspace, documentId, sourceHash, doc => doc.kind === 'draft' && !doc.readOnly);
  if (!Array.isArray(edits) || !edits.length || edits.length > 12) throw new AppError('VALIDATION', '请选择 1–12 处草稿修改');
  const newline = document.text.includes('\r\n') ? '\r\n' : '\n';
  let first = 0, last = document.text.length;
  if (selection) {
    const content = lineText(document.text);
    if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 ||
        selection.end <= selection.start || !selection.text || content.slice(selection.start, selection.end) !== selection.text) {
      throw new AppError('CONFLICT', '引用选段已变化，请按当前版本重新选段');
    }
    first = content.slice(0, selection.start).replace(/\n/g, newline).length;
    last = first + selection.text.replace(/\n/g, newline).length;
  }
  const target = document.text.slice(first, last);
  const normalized = edits.map(row => {
    if (typeof row?.before !== 'string' || !row.before.trim() || row.before.length > 10000 ||
        typeof row.after !== 'string' || row.after.length > 12000 || row.after.includes('\0')) {
      throw new AppError('VALIDATION', '请提供原句和替换文字');
    }
    const before = row.before.replace(/\r?\n/g, newline), after = row.after.replace(/\r?\n/g, newline);
    const index = target.indexOf(before);
    if (index < 0 || target.indexOf(before, index + 1) >= 0) {
      throw new AppError('EVIDENCE', '原句找不到或重复，请补足相邻文字，定位到唯一段落');
    }
    const start = first + index;
    return { before, after, start, end: start + before.length, reason: String(row.reason || '').slice(0, 320) };
  }).sort((a, b) => a.start - b.start);
  if (normalized.some((row, index) => index && row.start < normalized[index - 1].end)) throw new AppError('EVIDENCE', '修改范围重叠，请重新选段');
  const changed = normalized.filter(row => row.before !== row.after);
  if (!changed.length) throw new AppError('VALIDATION', '替换文字与原文相同');
  return { type: 'edit', ...pinned(document), ...(selection ? { selection } : {}), edits: changed };
}

function appliedSpans(original, edits) {
  let text = '', position = 0;
  const marks = [];
  for (const row of edits) {
    text += original.slice(position, row.start);
    const from = lineText(text).length;
    text += row.after;
    marks.push({ from, to: from + lineText(row.after).length });
    position = row.start + row.before.length;
  }
  return { text: text + original.slice(position), marks };
}

export async function saveWorkspaceEdit(workspace, proposal, { receipt, onApplied = () => [] } = {}) {
  const action = await prepareWorkspaceEdit(workspace, proposal);
  const current = await currentDocument(workspace, action.documentId, action.sourceHash, doc => doc.kind === 'draft' && !doc.readOnly);
  const { text, marks } = appliedSpans(current.text, action.edits);
  const path = changePath(current.id);
  const previous = await workspace.store.read(path);
  const sourceHash = hash(encode(text, current));
  const metadata = { sourceHash, marks, ...(receipt ? { receipt, beforeHash: current.hash } : {}) };
  return workspace.saveDocument({ documentId: current.id, expectedHash: current.hash, text }, {
    label: '应用 Agent 草稿修改',
    additionalChanges: [...onApplied(sourceHash), { path, expectedHash: previous ? hash(previous) : null,
      text: JSON.stringify(metadata) }],
  });
}

export async function readWorkspaceEditReceipt(workspace, documentId, sourceHash) {
  const doc = workspaceFile(workspace, documentId);
  if (doc?.kind !== 'draft') return null;
  const path = changePath(documentId);
  const bytes = await workspace.store.read(path);
  if (!bytes) return null;
  const record = JSON.parse(bytes.toString('utf8'));
  return record.sourceHash === sourceHash && record.receipt && record.beforeHash
    ? { ...record, path, metadataHash: hash(bytes) } : null;
}

export async function restoreWorkspaceEdit(workspace, documentId, sourceHash, record, changes) {
  const current = await currentDocument(workspace, documentId, sourceHash, doc => doc.kind === 'draft' && !doc.readOnly);
  const snapshot = await workspace.store.read(`_创作管理/历史/文档版本/${documentId}/${record.beforeHash}.md`);
  if (!snapshot || hash(snapshot) !== record.beforeHash) throw new AppError('DAMAGED_SNAPSHOT', '修改前的草稿快照缺失或损坏');
  const restored = decode(snapshot).text;
  if (hash(encode(restored, current)) !== record.beforeHash) throw new AppError('CONFLICT', '文件编码已变化，当前版本无法安全撤回');
  return workspace.saveDocument({ documentId, expectedHash: sourceHash, text: restored }, {
    label: '撤回 Agent 草稿修改',
    additionalChanges: [...changes, { path: record.path, expectedHash: record.metadataHash, bytes: null }],
  });
}
export function prepareWorkspaceArchive(workspace, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length) {
    throw new AppError('VALIDATION', '请选择 1–12 份具体文件');
  }
  const files = ids.map(id => {
    const doc = workspaceFile(workspace, id);
    if (!doc || !canArchive(workspace, doc)) throw new AppError('READ_ONLY', '当前可整理章节草稿和未确认的导入文本');
    return pinned(doc);
  });
  return { type: 'archive', files };
}

export const workspaceActionMethods = {
  async getWorkspaceDraftEdit({ documentId, sourceHash }) {
    const receipt = await readWorkspaceEditReceipt(this, documentId, sourceHash);
    return { marks: await this.getWorkspaceEditMarks({ documentId, sourceHash }), canUndo: !!receipt };
  },
  async getWorkspaceEditMarks({ documentId, sourceHash }) {
    const doc = workspaceFile(this, documentId);
    if (doc?.kind !== 'draft' || doc.hash !== sourceHash) return [];
    const found = await this.store.read(changePath(documentId));
    if (found) {
      const result = JSON.parse(found.toString('utf8'));
      if (result.sourceHash === sourceHash) return result.marks;
    }
    // Earlier app releases recorded applied edits in the same batch as the conversation.
    const batch = (await this.store.history()).find(row => row.label === '应用 Agent 草稿修改' && row.status === 'committed' &&
      row.files.some(file => file.path === doc.path && file.afterHash === sourceHash));
    if (!batch) return [];
    const fileIndex = batch.files.findIndex(file => file.path === doc.path);
    const chatIndex = batch.files.findIndex(file => /^_创作管理\/共写\/cowrite_/u.test(file.path));
    if (chatIndex < 0) return [];
    const prefix = `_创作管理/历史/${batch.id}/`;
    const [before, conversation] = await Promise.all([this.store.read(prefix + fileIndex + '.before'), this.store.read(prefix + chatIndex + '.after')]);
    if (!before || !conversation || hash(before) !== batch.files[fileIndex].beforeHash) return [];
    const action = JSON.parse(conversation.toString('utf8')).messages?.at(-1)?.workspaceAction;
    if (action?.type !== 'edit' || !action.applied || action.documentId !== documentId || action.sourceHash !== hash(before)) return [];
    const original = decode(before);
    const edits = action.edits.map(row => ({ ...row, start: original.text.indexOf(row.before) })).sort((a, b) => a.start - b.start);
    if (edits.some(row => row.start < 0)) return [];
    const applied = appliedSpans(original.text, edits);
    return hash(encode(applied.text, original)) === sourceHash ? applied.marks : [];
  },
  async applyWorkspaceDraftEdit(input) { return saveWorkspaceEdit(this, input); },
  async archiveWorkspaceFiles({ files }) {
    const action = prepareWorkspaceArchive(this, files?.map(row => row.documentId));
    const changes = [], next = structuredClone(this.project);
    next.sourceHistory ||= { moves: [], retired: {} };
    for (const file of action.files) {
      const expected = files.find(row => row.documentId === file.documentId);
      const doc = await currentDocument(this, file.documentId, expected.sourceHash, row => canArchive(this, row));
      const bytes = await this.store.read(doc.path);
      if (!bytes || hash(bytes) !== doc.hash) throw new AppError('CONFLICT', '文件已变化，请重新核对');
      const archivePath = `_创作管理/历史/已归档文件/${doc.id}/${doc.hash}.md`;
      const registration = next.documents[doc.path];
      next.sourceHistory.retired[doc.id] = { ...registration, snapshot: doc.snapshot, archivePath, archivedByAuthor: true,
        at: stamp(), reason: '作者确认移入归档' };
      delete next.documents[doc.path];
      delete next.externalChanges[doc.id];
      changes.push({ path: archivePath, expectedHash: null, bytes }, { path: doc.path, expectedHash: doc.hash, bytes: null });
    }
    await this.commit('归档草稿与导入文本', changes, next);
    return true;
  },
  async restoreWorkspaceFile({ documentId }) {
    const doc = this.project.sourceHistory?.retired[documentId];
    if (!doc?.archivedByAuthor || !doc.archivePath) throw new AppError('NOT_FOUND', '找不到可恢复的归档文件');
    const bytes = await this.store.read(doc.archivePath);
    if (!bytes || hash(bytes) !== doc.hash || await this.store.read(doc.path)) {
      throw new AppError('CONFLICT', '归档版本有变化或原位置已有文件，请先核对');
    }
    const next = structuredClone(this.project);
    delete next.sourceHistory.retired[documentId];
    const { at, reason, archivePath, archivedByAuthor, ...registration } = doc;
    next.documents[doc.path] = registration;
    await this.commit('恢复已归档文件', [
      { path: doc.path, expectedHash: null, bytes }, { path: archivePath, expectedHash: doc.hash, bytes: null },
    ], next);
    return true;
  },
};
