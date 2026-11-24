import { WORLD_SOURCE_KINDS } from './catalog.mjs';
import { RESEARCH_SETTINGS_FOLDER, researchNatures } from './research.mjs';
import { findLocationReferences, locationMapVersion } from './location-maps.mjs';

const recordKinds = new Set(['organization', 'location', 'item']);
const pendingStatuses = new Set(['candidate', 'unknown', 'abandoned']);
const lower = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase() : '';

function nameScore(term, title, aliases) {
  const names = [title, ...(Array.isArray(aliases) ? aliases : String(aliases || '').split(/[，、,]/u))].map(lower);
  return names.includes(term) ? 6 : names.some(name => name.includes(term)) ? 4 : 0;
}

function excerpt(text, term) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<!-- storydesk:[^\r\n]+:start -->[\s\S]*?<!-- storydesk:[^\r\n]+:end -->/g, '').trim();
  const at = Math.max(0, body.toLocaleLowerCase().indexOf(term) - 75);
  return body.slice(at, at + 430);
}

const isResearch = (doc, metadata) => !!metadata?.research || doc.path.startsWith(RESEARCH_SETTINGS_FOLDER + '/');

function researchInScope(metadata, chapter) {
  if (!metadata?.research) return false;
  const { fromChapter, toChapter } = metadata.research;
  if (fromChapter == null && toChapter == null) return true;
  return Number.isInteger(chapter) &&
    (fromChapter == null || chapter >= fromChapter) && (toChapter == null || chapter <= toChapter);
}

function rulingDocuments(workspace) {
  return new Set(workspace.project.approvals.filter(a => a.kind === 'ruling' && a.status === 'active')
    .map(a => a.documentId + ':' + a.sourceHash));
}

function settingConfirmed(workspace, doc, metadata, approvals) {
  return !!metadata?.confirmed && approvals.has(doc.id + ':' + doc.hash) && !workspace.project.externalChanges[doc.id];
}

function researchReference(doc, metadata, content, term = '') {
  const entries = Array.isArray(metadata.research.sources) ? metadata.research.sources : [];
  const sources = entries.filter(source => source?.type === 'web' && typeof source.title === 'string' &&
      typeof source.url === 'string' && source.url.length <= 360)
    .slice(0, 1).map(source => ({ title: source.title.slice(0, 65), url: source.url }));
  return { title: doc.title, path: doc.path, nature: metadata.nature, scope: metadata.scope,
    status: `作者已确认 · ${researchNatures[metadata.nature] || '设定'}`,
    excerpt: excerpt(content, term), ...(sources.length ? { sources } : {}) };
}

export async function confirmedResearchSettings(workspace, chapter, hints, readPinned) {
  const approvals = rulingDocuments(workspace);
  const search = lower(hints);
  const choices = [];
  for (const doc of workspace.documents) {
    if (doc.kind !== 'setting' || doc.error) continue;
    const meta = workspace.project.settingMeta?.[doc.id];
    if (!researchInScope(meta, chapter) || !settingConfirmed(workspace, doc, meta, approvals)) continue;
    const title = lower(doc.title);
    const terms = title.split(/[\s、，：·/()（）-]+/u).filter(word => word.length > 1);
    const relevance = title && search.includes(title) ? 4 : terms.some(word => search.includes(word)) ? 2 : 0;
    choices.push({ doc, meta, relevance });
  }
  choices.sort((a, b) => b.relevance - a.relevance || String(b.meta.updated_at).localeCompare(String(a.meta.updated_at)));
  const settings = [];
  let chars = 0;
  for (const { doc, meta } of choices.slice(0, 4)) {
    const content = await readPinned(doc.path, doc.hash);
    if (typeof content !== 'string') continue;
    const reference = researchReference(doc, meta, content);
    chars += JSON.stringify(reference).length;
    if (chars > 2400) break;
    settings.push(reference);
    if (settings.length >= 3) break;
  }
  return settings;
}

export function worldContextVersion(workspace) {
  const sources = workspace.documents.filter(doc => WORLD_SOURCE_KINDS.has(doc.kind))
    .map(doc => [doc.id, doc.hash, doc.kind]).sort();
  const cards = workspace.records.filter(record => recordKinds.has(record.kind))
    .map(record => [record.id, workspace.project.managedHeads?.[`_创作管理/资料/${record.id}.md`]?.hash, !!record.externalPending]).sort();
  const versions = new Set(sources.map(([id, hash]) => id + ':' + hash));
  const adopted = workspace.project.approvals.filter(approval => approval.kind === 'ruling' &&
    approval.status === 'active' && versions.has(approval.documentId + ':' + approval.sourceHash))
    .map(approval => approval.id).sort();
  const maps = locationMapVersion(workspace);
  return maps ? [sources, cards, adopted, maps] : [sources, cards, adopted];
}

