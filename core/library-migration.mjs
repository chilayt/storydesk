import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, decode, hash, stamp } from './io.mjs';
import { isMapPath, WORLD_SOURCE_KINDS } from './catalog.mjs';

const library = '创作资料库';
const folders = {
  chapter: '正文', character: '人物', plan: '大纲', organization: '门派势力',
  setting: '设定', family: '家族', location: '地点', item: '道具物资', rule: '写作规则', reference: '待核对',
};
const classifiable = new Set([...WORLD_SOURCE_KINDS, 'rule']);
const materialKinds = new Set([...classifiable, 'character', 'reference']);
const knownSources = [
  { path: 'novel-kb/01-实体/势力', kind: 'organization' },
  { path: '_已解析/门派.txt', kind: 'organization' },
  { path: 'novel-kb/01-实体/地点', kind: 'location', whole: true },
  { path: 'novel-kb/01-实体/功法武学', kind: 'setting', whole: true, shelf: '武学功法' },
  { path: 'novel-kb/01-实体/兵器法宝', kind: 'item', whole: true },
  { path: 'novel-kb/01-实体/丹药毒物', kind: 'item', whole: true },
  { path: 'novel-kb/05-设定', kind: 'setting', whole: true },
  { path: 'novel-kb/07-时间/年表.md', kind: 'setting', whole: true },
];
const genericHeading = /^(?:门派|宗门|组织|势力|人物|角色|世界观|设定|资料|背景|介绍|目录|总纲|门规|来历|传承|成员|功法|历史|地理|概况)(?:总览|汇总|概要|合集|清单|设定|资料|简介)?$/u;
const namedCard = /^[PSLKDW]\d+\s*[-·－]\s*/i;

function safeName(value) {
  const name = String(value).replace(namedCard, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/[.\s]+$/, '').trim().slice(0, 92) || '未命名资料';
  return /^(?:con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `资料-${name}` : name;
}

function sectionHeadings(lines) {
  const headings = [];
  let fence = '';
  for (let index = 0; index < lines.length; index++) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[index])?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (fence === marker[0]) fence = '';
      continue;
    }
    if (fence) continue;
    const match = /^\s{0,3}(#{1,5})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (match) headings.push({ line: index, level: match[1].length, title: safeName(match[2]) });
  }
  return headings;
}

export function splitMaterial(text, filename) {
  const basename = path.basename(filename, path.extname(filename));
  const stem = safeName(basename);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (namedCard.test(basename)) return [{ title: stem, text, start: 1, end: lines.length }];
  const headings = sectionHeadings(lines);
  if (!headings.length && genericHeading.test(stem)) {
    const labeledSections = lines.flatMap((line, index) => {
      const match = /^([^\s，。！？:：·｜|—–]{2,25})\s*[·｜|—–]\s*(?:门派|宗门|势力|组织|人物|完整|背景)[^。！？]{0,26}设定(?:[（(].{0,24}[）)])?\s*$/u.exec(line);
      return match ? [{ name: match[1], index }] : [];
    });
    if (labeledSections.length > 1) return [
      { title: `${stem}·完整原件`, text, start: 1, end: lines.length, pending: true },
      ...labeledSections.map((section, index) => {
        const end = labeledSections[index + 1]?.index ?? lines.length;
        return { title: `${section.name}·源文片段`, text: lines.slice(section.index, end).join('\n').trimEnd(),
          start: section.index + 1, end, pending: true };
      }),
    ];
  }
  const highest = Math.min(...headings.map(h => h.level));
  let boundaries = headings.filter(h => h.level === highest);
  const wrapper = boundaries.length === 1 && genericHeading.test(boundaries[0].title) ? boundaries[0] : null;
  if (wrapper) boundaries = headings.filter(h => h.level === highest + 1);
  const several = boundaries.length > 1 && boundaries.every(h => !genericHeading.test(h.title)) &&
    new Set(boundaries.map(h => h.title.toLowerCase())).size === boundaries.length;
  if (several) {
    const parts = boundaries.map((heading, index) => {
      const end = boundaries[index + 1]?.line ?? lines.length;
      return { title: heading.title, text: lines.slice(heading.line, end).join('\n').trimEnd(), start: heading.line + 1, end };
    });
    const preface = lines.slice(0, boundaries[0].line).filter((_, index) => index !== wrapper?.line).join('\n').trim();
    if (preface) parts.unshift({ title: `${stem}·总说明`, text: preface, start: 1, end: boundaries[0].line, pending: true });
    return parts;
  }
  const title = !wrapper && boundaries.length === 1 ? boundaries[0].title : stem;
  return [{ title, text, start: 1, end: lines.length, pending: genericHeading.test(title) || !!wrapper || boundaries.length > 1 }];
}

