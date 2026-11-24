import fs from 'node:fs/promises';
import { AppError, hash, stamp, uid } from './io.mjs';
import { managedBlock, withSettingMetadata } from './catalog.mjs';
import { publicSourceUrl, searchForWork, selectedWebSources } from './research-search.mjs';

const candidateFolder = '_创作管理/资料候选';
export const RESEARCH_SETTINGS_FOLDER = '_创作管理/确认设定';
const candidateId = /^research_[a-f0-9-]{36}$/;
const states = ['pending', 'confirmed', 'deferred'];
export const researchNatures = { historical: '历史参考', fiction: '架空设定', character_claim: '人物说法' };

function candidatePath(id) {
  if (typeof id !== 'string' || !candidateId.test(id)) throw new AppError('VALIDATION', '候选设定编号无效。');
  return `${candidateFolder}/${id}.json`;
}

async function readCandidate(workspace, id) {
  const relative = candidatePath(id);
  const bytes = await workspace.store.read(relative);
  if (!bytes) throw new AppError('NOT_FOUND', '找不到这份候选设定。');
  try {
    const candidate = JSON.parse(bytes.toString('utf8'));
    if (candidate.schema !== 1 || candidate.id !== id || candidate.workId !== workspace.project.id ||
      !states.includes(candidate.status) || !Array.isArray(candidate.sources) || !candidate.sources.length ||
      typeof candidate.title !== 'string' || typeof candidate.body !== 'string' || typeof candidate.updatedAt !== 'string' ||
      !Object.hasOwn(researchNatures, candidate.nature) || candidate.sources.some(source => !source?.id ||
        typeof source.title !== 'string' || typeof source.excerpt !== 'string' ||
        (source.type === 'web' ? publicSourceUrl(source.url) !== source.url || typeof source.retrievedAt !== 'string'
          : source.type !== 'discussion' || typeof source.at !== 'string' || typeof source.recordPath !== 'string'))) {
      throw new Error('Invalid research candidate');
    }
    return { candidate, relative, beforeHash: hash(bytes) };
  } catch {
    throw new AppError('DAMAGED_DATA', '候选文件无法读取或不属于当前作品，已保留原文件。');
  }
}

function editFields(input) {
  const { title, body, category, nature, fromChapter = null, toChapter = null } = input;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 90 || /[\r\n\u0000]/.test(title)) {
    throw new AppError('VALIDATION', '请填写 1–90 字的设定标题。');
  }
  if (typeof body !== 'string' || body.length > 4500 || /\u0000|<!--\s*storydesk:/i.test(body)) {
    throw new AppError('VALIDATION', '设定正文最多 4500 字，且不能包含程序管理标记。');
  }
  if (typeof category !== 'string' || !category.trim() || category.trim().length > 40 || /[\r\n\u0000]/.test(category) ||
      !Object.hasOwn(researchNatures, nature)) {
    throw new AppError('VALIDATION', '请填写分类并选择设定性质。');
  }
  const range = researchChapterRange({ fromChapter, toChapter });
  return { title: title.trim(), body: body.trim(), category: category.trim(), nature, ...range };
}

export function researchChapterRange(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('VALIDATION', '请检查适用章序。');
  const { fromChapter = null, toChapter = null } = input;
  const validChapter = value => value === null || Number.isInteger(value) && value >= 1 && value <= 99999;
  if (!validChapter(fromChapter) || !validChapter(toChapter) || fromChapter !== null && toChapter !== null && fromChapter > toChapter) {
    throw new AppError('VALIDATION', '请检查适用章序，起始章不能大于结束章。');
  }
  return { fromChapter, toChapter };
}

export function researchScopeLabel({ fromChapter, toChapter }) {
  if (fromChapter === null && toChapter === null) return '全书';
  if (fromChapter === null) return `截至第${toChapter}章`;
  return toChapter === null ? `从第${fromChapter}章起` : `第${fromChapter}–${toChapter}章`;
}

function candidateChange(candidate, relative, expectedHash) {
  return { path: relative, expectedHash, text: JSON.stringify(candidate, null, 2) + '\n' };
}

async function writeCandidate(workspace, candidate, relative, expectedHash) {
  const change = candidateChange(candidate, relative, expectedHash);
  await workspace.store.batch('保存资料候选', [change]);
  return { ...candidate, hash: hash(Buffer.from(change.text)) };
}

function citationMarkdown(sources) {
  const lines = sources.map(source => {
    const title = source.title.replace(/[[\]<>\\]/g, '');
    if (source.type === 'web') {
      return `- ${title} · <${source.url}> · 查阅于 ${source.retrievedAt.slice(0, 10)}${source.published ? ` · 发布于 ${source.published}` : ''}`;
    }
    return `- ${title} · ${source.role === 'assistant' ? '助手回复' : '作者发言'} · ${source.at.slice(0, 10)} · 对话记录 ${source.recordPath} · 消息 ${source.messageId}`;
  });
  return ['## 出处', '', ...lines].join('\n');
}

function slimSource(source) {
  if (source.type === 'web') return { type: 'web', title: source.title, url: source.url, retrievedAt: source.retrievedAt };
  return { type: 'discussion', title: source.title, recordPath: source.recordPath, messageId: source.messageId, at: source.at };
}

