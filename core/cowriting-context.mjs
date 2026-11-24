import { AppError, decode, hash } from './io.mjs';
import { chapterOutlineApprovals, confirmedVolumeOutlines } from './planning.mjs';
import { isRecordedEvent } from './chapter-review.mjs';
import { worldContextVersion } from './world-context.mjs';
import { stagePlans } from './stage-plans.mjs';
import { resolveWritingRules, selectWritingRules } from './writing-rules.mjs';
import { chapterNumber } from './catalog.mjs';

export { findWritingSetting } from './world-context.mjs';

export const WRITING_STYLES = {
  general: '按作品规则续写；沿用本章的视角、叙事距离和人物声口。',
  historical: '按作品确认的时代和称谓写作；用人物身份、场合和说话对象校验用词，历史疑点列供作者判断。',
  modern: '采用贴合人物职业和场景的自然现代汉语，留意时间、地点、器物和信息传播条件。',
};

export function writingRange(workspace, document, sceneId) {
  if (document.planning) return { start: 0, end: Math.min(document.text.length, 4100), label: document.title };
  if (sceneId === 'whole') return { start: 0, end: Math.min(document.text.length, 6500), label: '整章讨论' };
  if (!sceneId) return { start: document.text.length, end: document.text.length, label: '章末续写' };
  const scene = workspace.project.scenes.find(s => s.id === sceneId && s.documentId === document.id);
  if (!scene || scene.sourceHash !== document.hash || scene.start < 0 || scene.end <= scene.start || scene.end > document.text.length) {
    throw new AppError('SCENE', '场景与当前正文版本不一致，请在正文重新划分场景');
  }
  if (scene.end - scene.start > 6500) throw new AppError('INPUT_LIMIT', '所选场景超过 6500 字符，请在正文划分较短场景');
  return { start: scene.start, end: scene.end, label: scene.name };
}

export function chapterPeople(workspace, text) {
  const names = workspace.project.characters.filter(c => c.status !== 'merged');
  return names.filter(c => [c.name, ...c.aliases].some(n => n && text.includes(n))).slice(0, 12).map(c => c.id);
}

export function writingChapterScope(document) {
  return !document.planning || document.planning.type === 'chapter' ? document.chapter : null;
}

function outlineStatus(document, approval) {
  if (approval?.documentId !== document.id) return '本章设计草案 · 待确认';
  return approval.sourceHash === document.hash ? '作者已定章纲 · 计划' : '章纲有修订 · 待重新定案';
}

export function storyContinuityStamp(workspace, chapter = null) {
  const project = workspace.project;
  const heads = project.managedHeads || {};
  const events = workspace.events.filter(isRecordedEvent)
    .map(e => [e.id, heads[`_创作管理/事件/${e.id}.md`]?.hash, !!e.stale, !!e.externalPending]).sort();
  const hooks = workspace.records.filter(r => r.kind === 'hook')
    .map(r => [r.id, heads[`_创作管理/资料/${r.id}.md`]?.hash, !!r.externalPending]).sort();
  const volumes = confirmedVolumeOutlines(workspace).map(({ approval }) =>
    [approval.documentId, approval.sourceHash, approval.fromChapter, approval.toChapter]).sort();
  const stages = workspace.records.filter(r => r.kind === 'plot_arc' && r.details?.fromChapter)
    .map(r => [r.id, heads['_创作管理/资料/' + r.id + '.md']?.hash, !!r.externalPending]).sort();
  const parts = [events, hooks, volumes, project.baselines, worldContextVersion(workspace)];
  if (stages.length) parts.push(stages);
  const chapterOutline = chapter && chapterOutlineApprovals(workspace).get(chapter);
  if (chapterOutline) parts.push([chapterOutline.id, chapterOutline.sourceHash]);
  return hash(Buffer.from(JSON.stringify(parts)));
}