async function pathsFor(workspace, relative, optional) {
  const directory = await workspace.store.resolve(relative);
  let stat;
  try { stat = await fs.stat(directory); } catch (error) {
    if (error.code !== 'ENOENT' || !optional) throw new AppError('SOURCE', `找不到资料来源 ${relative}`);
    return [];
  }
  if (stat.isFile()) {
    if (!/\.(md|txt)$/i.test(relative)) throw new AppError('VALIDATION', '资料整理支持 Markdown 和 UTF-8 文本');
    return [relative];
  }
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !/^[._]/.test(entry.name) && /\.(md|txt)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  if (entries.length > 150) throw new AppError('INPUT_LIMIT', '请选更具体的资料目录，每次整理至多 150 份额外资料');
  return entries.map(entry => `${relative}/${entry.name}`);
}

async function prepare(workspace, { source = '', kind = 'organization', useKnownSources = true } = {}) {
  const supplied = String(source).trim().replaceAll('\\', '/').replace(/\/$/, '');
  const relative = supplied ? path.posix.normalize(supplied) : '';
  if (!materialKinds.has(kind)) throw new AppError('VALIDATION', '资料类型无效');
  const referenceFile = /^创作资料库\/待核对\/[^/]+\.md$/i.test(relative);
  if (relative && (relative === '.' || !referenceFile && /^(?:创作资料库|_创作管理|_archive|90-历史归档)(?:\/|$)/i.test(relative))) {
    throw new AppError('VALIDATION', '请选择待整理的源文件或资料目录');
  }
  const originals = workspace.project.libraryOriginals || {};
  const transfers = workspace.documents.filter(d => d.readOnly && !d.error && folders[d.kind] && /\.md$/i.test(d.path));
  const entries = [], occupied = new Set(), skipped = [];
  for (const document of transfers) {
    const bytes = await workspace.store.read(document.path);
    if (!bytes || hash(bytes) !== document.hash) throw new AppError('CONFLICT', '目录中已有较新的源文件，请刷新后重试');
    const basename = path.basename(document.path);
    const base = `${library}/${folders[document.kind]}/${basename}`;
    const address = occupied.has(base.toLowerCase()) ? `${base.slice(0, -3)}-${hash(Buffer.from(document.path)).slice(0, 8)}.md` : base;
    entries.push({ path: address, title: document.title, kind: document.kind, source: document.path, sourceHash: document.hash,
      bytes, documentId: document.id });
    occupied.add(address.toLowerCase());
  }
  const known = useKnownSources && workspace.project.sourceProfiles?.includes('novel-kb-v1') ? [...knownSources] : [];
  if (known.length) {
    const directory = await workspace.store.resolve('_已解析');
    const files = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) {
      const name = '_已解析/' + file.name;
      if (file.isFile() && !file.name.startsWith('.') && /\.(?:txt|md)$/iu.test(file.name) &&
          !known.some(item => item.path === name)) known.push({ path: name, kind: 'reference', whole: true });
    }
  }
  const inputs = new Map();
  for (const shelf of known) for (const p of await pathsFor(workspace, shelf.path, true)) {
    inputs.set(p, p === 'novel-kb/05-设定/文风设定.md' ? { ...shelf, kind: 'rule' } : shelf);
  }
  if (relative) for (const p of await pathsFor(workspace, relative, false)) inputs.set(p, { kind });
  const recognized = new Set();
  for (const [file, input] of inputs) {
    if (originals[file] || transfers.some(doc => doc.path === file)) continue;
    const type = input.kind;
    const full = await workspace.store.resolve(file);
    if ((await fs.stat(full)).size > 1_000_000) { skipped.push({ path: file, reason: '超过单份文本容量，请细分后整理' }); continue; }
    const bytes = await workspace.store.read(file);
    let text;
    try { text = decode(bytes).text; } catch { skipped.push({ path: file, reason: '无法按 UTF-8 读取' }); continue; }
    const sourceHash = hash(bytes);
    const parts = input.whole ? [{ title: path.basename(file, path.extname(file)), text, start: 1, end: text.split(/\r?\n/).length }] : splitMaterial(text, file);
    for (const part of parts) {
      const name = safeName(part.title);
      const key = `${type}/${name.toLowerCase()}`;
      let pending = type === 'reference' || part.pending || recognized.has(key);
      let destination = `${library}/${folders[type]}/${input.shelf ? input.shelf + '/' : ''}${name}.md`;
      if (!pending && (occupied.has(destination.toLowerCase()) || await workspace.store.read(destination))) pending = true;
      if (pending) destination = `${library}/待核对/${name}-${hash(Buffer.from(`${file}\0${part.start}`)).slice(0, 8)}.md`;
      const category = pending ? 'reference' : type;
      const note = pending ? '待核对资料' : '导入资料';
      const body = `# ${name}\n\n> ${note}｜来源 ${file}，第 ${part.start}–${part.end} 行\n> 原文件 SHA-256 ${sourceHash}\n\n${part.text.trimEnd()}\n`;
      const intact = input.whole && !pending && /\.md$/i.test(file);
      entries.push({ path: destination, title: name, kind: category, source: file, sourceHash, start: part.start, end: part.end,
        pending, bytes: intact ? bytes : Buffer.from(body) });
      if (!pending) recognized.add(key);
      occupied.add(destination.toLowerCase());
    }
  }
  const collisions = new Set();
  const keys = new Set();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    if (keys.has(key) || await workspace.store.read(entry.path)) collisions.add(entry.path);
    keys.add(key);
  }
  const token = hash(Buffer.from(JSON.stringify(entries.map(({ bytes, ...entry }) => ({ ...entry, hash: hash(bytes) })))));
  return { token, entries, collisions: [...collisions], skipped };
}