export const researchMethods = {
  async searchResearch({ query }) { return searchForWork(this, query); },

  async listResearchCandidates() {
    const folder = await this.store.resolve(candidateFolder);
    const files = await fs.readdir(folder, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const candidates = [];
    const damaged = [];
    for (const file of files) {
      const id = file.name.slice(0, -5);
      if (!file.isFile() || !file.name.endsWith('.json') || !candidateId.test(id)) continue;
      try {
        const { candidate: { title, status, nature, sources, updatedAt, documentId } } = await readCandidate(this, id);
        candidates.push({ id, title, status, nature, sourceCount: sources.length, updatedAt, documentId });
      } catch (error) {
        if (error.code !== 'DAMAGED_DATA') throw error;
        damaged.push(file.name);
      }
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { candidates, damaged };
  },

  async getResearchCandidate({ id }) {
    const { candidate, beforeHash } = await readCandidate(this, id);
    return { ...candidate, hash: beforeHash };
  },

  async createResearchCandidate({ sourceIds, discussion }) {
    const web = selectedWebSources(this, sourceIds);
    const message = discussion ? await this.readResearchDiscussion(discussion) : null;
    const sources = [...new Map([...web, ...(message?.webSources || [])].map(row => [row.url, row])).values()].slice(0, 4);
    if (message) sources.unshift(message.source);
    if (!sources.length) throw new AppError('VALIDATION', '请至少选择一个搜索结果或一条创作对话。');
    const id = uid('research');
    const time = stamp();
    const title = message ? `${message.source.title.slice(0, 78)} · 讨论摘录` : sources[0].query.slice(0, 90);
    const fields = { title, body: message?.source.excerpt || '', category: '待分类',
      nature: message ? 'fiction' : 'historical', fromChapter: null, toChapter: null };
    const candidate = { schema: 1, id, workId: this.project.id, status: 'pending', ...fields, sources, createdAt: time, updatedAt: time };
    return writeCandidate(this, candidate, candidatePath(id), null);
  },

  async saveResearchCandidate({ id, expectedHash, fields, action = 'save', confirmed = false, sourceIds }) {
    const { candidate, relative, beforeHash } = await readCandidate(this, id);
    if (expectedHash !== beforeHash) throw new AppError('CONFLICT', '候选已有新版本，请重新打开后核对。');
    if (!['save', 'adopt', 'defer', 'resume'].includes(action) ||
        (action === 'resume' ? candidate.status !== 'deferred' : candidate.status !== 'pending')) {
      throw new AppError('CONFLICT', '该候选已处理，请刷新候选列表。');
    }
    if (fields) Object.assign(candidate, editFields(fields));
    if (sourceIds?.length) {
      const web = selectedWebSources(this, sourceIds);
      const sources = new Map(candidate.sources.map(row => [row.url || row.id, row]));
      for (const row of web) if (!sources.has(row.url)) sources.set(row.url, row);
      if ([...sources.values()].filter(row => row.type === 'web').length > 4) {
        throw new AppError('VALIDATION', '每份候选最多可保留 4 条网络出处。');
      }
      candidate.sources = [...sources.values()];
    }
    candidate.updatedAt = stamp();
    if (action !== 'adopt') {
      candidate.status = action === 'defer' ? 'deferred' : 'pending';
      return writeCandidate(this, candidate, relative, beforeHash);
    }
    if (confirmed !== true) throw new AppError('VALIDATION', '请先核对内容和出处，再确认写入。');
    Object.assign(candidate, editFields(candidate));
    if (!candidate.body) throw new AppError('VALIDATION', '请先填写准备采用的内容。');
    if (candidate.category === '待分类') throw new AppError('VALIDATION', '请先填写这条设定的分类。');
    const titleKey = candidate.title.normalize('NFKC').toLocaleLowerCase();
    if (this.documents.some(doc => doc.kind === 'setting' && doc.title.normalize('NFKC').toLocaleLowerCase() === titleKey)) {
      throw new AppError('CONFLICT', '世界观里已有同名设定。请核对原档，或为这条内容起一个更具体的标题。');
    }

    const documentId = uid('doc'), approvalId = uid('approval');
    const stem = candidate.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/[. ]+$/u, '').slice(0, 40).trim();
    const destination = `${RESEARCH_SETTINGS_FOLDER}/设定-${stem || '资料'}-${id.slice(9)}.md`;
    const metadata = { id: uid('setting'), work_id: this.project.id, documentId,
      category: candidate.category, nature: candidate.nature, scope: researchScopeLabel(candidate),
      summary: '', author: '作者', confirmed: true, updated_at: candidate.updatedAt,
      research: { candidateId: id, fromChapter: candidate.fromChapter, toChapter: candidate.toChapter,
        sources: candidate.sources.map(slimSource) } };
    const text = withSettingMetadata(managedBlock(`# ${candidate.title}\n\n${candidate.body}\n`,
      'research-sources', citationMarkdown(candidate.sources)), metadata);
    const sourceHash = hash(Buffer.from(text));
    const next = structuredClone(this.project);
    if (!next.sources.some(source => source.path === RESEARCH_SETTINGS_FOLDER && source.kind === 'setting')) {
      next.sources.push({ path: RESEARCH_SETTINGS_FOLDER, kind: 'setting', depth: 0 });
    }
    next.documents[destination] = { id: documentId, path: destination, kind: 'setting', title: candidate.title, hash: sourceHash };
    next.settingMeta ||= {};
    next.settingMeta[documentId] = metadata;
    next.approvals.push({ id: approvalId, kind: 'ruling', documentId, sourceHash, status: 'active', author: '作者',
      confirmed_at: candidate.updatedAt, researchCandidateId: id });
    Object.assign(candidate, { status: 'confirmed', documentId, approvalId, confirmedAt: candidate.updatedAt });
    const change = candidateChange(candidate, relative, beforeHash);
    await this.commit('作者确认资料候选并写入设定', [change, { path: destination, expectedHash: null, text }], next);
    return { ...candidate, hash: hash(Buffer.from(change.text)) };
  },
};
