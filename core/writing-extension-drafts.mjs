import { AppError, hash, stamp, uid } from './io.mjs';

export const writingExtensionDraftMethods = {
  listWritingExtensionDrafts() {
    return [...(this.project.writingExtensionDrafts || [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },
  async readWritingExtensionDraft({ id }) {
    const entry = (this.project.writingExtensionDrafts || []).find(row => row.id === id);
    if (!entry) throw new AppError('NOT_FOUND', '此作品中没有这份扩展草案');
    const bytes = await this.store.read(entry.path);
    if (!bytes || hash(bytes) !== entry.hash) throw new AppError('CONFLICT', '扩展草案已有外部变更，请打开本地原稿核对');
    return { ...entry, text: bytes.toString('utf8') };
  },
  async saveWritingExtensionDraft({ id, expectedHash, title, kind, text }) {
    title = typeof title === 'string' ? title.trim() : '';
    if (!title || title.length > 90 || /[\0\r\n]/u.test(title) || !['skill', 'mcp'].includes(kind) ||
        typeof text !== 'string' || !text.trim() || text.length > 30000 || text.includes('\0')) {
      throw new AppError('VALIDATION', '请输入草案名称及 3 万字符以内的 Markdown 草案');
    }
    const previous = id ? await this.readWritingExtensionDraft({ id }) : null;
    if (previous && expectedHash !== previous.hash) throw new AppError('CONFLICT', '草案已变更，请重新打开');
    const draftId = previous?.id || uid('extension_draft');
    const path = previous?.path || `_创作管理/写作扩展/草案/${draftId}.md`;
    const bytes = Buffer.from(text, 'utf8');
    const entry = { id: draftId, workId: this.project.id, title, kind, path, hash: hash(bytes), updated_at: stamp() };
    const next = structuredClone(this.project);
    next.writingExtensionDrafts = [...(next.writingExtensionDrafts || []).filter(row => row.id !== draftId), entry];
    await this.commit('保存写作扩展草案', [{ path, bytes, expectedHash: previous?.hash || null }], next);
    return { ...entry, text };
  },
};
