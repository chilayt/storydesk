import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, decode, uid } from './io.mjs';
import { isImportedTextPath } from './text-import.mjs';

export const WORLD_SOURCE_KINDS = new Set(['setting', 'organization', 'family', 'location', 'item']);
export const MAP_EXTENSIONS = ['html', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'pdf'];
export const isMapPath = file => MAP_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());
const attachmentFor = (file, kind) => /\.html$/i.test(file) || kind === 'attachment' && isMapPath(file);
const supportedFile = (file, kind) => kind === 'attachment' ? isMapPath(file) : /\.(md|html)$/i.test(file);

export const DEFAULT_SOURCES = [
  { path: '05-剧本/正文', kind: 'chapter', depth: 0 },
  { path: '05-剧本/草稿章节', kind: 'draft', depth: 0 },
  { path: '01-人物/人物分档', kind: 'character', depth: 0 },
  { path: '01-人物', kind: 'reference', depth: 0 },
  { path: '01-人物/士族分档', kind: 'family', depth: 0 },
  { path: '02-势力', kind: 'organization', depth: 0 },
  { path: '03-世界观', kind: 'setting', depth: 2 },
  { path: '05-剧本/设定', kind: 'plan', depth: 1 },
  { path: '05-剧本/_本地协作', kind: 'rule', depth: 0 },
  { path: '05-剧本/剧情推进.md', kind: 'plot', depth: 0 },
  { path: '04-空间', kind: 'location', depth: 0 },
  { path: '正文', kind: 'chapter', depth: 1 },
  { path: '草稿章节', kind: 'draft', depth: 0 },
  { path: '人物', kind: 'character', depth: 0 },
  { path: '设定', kind: 'setting', depth: 1 },
  { path: '资料', kind: 'reference', depth: 1 }
];
const ignored = name => name.startsWith('.') || /^_|备份|旧版|node_modules|历史稿/.test(name);