export async function findWritingSetting(workspace, query, readPinned, chapter = null, { researchChapter = chapter } = {}) {
  const term = lower(query);
  if (!term) return { scope: '本作品设定与档案', matches: [] };
  const places = await findLocationReferences(workspace, query, readPinned, { lookup: true });
  const matches = places.map(place => ({ ...place, kind: 'location',
    status: place.map.available ? '作者指定现行地图' : '指定地图文件不可用', path: place.map.path }));
  const linkedPaths = new Set(places.flatMap(place => place.settings.map(setting => setting.path)));
  const historicalPaths = new Set(workspace.locationMaps?.historicalPaths);
  const indexed = new Set([...WORLD_SOURCE_KINDS].flatMap(kind =>
    workspace.index.search(workspace.project.id, query, kind).slice(0, 4).map(row => row.id)));
  const approvals = rulingDocuments(workspace);
  const candidates = [];
  for (const doc of workspace.documents.filter(d => WORLD_SOURCE_KINDS.has(d.kind) && !d.error)) {
    if (linkedPaths.has(doc.path) || historicalPaths.has(doc.path)) continue;
    const score = nameScore(term, doc.title, doc.aliases) || (indexed.has(doc.id) ? 1 : 0);
    if (!score) continue;
    const meta = workspace.project.settingMeta?.[doc.id];
    const confirmed = settingConfirmed(workspace, doc, meta, approvals);
    if (isResearch(doc, meta) && (!confirmed || !researchInScope(meta, researchChapter))) continue;
    candidates.push({ doc, meta, confirmed, score: score * 3 + (confirmed ? 2 : 0) });
  }
  for (const record of workspace.records.filter(r => recordKinds.has(r.kind) && !r.damaged && !r.externalPending &&
    !r.unreviewedExternal && !pendingStatuses.has(r.status))) {
    const score = nameScore(term, record.title, record.details?.aliases) || (lower(record.body).includes(term) ? 1 : 0);
    if (!score) continue;
    candidates.push({ record, score: score * 3 + (record.status === 'active' ? 2 : 0) });
  }
  const currentScope = !chapter || chapter >= Math.max(1, ...workspace.documents.filter(d => d.kind === 'chapter').map(d => d.chapter || 0));
  const name = id => workspace.project.characters.find(c => c.id === id && c.status !== 'merged')?.name;
  for (const { doc, meta, confirmed, record } of candidates.sort((a, b) => b.score - a.score)) {
    if (matches.length >= 3) break;
    if (doc) {
      const content = await readPinned(doc.path, doc.hash);
      if (typeof content !== 'string') continue;
      if (meta?.research) matches.push({ kind: doc.kind, ...researchReference(doc, meta, content, term) });
      else matches.push({ title: doc.title, kind: doc.kind, path: doc.path,
        status: confirmed ? '作者已确认' : '待核对原档', nature: meta?.nature, scope: meta?.scope,
        ...(confirmed && meta.summary ? { authorNote: meta.summary.slice(0, 300) } : {}),
        excerpt: excerpt(content, term) });
    } else {
      const path = `_创作管理/资料/${record.id}.md`;
      const registered = workspace.project.managedHeads?.[path];
      if (!registered || typeof await readPinned(path, registered.hash) !== 'string') continue;
      const details = record.details || {};
      const members = record.kind === 'organization' && Array.isArray(details.members) ? details.members
        .filter(m => !chapter || (!m.fromChapter || m.fromChapter < chapter) && (!m.toChapter || m.toChapter >= chapter))
        .map(m => ({ name: name(m.characterId), role: String(m.role || '').slice(0, 60) })).filter(m => m.name).slice(0, 6) : [];
      const maps = record.kind === 'location' ? workspace.documents.filter(d => d.kind === 'attachment' && details.attachmentDocIds?.includes(d.id))
        .map(d => d.title).slice(0, 4) : [];
      matches.push({ title: record.title, kind: record.kind, path, excerpt: excerpt(record.body, term),
        status: record.status === 'active' ? '作者维护的档案' : record.status === 'planned' ? '作者已定计划' : '作者档案',
        ...(members.length ? { members } : {}), ...(maps.length ? { maps } : {}),
        ...(record.kind === 'location' && details.region ? { region: String(details.region).slice(0, 120) } : {}),
        ...(record.kind === 'item' && currentScope && details.currentHolderId ? { currentHolder: name(details.currentHolderId) } : {}) });
    }
  }
  return { scope: '本作品内按关键词定位。待核对原档、史料、人物说法和已有计划保留各自性质。', matches };
}
