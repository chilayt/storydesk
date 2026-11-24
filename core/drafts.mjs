import path from 'node:path';
import { AppError, decode, hash, stamp, uid } from './io.mjs';
import { isImportedTextPath } from './text-import.mjs';

const validChapter = chapter => Number.isInteger(chapter) && chapter >= 1 && chapter <= 99999;
const numberLabel = chapter => '第' + String(chapter).padStart(2, '0') + '章';

function titlePart(title) {
  return String(title || '').replace(/^第\s*[\d一二三四五六七八九十百零〇两]+\s*[章回][\s·._\-：:]*/u, '')
    .replace(/[<>:"/\\|?*\r\n\0]/g, ' ').trim().slice(0, 90);
}

function formalFolder(workspace, draftPath = '') {
  const existing = workspace.documents.filter(d => d.kind === 'chapter' && !d.readOnly && validChapter(d.chapter))
    .sort((a, b) => b.chapter - a.chapter)[0];
  return existing ? path.posix.dirname(existing.path) : draftPath.startsWith('05-剧本/') ? '05-剧本/正文' : '正文';
}

export function nextWritingChapter(workspace, chapters) {
  const approved = new Set(workspace.project.approvals.filter(a => a.kind === 'prose' && a.status === 'active' && !a.sceneId)
    .map(a => a.documentId));
  const released = chapters.filter(d => workspace.project.chapterPublications?.[d.id]);
  const candidates = released.length ? chapters.filter(d => approved.has(d.id)) : chapters;
  // Imported files provide a starting chapter until this work has a publication history.
  return 1 + Math.max(0, ...candidates.map(d => d.chapter || 0), ...released.map(d => d.chapter || 0));
}

export async function prepareDraftPublication(workspace, document) {
  if (document.kind !== 'draft' || document.readOnly || !validChapter(document.chapter)) {
    throw new AppError('VALIDATION', '请选择可编辑的章节草稿发布');
  }
  if (workspace.project.hiddenChapterMaterials?.includes(document.id)) {
    throw new AppError('VALIDATION', '请先恢复这份草稿，再核对发布');
  }
  const current = workspace.documents.find(d => d.kind === 'chapter' && d.chapter === document.chapter);
  if (current) throw new AppError('CONFLICT', '此章已有正式正文。请打开正文核对修订版本');
  const recovery = await workspace.store.read('_创作管理/草稿恢复/' + document.id + '.json');
  if (recovery && JSON.parse(recovery.toString('utf8')).text !== document.text) {
    throw new AppError('UNSAVED_DRAFT', '请保存或处理尚未写入的草稿编辑');
  }
  if (!document.text.replace(/^#\s+[^\r\n]*[\r\n]*/u, '').trim()) throw new AppError('VALIDATION', '请先写入草稿内容');
  const bytes = await workspace.store.read(document.path);
  if (!bytes || hash(bytes) !== document.hash) throw new AppError('CONFLICT', '草稿已有修改，请重新检查后发布');
  const title = titlePart(document.title) || '正文';
  const target = formalFolder(workspace, document.path) + '/' + numberLabel(document.chapter) + '_' + title + '.md';
  return { target, bytes };
}

export function registerDraftPublication(next, document, approval, target) {
  const { chapterMaterial, ...prior } = next.documents[document.path];
  next.chapterPublications ||= {};
  next.chapterPublications[document.id] = { documentId: document.id, from: document.path, to: target,
    chapter: document.chapter, hash: document.hash, approvalId: approval.id, at: stamp() };
  next.documents[target] = { ...prior, path: target, kind: 'chapter', chapter: document.chapter };
  delete next.documents[document.path];
  delete next.externalChanges[document.id];
  return target;
}

export const draftMethods = {
  async hideOtherChapterDrafts({ keeperId, keeperHash, drafts }) {
    const keeper = this.doc(keeperId);
    const hidden = new Set(this.project.hiddenChapterMaterials || []);
    if (!['draft', 'chapter'].includes(keeper.kind) || !validChapter(keeper.chapter) || hidden.has(keeperId) ||
        keeper.hash !== keeperHash || hash(await this.store.read(keeper.path) || Buffer.alloc(0)) !== keeperHash) {
      throw new AppError('CONFLICT', '保留稿已变化，请重新核对本章草稿');
    }
    if (!Array.isArray(drafts) || !drafts.length) throw new AppError('VALIDATION', '请选择要移出的草稿');
    for (const item of drafts) {
      const doc = this.doc(item.id);
      if (doc.id === keeperId || doc.kind !== 'draft' || doc.chapter !== keeper.chapter || hidden.has(doc.id) ||
          doc.hash !== item.hash || hash(await this.store.read(doc.path) || Buffer.alloc(0)) !== item.hash) {
        throw new AppError('CONFLICT', '所选草稿已变化，请重新核对列表');
      }
      hidden.add(doc.id);
    }
    await this.commit('移出同章备选草稿', [], { ...structuredClone(this.project), hiddenChapterMaterials: [...hidden] });
    return true;
  },

  async createChapterDraft({ chapter, title, importedText, sourceDocumentId, expectedSourceHash }, extra = () => []) {
    if (!validChapter(chapter)) throw new AppError('VALIDATION', '请输入有效章号');
    const name = titlePart(title);
    if (!name) throw new AppError('VALIDATION', '请填写草稿标题');
    let sourceBytes;
    if (sourceDocumentId !== undefined) {
      const source = this.doc(sourceDocumentId);
      if (source.kind !== 'reference' || !isImportedTextPath(source.path) || source.error || source.historical) {
        throw new AppError('VALIDATION', '请从本作品的「导入文本」选择原档');
      }
      sourceBytes = await this.store.read(source.path);
      if (!sourceBytes || source.hash !== expectedSourceHash || hash(sourceBytes) !== expectedSourceHash) {
        throw new AppError('CONFLICT', '资料库原档已有变化，请重新选择');
      }
      importedText = decode(sourceBytes).text;
    }
    const folder = formalFolder(this).startsWith('05-剧本/') ? '05-剧本/草稿章节' : '草稿章节';
    const stem = folder + '/' + numberLabel(chapter) + '_' + name;
    let relative = stem + '.md';
    const next = structuredClone(this.project);
    if (!next.sources.some(source => source.path === folder && source.kind === 'draft')) {
      next.sources.push({ path: folder, kind: 'draft', depth: 0 });
    }
    if (importedText !== undefined && (typeof importedText !== 'string' || !importedText.trim() ||
      importedText.length > 5000000 || importedText.includes('\0'))) {
      throw new AppError('VALIDATION', '导入稿件为空或超过大小限制。');
    }
    const content = importedText ?? '# ' + numberLabel(chapter) + '　' + name + '\n\n';
    const bytes = sourceBytes ?? Buffer.from(content);
    const sourceHash = hash(bytes);
    if (importedText !== undefined) {
      const reserved = new Set(Object.values(next.chapterPublications || {}).map(row => row.from.toLowerCase()));
      for (const source of Object.values(next.sourceHistory?.retired || {})) reserved.add(source.path.toLowerCase());
      let suffix = 2;
      while (true) {
        const claimed = await this.store.read(relative);
        const registered = this.documents.find(row => row.path.toLowerCase() === relative.toLowerCase());
        if (!reserved.has(relative.toLowerCase()) && !claimed) break;
        if (registered?.kind === 'draft' && !registered.readOnly && registered.hash === sourceHash &&
            claimed && hash(claimed) === sourceHash && !next.hiddenChapterMaterials?.includes(registered.id)) {
          const linked = extra(registered);
          if (linked.length) await this.store.batch('记录对话文稿', linked);
          return this.readDocument(registered.id);
        }
        relative = `${stem}（${suffix++}）.md`;
      }
    }
    const id = uid('doc');
    next.documents[relative] = { id, path: relative, title: name, kind: 'draft', chapter, hash: sourceHash,
      ...(importedText !== undefined ? { importedAt: stamp() } : {}) };
    await this.commit(importedText === undefined ? '新建章节草稿' : '导入稿件副本',
      [{ path: relative, expectedHash: null, bytes }, ...extra(next.documents[relative])], next);
    return this.readDocument(id);
  }
};