export const libraryMethods = {
  async previewLibrary(options) {
    const plan = await prepare(this, options);
    return { token: plan.token, total: plan.entries.length, collisions: plan.collisions, skipped: plan.skipped,
      items: plan.entries.map(({ bytes, ...entry }) => entry) };
  },
  async buildIndependentLibrary({ token, ...options }) {
    if (this.controllers.size) throw new AppError('BUSY', '请在当前 Agent 任务结束后整理资料');
    const plan = await prepare(this, options);
    if (plan.token !== token || plan.collisions.length) throw new AppError('CONFLICT', '资料来源或目标目录已变化，请重新预览');
    if (!plan.entries.length) throw new AppError('VALIDATION', '当前没有待整理的资料');
    const next = structuredClone(this.project);
    next.libraryOriginals ||= {};
    for (const entry of plan.entries) {
      next.libraryOriginals[entry.source] ||= [];
      next.libraryOriginals[entry.source].push({ path: entry.path, sourceHash: entry.sourceHash, start: entry.start, end: entry.end, adopted: !!entry.documentId });
      if (entry.documentId) {
        next.documents[entry.path] = { ...next.documents[entry.source], path: entry.path, readOnly: false };
        delete next.documents[entry.source];
      }
    }
    const adopted = new Set(plan.entries.filter(entry => entry.documentId).map(entry => entry.source));
    next.sources = next.sources.filter(source => {
      if (!source.readOnly) return true;
      const base = source.path.replaceAll('\\', '/').replace(/\/$/, '');
      const matching = this.documents.filter(doc => doc.path === base || doc.path.startsWith(`${base}/`));
      return !matching.length || matching.some(doc => !adopted.has(doc.path));
    });
    for (const item of plan.entries) {
      const destination = path.posix.dirname(item.path);
      if (!next.sources.some(s => s.path === destination)) next.sources.push({ kind: item.kind, path: destination, depth: 0 });
    }
    const changes = plan.entries.map(entry => ({ path: entry.path, expectedHash: null, bytes: entry.bytes }));
    const manifest = `${library}/_来源清单-${stamp().replace(/[^0-9]/g, '')}.json`;
    changes.push({ path: manifest, expectedHash: null, text: JSON.stringify(next.libraryOriginals, null, 2) });
    const entry = await this.commit('建立独立作品资料库', changes, next);
    return { count: plan.entries.length, copied: plan.entries.filter(item => !!item.documentId).length,
      pending: plan.entries.filter(item => item.pending).length, directory: library, batchId: entry.id };
  },
  async classifyLibraryDocument({ documentId, expectedHash, kind }) {
    const d = this.doc(documentId);
    if (d.kind !== 'reference' || d.readOnly || !/^创作资料库\/待核对\/[^/]+\.md$/u.test(d.path) || !classifiable.has(kind)) {
      throw new AppError('VALIDATION', '请选择独立资料库中的待核对文件及对应分类');
    }
    const bytes = await this.store.read(d.path);
    if (!bytes || d.hash !== expectedHash || hash(bytes) !== expectedHash) {
      throw new AppError('CONFLICT', '待核对文件已变化，请重新打开');
    }
    const directory = `${library}/${folders[kind]}`;
    const destination = `${directory}/${safeName(d.title)}.md`;
    if (await this.store.read(destination)) throw new AppError('CONFLICT', '该分类已有同名资料，请比较原文后处理');
    const next = structuredClone(this.project);
    next.documents[destination] = { ...next.documents[d.path], path: destination, kind };
    delete next.documents[d.path];
    if (!next.sources.some(s => s.path === directory)) next.sources.push({ kind, path: directory, depth: 0 });
    for (const entries of Object.values(next.libraryOriginals || {})) {
      for (const entry of entries) if (entry.path === d.path) entry.path = destination;
    }
    await this.commit('作者归类独立库资料', [
      { path: destination, expectedHash: null, bytes }, { path: d.path, expectedHash, bytes: null },
    ], next);
    return this.summary().documents.find(doc => doc.id === d.id);
  },
  async registerLocationMap({ relativePath }) {
    if (typeof relativePath !== 'string' || !isMapPath(relativePath)) throw new AppError('VALIDATION', '请选择地图图片、PDF 或 HTML 文件');
    const relative = path.posix.normalize(relativePath.replaceAll('\\', '/'));
    const full = await this.store.resolve(relative);
    if (!(await fs.stat(full).catch(() => null))?.isFile()) throw new AppError('SOURCE', '地图文件已移除');
    const existing = this.documents.find(d => d.path.toLowerCase() === relative.toLowerCase() && d.kind === 'attachment');
    if (existing) return { documentId: existing.id };
    const next = structuredClone(this.project);
    next.sources.push({ kind: 'attachment', path: relative, depth: 0, readOnly: true });
    await this.commit('登记本地地图附件', [], next);
    return { documentId: this.documents.find(d => d.path === relative && d.kind === 'attachment')?.id };
  },
};