async function storyContinuity(workspace, chapter, readPinned, search, includeLatest) {
  const approvals = new Set(workspace.project.approvals.filter(a => a.status === 'active').map(a => a.id));
  const people = new Set(chapterPeople(workspace, search));
  const relevant = event => Number(search.includes(event.title)) + Number(event.facts.some(f => people.has(f.entity_id)));
  const scoped = workspace.events.filter(event => isRecordedEvent(event) && !event.stale && !event.externalPending &&
    approvals.has(event.approval_id) && (event.source_chapter ? event.source_chapter < chapter : includeLatest) &&
    (event.editorial_layer === 'occurred' || event.facts.some(f => f.status === 'accepted' && ['occurred', 'ruling'].includes(f.layer))));
  const events = [];
  for (const event of scoped.slice().sort((a, b) => relevant(b) - relevant(a) ||
    (b.source_chapter ?? chapter) - (a.source_chapter ?? chapter) || String(b.created_at || '').localeCompare(String(a.created_at || '')))) {
    if (!await pinStoryEvent(workspace, event, readPinned)) continue;
    events.push({ chapter: event.source_chapter, title: event.title, summary: event.summary?.slice(0, 200) || '', time: event.story_time });
    if (events.length >= 3) break;
  }
  const eventIds = new Set(scoped.map(e => e.id));
  const hooks = [];
  const candidates = workspace.records.filter(r => r.kind === 'hook' && !r.damaged && !r.externalPending &&
    !['abandoned', 'candidate', 'unknown'].includes(r.status))
    .sort((a, b) => Number(search.includes(b.title)) - Number(search.includes(a.title)) || b.updated_at.localeCompare(a.updated_at));
  for (const record of candidates) {
    const updates = record.details?.chapterUpdates || [];
    const latest = updates.filter(u => u.chapter < chapter && eventIds.has(u.eventId)).sort((a, b) => b.chapter - a.chapter || b.at.localeCompare(a.at))[0];
    const from = record.details?.introducedChapter;
    if (updates.length && !latest || from && from >= chapter || !updates.length && !from && !includeLatest && record.status !== 'planned') continue;
    if (latest && !await pinStoryEvent(workspace, scoped.find(e => e.id === latest.eventId), readPinned)) continue;
    const path = `_创作管理/资料/${record.id}.md`, head = workspace.project.managedHeads?.[path];
    if (!head || !await readPinned(path, head.hash)) continue;
    const status = latest?.status || (record.details?.paidOffChapter >= chapter && record.status === 'paid_off' ? 'progressing' : record.status);
    hooks.push({ title: record.title, status, chapter: latest?.chapter ?? from ?? null,
      note: latest?.summary?.slice(0, 160) || '', target: String(record.details?.targetRange || '').slice(0, 100) });
    if (hooks.length >= 3) break;
  }
  return { events, hooks };
}

async function pinStoryEvent(workspace, event, readPinned) {
  if (!event) return false;
  const head = workspace.project.managedHeads?.[`_创作管理/事件/${event.id}.md`];
  if (!head || event.externalPending) return false;
  if (event.source_document_id) {
    const source = workspace.documents.find(d => d.id === event.source_document_id);
    if (!source || await readPinned(source.path, event.source_hash) === null) return false;
  }
  return await readPinned(`_创作管理/事件/${event.id}.md`, head.hash) !== null;
}

export const mentionsStagePlan = text => /阶段性|阶段(?:的)?(?:剧情|计划|规划|大纲)|剧情线/u.test(text);

async function readStagePlan(workspace, plan, readPinned, limit, withDescription = false) {
  if (!plan.hash || await readPinned(plan.path, plan.hash) === null) return null;
  const record = withDescription && workspace.records.find(r => r.id === plan.id);
  const description = record ? String(record.details?.goal || record.body || '').slice(0, 1700) : plan.description;
  let budget = limit - description.length;
  const nodes = [];
  for (const node of plan.nodes) {
    if (budget <= 0) break;
    const verified = !node.event || await pinStoryEvent(workspace, workspace.events.find(event => event.id === node.event.id), readPinned);
    const item = { ...node, note: node.note?.slice(0, 200), ...(verified ? {} : { state: 'review', event: null }) };
    budget -= JSON.stringify(item).length;
    if (budget < 0) break;
    nodes.push(item);
  }
  return { ...plan, description, nodes, ...(nodes.length < plan.nodes.length ? { totalNodes: plan.nodes.length } : {}) };
}

export async function findWritingStagePlans(workspace, { query = '', chapter = null }, readPinned) {
  if (typeof query !== 'string' || query.length > 80 || chapter !== null && (!Number.isInteger(chapter) || chapter < 1 || chapter > 99999)) {
    throw new AppError('VALIDATION', '请提供阶段名称或有效章号');
  }
  const term = query.trim().toLowerCase();
  const plans = stagePlans(workspace, chapter).filter(plan => plan.hash);
  const matches = plans.filter(plan => !term || plan.title.toLowerCase().includes(term) || plan.id === term);
  const candidates = matches.slice(0, 8).map(({ id, title, fromChapter, toChapter }) => ({ id, title, fromChapter, toChapter }));
  if (matches.length !== 1) return { candidates, matchCount: matches.length, matches: [] };
  const match = await readStagePlan(workspace, matches[0], readPinned, 3600, true);
  return { candidates, matchCount: matches.length, matches: match ? [match] : [] };
}