export async function addNovelLibrarySources(store, project) {
  if (project.sourceProfiles?.includes('novel-kb-v1')) return false;
  const index = await store.resolve('novel-kb/00-索引/README.md');
  if (!(await fs.stat(index).catch(() => null))?.isFile()) return false;
  const parsed = await store.resolve('_已解析');
  const ranges = await fs.readdir(parsed, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = [
    ...ranges.filter(entry => entry.isDirectory() && /\d{1,5}\s*[-—–至]\s*\d{1,5}$/u.test(entry.name))
      .map(entry => ({ path: '_已解析/' + entry.name, kind: 'chapter' })),
    { path: 'novel-kb/01-实体/人物', kind: 'character' },
    { path: 'novel-kb/03-剧情', kind: 'plan' },
  ];
  const existing = new Set(project.sources.map(s => s.path.replaceAll('\\', '/').toLowerCase()));
  const sources = [];
  for (const source of candidates) {
    const full = await store.resolve(source.path);
    if (!existing.has(source.path.toLowerCase()) && (await fs.stat(full).catch(() => null))?.isDirectory()) {
      sources.push({ ...source, depth: 0, readOnly: true });
    }
  }
  if (!sources.length) return false;
  project.sources.push(...sources);
  project.sourceProfiles = [...(project.sourceProfiles || []), 'novel-kb-v1'];
  return true;
}

export function chapterNumber(name) {
  const m = name.match(/第\s*([\d一二三四五六七八九十百零〇两]+)\s*[章回]/);
  if (!m) return null; if (/^\d+$/.test(m[1])) return Number(m[1]);
  const digit = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let n = 0, pending = 0;
  for (const c of m[1]) { if (c === '十' || c === '百') { n += (pending || 1) * (c === '十' ? 10 : 100); pending = 0; } else pending = digit[c] ?? 0; }
  return n + pending;
}

const chapterMaterialPatterns = [
  { role: 'review', kind: 'reference',
    marker: /^(?:(?:初稿|新稿|改后稿|修订稿|正文|设计稿)[\s_.·—-]*)?(?:复核|审读|审稿|校对|审阅|违规清单|门禁报告|检查清单|检查报告)/u },
  { role: 'design', kind: 'plan', marker: /^(?:剧情设计|剧情大纲|设计初稿|设计稿|分场|章纲|大纲|提纲|创作任务书|任务书)/u },
  { role: 'reference', kind: 'reference', marker: /^(?:全量材料|材料汇总|材料包|前情包|资料包|来料)/u },
  { role: 'draft', kind: 'draft', marker: /^(?:正文初稿|初稿|新稿|改后稿|修订后稿|修订稿|正文稿|草稿|待审稿)/u },
];

function chapterMaterial(relativePath) {
  const stem = path.posix.basename(relativePath, path.extname(relativePath)).normalize('NFKC');
  const prefix = /^(?:\d+[\s_.·—-]+)?第\s*[\d一二三四五六七八九十百零〇两]+\s*[章回]/u.exec(stem);
  if (!prefix) return null;
  const chapter = chapterNumber(prefix[0]);
  if (!Number.isInteger(chapter) || chapter < 1) return null;
  const purpose = stem.slice(prefix[0].length).replace(/^[\s_.·—-]+/u, '');
  if (/^(?:本章规则|写作规则|文风|硬线|场次交接卡)/u.test(purpose)) return null;
  for (const { role, kind, marker } of chapterMaterialPatterns) {
    const label = marker.exec(purpose)?.[0];
    if (label) return { chapter, role, kind, label };
  }
  return { chapter, role: 'reference', kind: 'reference', label: '章节参考' };
}
export const plain = s => String(s).replace(/[*_`]/g, '').replace(/<[^>]*>/g, '').trim();
function worldNames(text) {
  const header = /^---\r?\n([\s\S]{0,4096}?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!header) return {};
  const field = keys => header.match(new RegExp(`^(?:${keys})\\s*[:：]\\s*([^\\r\\n]+)`, 'mi'))?.[1] || '';
  const clean = value => plain(value.trim().replace(/^["']|["']$/g, '')).slice(0, 120);
  const name = clean(field('名称|name'));
  const aliases = field('别名|aliases').replace(/^\[|\]\s*$/g, '').split(/[，、,]/u).map(clean).filter(Boolean).slice(0, 12);
  return { ...(name ? { name } : {}), ...(aliases.length ? { aliases } : {}) };
}
export function sections(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'); const result = []; let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,5})\s+(.+)$/.exec(lines[i]);
    if (m) { if (current) result.push(current); current = { heading: plain(m[2]), level: m[1].length, line: i + 1, text: '' }; }
    else if (current) current.text += `${lines[i]}\n`;
  }
  if (current) result.push(current); return result;
}
export function candidateFields(text) {
  return sections(text).filter(s => s.level === 2 && !/剧情|进展|程序归档|已确认初始基座/.test(s.heading)).map(s => ({ field: s.heading.replace(/^[〇零一二三四五六七八九十\d]+[、.．]\s*/, ''), value: s.text.trim(), sourceLine: s.line + 1, confirmed: false })).filter(s => s.value);
}
export async function discover(store, project) {
  const found = new Map();
  const activeProse = new Set((project.approvals || []).filter(a => a.kind === 'prose' && a.status === 'active').map(a => a.documentId));
  const pathKey = relative => process.platform === 'win32' ? relative.toLowerCase() : relative;
  const previousByPath = new Map([...Object.values(project.missingDocuments || {}), ...Object.values(project.documents)]
    .map(document => [pathKey(document.path), document]));
  const importHistory = new Map();
  const importsWithoutDates = new Set([...previousByPath].filter(([, d]) => isImportedTextPath(d.path) && !d.importedAt).map(([key]) => key));
  if (importsWithoutDates.size) {
    for (const batch of (await store.history()).filter(row => row.label === '导入文本资料' && row.status === 'committed')) {
      batch.files.forEach((file, order) => {
        const key = pathKey(file.path);
        if (importsWithoutDates.delete(key)) importHistory.set(key, { importedAt: batch.created_at, importOrder: order });
      });
      if (!importsWithoutDates.size) break;
    }
  }
  const retiredPaths = new Set(Object.values(project.sourceHistory?.retired || {})
    .flatMap(document => [document.path, document.archivePath].filter(Boolean).map(pathKey)));
  const releasedDraftPaths = new Set(Object.values(project.chapterPublications || {}).map(row => pathKey(row.from)));
  const movedSources = new Map((project.sourceHistory?.moves || []).map(move => [move.documentId, move]));
  async function visit(relative, kind, depth, readOnly, keepRegistration = false) {
    const full = await store.resolve(relative); let stat;
    try { stat = await fs.stat(full); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (stat.isDirectory()) {
      const items = await fs.readdir(full, { withFileTypes: true });
      for (const item of items) {
        if ((item.isDirectory() && ignored(item.name)) || item.name.startsWith('.') || item.isSymbolicLink()) continue;
        if (kind === 'character' && readOnly && /^_模板/.test(item.name)) continue;
        if (item.isDirectory() && depth > 0) await visit(`${relative}/${item.name}`, kind, depth - 1, readOnly);
        else if (item.isFile() && supportedFile(item.name, kind)) await visit(`${relative}/${item.name}`, kind, depth, readOnly);
      }
      return;
    }
    if (!supportedFile(relative, kind)) return;
    const relativePath = relative.replaceAll('\\', '/');
    const key = pathKey(relativePath);
    if (found.has(key) || retiredPaths.has(key) || releasedDraftPaths.has(key)) return;
    if (project.libraryOriginals?.[relativePath]?.some(entry => entry.adopted)) return;
    const previous = previousByPath.get(key);
    const attachment = attachmentFor(relative, kind);
    const bytes = attachment ? null : await fs.readFile(full);
    let text = '', format = {}, error = null;
    if (bytes) { try { ({ text, ...format } = decode(bytes)); } catch (e) { error = e.message; } }
    const names = WORLD_SOURCE_KINDS.has(kind) ? worldNames(text) : {};
    const title = names.name || plain(text.match(/^#\s+(.+)$/m)?.[1] || path.basename(relativePath, path.extname(relativePath)));
    const collaboration = kind === 'rule' && /(?:^|\/)_本地协作\//u.test(relativePath);
    const namedMaterial = !attachment && (collaboration || kind === 'plan') ? chapterMaterial(relativePath) : null;
    const material = collaboration || namedMaterial?.role === 'design' ? namedMaterial : null;
    const legacyDraft = kind === 'rule' && !collaboration && /初稿/.test(relativePath);
    const actualKind = attachment ? 'attachment' : keepRegistration ? kind : material?.kind ?? (legacyDraft ? 'draft' : kind);
    const entry = { id: previous?.id || uid('doc'), path: relativePath, title, kind: actualKind, size: stat.size, modified: stat.mtime.toISOString(), hash: bytes ? hash(bytes) : null, format, text, error, chapter: ['chapter', 'draft'].includes(actualKind) ? chapterNumber(relativePath) ?? chapterNumber(title) : null };
    if (kind === 'reference' && isImportedTextPath(relativePath) && !error) {
      const saved = previous?.importedAt ? { importedAt: previous.importedAt, importOrder: previous.importOrder }
        : importHistory.get(key) || { importedAt: stat.birthtime.toISOString(), importOrder: 0 };
      Object.assign(entry, saved);
      const heading = title.trim().normalize('NFKC');
      const chapterHint = /^第/u.test(heading) ? chapterNumber(heading) :
        chapterNumber(path.posix.basename(relativePath).normalize('NFKC'));
      if (chapterHint > 0 && chapterHint <= 99999) entry.draftChapterHint = chapterHint;
    }
    if (actualKind === 'draft' && previous?.importedAt) entry.importedAt = previous.importedAt;
    if (names.aliases) entry.aliases = names.aliases;
    if (readOnly || attachment) entry.readOnly = true;
    if (keepRegistration) {
      entry.chapter = previous.chapter;
      if (previous.chapterMaterial) entry.chapterMaterial = previous.chapterMaterial;
    } else if (material) {
      const { kind: materialKind, ...metadata } = material;
      if (materialKind !== 'draft' && activeProse.has(entry.id)) {
        // A registered manuscript approval carries more authority than a filename.
        entry.kind = 'draft';
        entry.chapter = material.chapter;
      } else {
        entry.chapterMaterial = metadata;
      }
    }
    found.set(key, entry);
  }
  for (const move of movedSources.values()) {
    const document = previousByPath.get(pathKey(move.to));
    if (document?.id === move.documentId) await visit(move.to, document.kind, 0, !!document.readOnly, true);
  }
  for (const source of project.sources) await visit(source.path, source.kind, Math.min(source.depth ?? 0, 3), source.readOnly === true);
  // Match by bytes only when there is exactly one absent registration and one new path.
  const knownByHash = Map.groupBy([...previousByPath.values()].filter(d => d.hash), d => d.hash);
  const foundByHash = Map.groupBy([...found.values()].filter(d => d.hash), d => d.hash);
  for (const [contentHash, candidates] of foundByHash) {
    const prior = knownByHash.get(contentHash);
    if (candidates.length !== 1 || prior?.length !== 1) continue;
    const [entry] = candidates, [previous] = prior;
    const previousKey = pathKey(previous.path);
    if (previousByPath.has(pathKey(entry.path)) || found.has(previousKey) || retiredPaths.has(previousKey)
        || project.libraryOriginals?.[previous.path]?.some(item => item.adopted)) continue;
    const exists = await fs.stat(await store.resolve(previous.path)).then(stat => stat.isFile(), error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
      throw error;
    });
    if (!exists) {
      entry.id = previous.id;
      if (previous.readOnly) entry.readOnly = true;
      if (activeProse.has(previous.id) || previous.kind === entry.kind) {
        entry.kind = previous.kind;
        entry.chapter = previous.chapter;
        entry.chapterMaterial = previous.chapterMaterial;
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.chapter ?? 99999) - (b.chapter ?? 99999) || a.path.localeCompare(b.path, 'zh-CN'));
}
function tableCharacters(doc) {
  const candidates = []; let header = null;
  for (const line of doc.text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { header = null; continue; }
    const cells = line.split('|').slice(1, -1).map(plain);
    if (!header && cells.some(c => /^(名|姓名|人物|人|帮主)$/.test(c))) { header = cells; continue; }
    if (!header || cells.every(c => /^[:\s-]*$/.test(c))) continue;
    for (let col = 0; col < cells.length; col++) {
      if (!/^(名|姓名|人物|人|帮主)$/.test(header[col])) continue;
      for (const n of cells[col].split(/[／/]/)) {
        const name = n.replace(/（.*?）|\(.*?\)/g, '').split(/[，,·：:]/)[0].trim();
        if (/^[\p{Script=Han}]{2,6}$/u.test(name) && !/众人|四人|未建卡|家主|待定|社长|女子|追兵|门客|本章|清客/.test(name)) candidates.push({ name, excerpt: line.trim() });
      }
    }
  }
  return candidates;
}
export function importEntities(documents, project) {
  const result = structuredClone(project.characters || []);
  project.identityConflicts = [];
  for (const c of result) c.sourceIds = c.sourceIds || [];
  const add = (name, doc, excerpt, registered) => {
    let c = result.find(c => c.sourceIds.includes(doc.id) && doc.kind === 'character');
    if (c?.status === 'merged') c = result.find(item => item.id === c.redirectTo);
    const names = result.filter(c => (c.name === name || c.aliases.includes(name)) && c.status !== 'merged');
    if (!c && names.length > 1) { project.identityConflicts.push({ name, documentId: doc.id, excerpt, reason: '同名人物无法唯一对应' }); return; }
    if (!c && names.length === 1) {
      if (doc.kind !== 'character' || !names[0].primarySourceId || names[0].aliases.includes(name)) c = names[0];
      else project.identityConflicts.push({ name, documentId: doc.id, excerpt, reason: '独立人物卡与已有同名人物需核对' });
    }
    if (!c) { c = { id: uid('char'), work_id: project.id, name, aliases: [], sourceIds: [], sourceEvidence: [], status: registered ? 'registered' : 'candidate', created_at: new Date().toISOString(), revision: 1 }; result.push(c); }
    if (!c.sourceIds.includes(doc.id)) c.sourceIds.push(doc.id);
    if (registered) { if (!c.primarySourceId || c.primarySourceId === doc.id) c.primarySourceId = doc.id; c.status = 'registered'; }
    if (excerpt && !c.sourceEvidence.some(s => s.documentId === doc.id && s.quote === excerpt)) c.sourceEvidence.push({ documentId: doc.id, quote: excerpt });
  };
  for (const doc of documents.filter(d => d.kind === 'character')) {
    const filename = path.basename(doc.path, '.md');
    const indexedCard = doc.path.startsWith('novel-kb/01-实体/人物/') && /^P\d+-/i.test(filename);
    const heading = doc.text.match(/^#\s+(.+)$/m);
    const name = indexedCard ? (heading ? plain(heading[1]) : filename).replace(/^P\d+\s*[-·－]\s*/i, '') : filename;
    add(name, doc, indexedCard && heading ? heading[0] : doc.text.split(/\r?\n/)[0], true);
  }
  for (const doc of documents.filter(d => ['reference', 'family', 'organization', 'plot'].includes(d.kind))) for (const c of tableCharacters(doc)) add(c.name, doc, c.excerpt, false);
  return result;
}
export function managedBlock(text, key, content) {
  const start = `<!-- storydesk:${key}:start -->`, end = `<!-- storydesk:${key}:end -->`;
  const a = text.indexOf(start), b = text.indexOf(end);
  if ((a >= 0) !== (b >= 0) || (a >= 0 && b < a)) throw new Error('程序管理区标记损坏，已停止覆盖');
  const block = `${start}\n${content.trim()}\n${end}`;
  return a < 0 ? `${text.trimEnd()}\n\n${block}\n` : text.slice(0, a) + block + text.slice(b + end.length);
}
export function withSettingMetadata(text, metadata) {
  const nature = { unclassified: '待分类', historical: '历史依据', fiction: '架空裁定', character_claim: '人物说法' }[metadata.nature];
  const lines = ['## 设定信息 · 作者维护', '', '```json', JSON.stringify(metadata, null, 2), '```', '',
    `- 分类：${metadata.category}`, `- 性质：${nature}`, `- 适用范围：${metadata.scope}`,
    `- 状态：${metadata.confirmed ? '作者已确认' : '待核对'}`, '', metadata.summary];
  return managedBlock(text, `setting-${metadata.documentId}`, lines.join('\n'));
}
export function recordMarkdown(record, body = '') {
  return `---\n${JSON.stringify(record, null, 2)}\n---\n\n# ${record.title || record.name || '记录'}\n\n${body}\n`;
}
export function parseRecord(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) throw new Error('记录缺少结构化元数据'); return JSON.parse(m[1]);
}
export function recordBody(text) { return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/^\s*# [^\r\n]+\r?\n/, '').trim(); }
export function replaceRecordHeader(text, record) { return text.replace(/^---\r?\n[\s\S]*?\r?\n---/, () => `---\n${JSON.stringify(record, null, 2)}\n---`); }