export async function writingContext(workspace, document, range, sceneId, words = '', rulesSelection = null) {
  const chapterScope = writingChapterScope(document) ?? document.draftChapterHint;
  const writingRules = selectWritingRules(rulesSelection || await resolveWritingRules(workspace), chapterScope,
    document.text.slice(range.start, range.end) + '\n' + words);
  const heads = { ...writingRules.heads };
  async function readPinned(relative, expected) {
    const bytes = await workspace.store.read(relative);
    if (!bytes || (expected && expected !== hash(bytes))) return null;
    heads[relative] = { path: relative, hash: hash(bytes) };
    return decode(bytes).text;
  }
  const earlierChapters = workspace.documents.filter(d => d.kind === 'chapter' && d.chapter < document.chapter)
    .sort((a, b) => b.chapter - a.chapter);
  const confirmedPrevious = earlierChapters.find(d => workspace.project.approvals.some(a =>
    a.documentId === d.id && a.kind === 'prose' && !a.sceneId && a.sourceHash === d.hash && a.status === 'active'));
  const previous = document.planning && earlierChapters[0] ? earlierChapters[0] : confirmedPrevious;
  const previousText = previous && await readPinned(previous.path, previous.hash);
  const obligations = document.planning ? { items: [], signature: '' } : workspace.revisionObligations(document.id);
  for (const card of obligations.items) {
    if (await readPinned(`_创作管理/场景义务/${card.id}.md`, card.hash) === null) {
      throw new AppError('CONFLICT', '场景义务已有外部修改，请先核对');
    }
  }
  const outlines = [];
  const approvedOutline = chapterScope && chapterOutlineApprovals(workspace).get(chapterScope);
  const plans = workspace.documents.filter(d => d.kind === 'plan' && !d.error &&
    (d.id === approvedOutline?.documentId || !workspace.project.hiddenChapterMaterials?.includes(d.id)));
  const ownOutline = plans.find(d => d.path === document.path && d.chapterMaterial?.role === 'design' &&
    d.chapterMaterial.chapter === chapterScope);
  const candidates = plans.filter(d => d.path !== document.path);
  const localDesigns = candidates.filter(d => d.chapterMaterial?.role === 'design' &&
    d.chapterMaterial.chapter === chapterScope);
  const chapterDesigns = approvedOutline
    ? localDesigns.filter(d => d.id === approvedOutline.documentId)
    : localDesigns.slice(0, 2);
  const bookOutline = candidates.find(d => /^(全书|主线)大纲/.test(d.title) || /\/(?:全书|主线)大纲\.md$/.test(d.path));
  for (const d of [...chapterDesigns, bookOutline].filter(Boolean)) {
    const text = await readPinned(d.path, d.hash);
    const decided = workspace.project.approvals.some(a => a.documentId === d.id && a.sourceHash === d.hash &&
      a.kind === 'plan' && a.status === 'active');
    if (text) outlines.push({ title: d.title, path: d.path,
      status: d.chapterMaterial?.role === 'design' ? outlineStatus(d, approvedOutline)
        : decided ? '作者已确认的设计 · 计划' : '规划参考',
      excerpt: text.slice(0, 900) });
  }
  const volumes = confirmedVolumeOutlines(workspace).filter(({ approval }) =>
    approval.fromChapter <= document.chapter && document.chapter <= approval.toChapter);
  for (const { approval, document: volume } of volumes) {
    const content = await readPinned(volume.path, approval.sourceHash);
    if (content) {
      const exactChapter = new RegExp(`(?:^|\\n)[^\\n]*第\\s*${document.chapter}\\s*章`, 'u').exec(content);
      const excerpt = exactChapter && exactChapter.index > 800
        ? `${content.slice(0, 430)}\n…\n${content.slice(exactChapter.index, exactChapter.index + 920)}` : content.slice(0, 1350);
      outlines.unshift({ title: volume.title, path: volume.path, status: '作者已定卷纲', fromChapter: approval.fromChapter, toChapter: approval.toChapter, excerpt });
    }
  }
  const includeLatest = document.chapter >= Math.max(1, ...workspace.documents.filter(d => d.kind === 'chapter').map(d => d.chapter || 0));
  const search = words + document.text.slice(Math.max(0, range.start - 500), Math.min(range.end, range.start + 1500)) +
    (previousText?.slice(-430) || '') + (outlines[0]?.excerpt || '');
  const names = chapterPeople(workspace, search).slice(0, 3).map(id => workspace.character(id).name);
  const continuity = await storyContinuity(workspace, document.chapter, readPinned, search, includeLatest);
  const stages = [];
  let stageBudget = 2800;
  const namedPlans = stagePlans(workspace).filter(plan => words.includes(plan.title));
  const requestedChapter = mentionsStagePlan(words) ? chapterNumber(words.normalize('NFKC')) : null;
  const applicablePlans = stagePlans(workspace, requestedChapter || (document.planning?.type === 'stage' ? null : document.chapter));
  const selectedPlans = [...new Map([...namedPlans, ...applicablePlans].map(plan => [plan.id, plan])).values()].slice(0, 3);
  for (const plan of selectedPlans) {
    if (stageBudget <= 0) break;
    const stage = await readStagePlan(workspace, plan, readPinned, stageBudget, namedPlans.some(row => row.id === plan.id));
    if (!stage) continue;
    stageBudget -= JSON.stringify(stage).length;
    stages.push(stage);
  }
  const characterStates = names.length ? (await findWritingFacts(workspace, document.chapter, names, readPinned, { includeLatest })).characters : [];
  return {
    heads, readPinned, obligations, includeLatest, sceneId, chapterScope, writingRules,
    confirmedPreviousDocument: previousText && previous === confirmedPrevious ? previous : null,
    input: {
      work: workspace.project.name, chapter: document.title, scope: range.label,
      era: workspace.project.settings.era || '',
      beforeScope: document.text.slice(Math.max(0, range.start - 700), range.start),
      currentScope: document.text.slice(range.start, range.end),
      afterScope: document.text.slice(range.end, range.end + 240),
      ...(ownOutline ? { currentPlanStatus: outlineStatus(ownOutline, approvedOutline) } : {}),
      previousEnding: previousText ? { title: previous.title, status: previous !== confirmedPrevious ? '资料稿，待作者核对'
        : workspace.project.jobs.some(job => job.documentId === previous.id && job.sourceHash === previous.hash && job.reviewPlot &&
          (job.status !== 'completed' || job.pending)) ? '正文已确认，资料变化待核对' : '已确认', excerpt: previousText.slice(-430) } : null,
      outlines,
      continuity: { ...continuity, characters: characterStates },
      ...(stages.length ? { stagePlans: stages } : {}),
      outlineTitles: candidates.filter(d => !d.chapterMaterial?.chapter || d.chapterMaterial.chapter === chapterScope)
        .slice(0, 10).map(d => d.title),
      style: writingRules.instructions,
      obligations: obligations.items.filter(card => !card.sceneId || card.sceneId === sceneId).slice(0, 3).map(card => ({
        title: card.title, goal: card.goal?.slice(0, 120), opening: card.opening?.slice(0, 100), closing: card.closing?.slice(0, 100),
        items: card.items.slice(0, 8).map(item => ({ requirement: String(item.text || item.requirement || '').slice(0, 100), characters: item.characterNames })),
      })),
      authorWording: (workspace.project.wordingDecisions || []).filter(r =>
        r.active !== false && (r.scope === 'work' || r.documentId === document.id && (r.scope === 'document' || r.sourceHash === document.hash)))
        .slice(-20).map(({ term, allow, scope, usage }) => ({ term, allow, scope, usage })),
    },
  };
}

export async function findWritingOutline(workspace, query, readPinned, chapter = null, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('VALIDATION', '大纲读取位置必须是非负整数');
  const confirmed = new Map(confirmedVolumeOutlines(workspace).map(({ approval, document }) => [document.id, approval]));
  const chapterOutlines = chapterOutlineApprovals(workspace);
  const results = workspace.documents.filter(document => document.kind === 'plan' && !document.error &&
    !workspace.project.hiddenChapterMaterials?.includes(document.id) &&
    (!chapter || !document.chapterMaterial?.chapter || document.chapterMaterial.chapter === chapter) &&
    (document.title.includes(query) || document.path.includes(query)))
    .sort((a, b) => Number(confirmed.has(b.id) || chapterOutlines.get(b.chapterMaterial?.chapter)?.documentId === b.id) -
      Number(confirmed.has(a.id) || chapterOutlines.get(a.chapterMaterial?.chapter)?.documentId === a.id)).slice(0, 2);
  const outlines = [];
  for (const document of results) {
    const content = await readPinned(document.path, document.hash);
    const approval = confirmed.get(document.id);
    if (!content) continue;
    const start = Math.min(offset, content.length), end = Math.min(start + (results.length > 1 ? 850 : 1300), content.length);
    outlines.push({ title: document.title, path: document.path, status: approval ? '作者已定卷纲' :
      document.chapterMaterial?.role === 'design' ? outlineStatus(document, chapterOutlines.get(document.chapterMaterial.chapter)) : '规划参考',
      ...(approval ? { fromChapter: approval.fromChapter, toChapter: approval.toChapter } : {}),
      excerpt: content.slice(start, end), offset: start, totalCharacters: content.length, nextOffset: end < content.length ? end : null });
  }
  return outlines;
}

export async function findWritingFacts(workspace, chapter, requested, readPinned, { includeLatest = false } = {}) {
  const characters = [];
  for (const name of [...new Set(requested)].slice(0, 4)) {
    const matches = workspace.project.characters.filter(c => c.status !== 'merged' &&
      [c.id, c.name, ...c.aliases].includes(name));
    characters.push(matches.length === 1 ? matches[0] : { name, issue: matches.length ? '重名，需作者指定身份' : '无已登记人物' });
  }
  const activeApprovals = new Set(workspace.project.approvals.filter(a => a.status === 'active').map(a => a.id));
  const facts = workspace.visibleFacts(chapter - 1, { includeLatest, currentOnly: true });
  const found = [];
  const nameFor = id => workspace.project.characters.find(person => person.id === id)?.name || '身份待核对';
  for (const c of characters) {
    if (!c.id) { found.push(c); continue; }
    const baseline = workspace.baselines[c.id];
    const registration = workspace.project.baselines[c.id];
    const card = workspace.documents.find(d => d.id === registration?.documentId);
    const confirmedBaseline = baseline && baseline.id === registration?.baselineId && baseline.work_id === workspace.project.id &&
      baseline.characterId === c.id && Array.isArray(baseline.fields) && card && !workspace.project.externalChanges[card.id] &&
      await readPinned(card.path, card.hash) !== null
      ? { appliesAt: String(baseline.appliesAt || '').slice(0, 100), fields: baseline.fields.filter(field => field?.certainty === 'confirmed')
        .slice(0, 5).map(({ field, value }) => ({ field, value: String(value).slice(0, 120) })) }
      : null;
    const changes = [], included = new Set();
    for (const f of facts.filter(f => (f.entity_id === c.id || f.field === 'relationship' && f.value?.otherId === c.id) &&
      ['occurred', 'ruling'].includes(f.layer)).sort((a, b) => (b.latest_only ? Infinity : b.source_chapter ?? 0) -
        (a.latest_only ? Infinity : a.source_chapter ?? 0) || (b.start ?? 0) - (a.start ?? 0) ||
        String(b.event_created_at || '').localeCompare(String(a.event_created_at || '')))) {
      const slot = JSON.stringify([f.entity_id, f.field, f.value?.otherId, f.value?.type, f.value?.skillName]);
      if (included.has(slot)) continue;
      const event = workspace.events.find(e => e.id === f.eventId);
      if (!event || !activeApprovals.has(event.approval_id) || !await pinStoryEvent(workspace, event, readPinned)) continue;
      const value = f.field === 'relationship' && f.value?.otherId
        ? `${nameFor(f.entity_id)} → ${nameFor(f.value.otherId)}：${f.value.type || '关系'}${f.value.attitude ? `（${f.value.attitude}）` : ''}`
        : typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
      if (typeof value !== 'string' || value.length > 160) continue;
      changes.push({ field: f.field, value, chapter: f.source_chapter, source: f.eventTitle });
      included.add(slot);
      if (changes.length >= 3) break;
    }
    found.push({ name: c.name, aliases: c.aliases.slice(0, 6), confirmedBaseline, priorFacts: changes });
  }
  return { scope: `截至第 ${chapter - 1} 章；档案真相与人物当时所知须区分`, characters: found };
}

export async function requireContextHeads(workspace, heads, wordingHash, continuityStamp, chapter) {
  if (workspace.documents.some(doc => heads[doc.path] && workspace.project.hiddenChapterMaterials?.includes(doc.id))) {
    throw new AppError('CONFLICT', '本轮使用的章节资料已移出，请刷新依据后重试');
  }
  for (const head of Object.values(heads)) {
    const bytes = await workspace.store.read(head.path);
    if (!bytes || hash(bytes) !== head.hash) throw new AppError('CONFLICT', '共写引用的资料已变更，请重新读取后生成候选稿');
  }
  if (wordingHash !== hash(Buffer.from(JSON.stringify(workspace.project.wordingDecisions || [])))) {
    throw new AppError('CONFLICT', '作者用词规则已改变，请重新生成候选稿');
  }
  if (continuityStamp && continuityStamp !== storyContinuityStamp(workspace, chapter)) {
    throw new AppError('CONFLICT', '设定、章纲或章节裁定已有更新，请用当前资料重新讨论');
  }
}
