import { AppError, hash, stamp } from './io.mjs';
import { findWritingFacts, storyContinuityStamp, writingContext } from './cowriting-context.mjs';
import { creativeTaskStamp, readCreativeTask } from './creative-tasks.mjs';
import { planningTarget } from './planning.mjs';
import { confirmedResearchSettings } from './world-context.mjs';
import { findLocationReferences } from './location-maps.mjs';
import { stagePlans } from './stage-plans.mjs';

const fields = { location: '所在地点', identity: '身份', goal: '目标', condition: '身体状态', relationship: '关系', skill: '能力', knowledge: '知情', item_holder: '持有物', appearance: '出场' };
function describeCharacter(character) {
  const lines = [`人物：${character.name}`];
  if (character.issue) return `${lines[0]}\n\n${character.issue}`;
  if (character.aliases?.length) lines.push(`别名：${character.aliases.join('、')}`);
  lines.push('\n已确认基座：');
  for (const field of character.confirmedBaseline?.fields || []) lines.push(`- ${field.field}：${field.value}`);
  if (!character.confirmedBaseline) lines.push('尚无可用的已确认基座。');
  lines.push('\n本轮适用的已确认变化：');
  for (const fact of character.priorFacts || []) lines.push(`- ${fields[fact.field] || fact.field}：${fact.value}（${fact.chapter ? `第${fact.chapter}章，` : ''}${fact.source || '已核对记录'}）`);
  if (!character.priorFacts?.length) lines.push('暂无匹配的已确认变化。');
  return lines.join('\n');
}

const citedTextBudget = 18_000;

async function discussionSource(workspace, reference, chapter, context, excerptLimit) {
  if (!reference || typeof reference.id !== 'string') throw new AppError('VALIDATION', '请选择本作品中当前打开的资料');
  if (reference.kind === 'document') {
    const doc = workspace.documents.find(d => d.id === reference.id && !d.error && !d.generated && d.kind !== 'attachment');
    if (!doc || doc.hash !== reference.hash || workspace.project.hiddenChapterMaterials?.includes(doc.id)) {
      throw new AppError('CONFLICT', '引用资料已变更或已移出，请核对当前资料后重新引用');
    }
    const content = await context.readPinned(doc.path, reference.hash);
    if (!content?.trim()) throw new AppError('CONFLICT', '引用资料为空或已有新版本，请重新打开');
    if (reference.selection) {
      const { start, end, text } = reference.selection;
      const normalized = content.replace(/\r\n?/gu, '\n');
      if (normalized.slice(start, end) !== text) throw new AppError('CONFLICT', '选段已变化，请重新引用');
      return { id: doc.id, title: doc.title, chapter: doc.chapter ?? doc.draftChapterHint, path: doc.path, hash: doc.hash,
        excerpt: text, selection: { start, end, text }, totalCharacters: normalized.length,
        nextOffset: null, status: '作者引用 · 原文选段' };
    }
    const excerpt = content.slice(0, excerptLimit);
    const truncated = excerpt.length < content.length;
    return { id: doc.id, title: doc.title, path: doc.path, hash: doc.hash, excerpt,
      totalCharacters: content.length, nextOffset: truncated ? excerpt.length : null,
      status: truncated ? `作者引用 · 已附前 ${excerpt.length} 字符，可继续取阅` : '作者引用 · 原档全文' };
  }
  if (reference.kind === 'character') {
    const person = workspace.project.characters.find(c => c.id === reference.id && c.status !== 'merged');
    if (!person || person.revision !== reference.revision) throw new AppError('CONFLICT', '人物档案已变更，请重新打开并引用');
    const { characters: [character] } = await findWritingFacts(workspace, chapter ?? Number.MAX_SAFE_INTEGER, [person.id], context.readPinned, { includeLatest: chapter === null });
    const doc = workspace.documents.find(d => d.id === person.primarySourceId && !d.error);
    const original = doc && await context.readPinned(doc.path, doc.hash);
    const excerpt = [describeCharacter(character), original && `原档摘录（供讨论）：\n${original.slice(0, 650)}`].filter(Boolean).join('\n\n');
    return { title: person.name, path: original ? doc.path : '', excerpt, status: '作者引用 · 人物档案', revision: person.revision };
  }
  if (reference.kind === 'stage') {
    const plan = stagePlans(workspace).find(row => row.id === reference.id);
    const record = workspace.records.find(row => row.id === reference.id);
    if (!plan?.hash || plan.hash !== reference.hash || !record ||
        await context.readPinned(plan.path, reference.hash) === null) {
      throw new AppError('CONFLICT', '阶段计划已变更或不可用，请重新选择');
    }
    const nodes = plan.nodes.map(node => `- ${node.chapter ? '第' + node.chapter + '章 · ' : ''}${node.title}${node.note ? ' · ' + node.note : ''}`);
    return { title: plan.title, path: plan.path, hash: plan.hash, status: '作者引用 · 阶段剧情计划',
      excerpt: [`第 ${plan.fromChapter}–${plan.toChapter} 章`, record.body, ...nodes].filter(Boolean).join('\n').slice(0, excerptLimit) };
  }
  if (reference.kind === 'map') {
    const place = workspace.locationMaps?.places.find(row => row.id === reference.id);
    if (!place || place.map.version !== reference.version || place.map.documentId !== reference.documentId) {
      throw new AppError('CONFLICT', '现行地图已有变化，请重新打开并引用');
    }
    const rows = await findLocationReferences(workspace, place.name, context.readPinned, { lookup: true });
    const row = rows.find(item => item.id === place.id);
    if (!row?.map.available) throw new AppError('CONFLICT', '现行地图不可用，请核对资料');
    return { title: place.name, path: row.map.path, status: '作者引用 · 地点摘录与地图版本',
      excerpt: [row.summary, ...row.settings.filter(item => item.excerpt).map(item => item.title + '：' + item.excerpt)].filter(Boolean).join('\n\n'),
      map: row.map, settings: row.settings };
  }
  throw new AppError('VALIDATION', '此资料类型暂不能引用到对话');
}

export async function prepareWritingContext(workspace, source, range, sceneId, words, task, reference = null) {
  const context = await writingContext(workspace, source, range, sceneId, words);
  const chapter = source.planning && source.planning.type !== 'chapter' ? null : source.chapter;
  const hints = [words, context.input.currentScope, context.input.beforeScope,
    ...context.input.outlines.map(outline => outline.excerpt), task?.goal].join('\n');
  const research = await confirmedResearchSettings(workspace, chapter, hints, context.readPinned);
  if (research.length) context.input.researchSettings = research;
  const locations = await findLocationReferences(workspace, hints, context.readPinned);
  if (locations.length) context.input.locationContext = locations;
  const references = [];
  context.omitted = [];
  for (const id of task?.referenceIds || []) {
    const document = workspace.documents.find(d => d.id === id && !d.error);
    if (workspace.project.hiddenChapterMaterials?.includes(id)) {
      context.omitted.push(`任务原引用已移出 · ${document?.title || id}`);
      continue;
    }
    if (!document) throw new AppError('CONFLICT', '任务补充的资料已不可用，请重新选择');
    const content = await context.readPinned(document.path, document.hash);
    if (content === null) throw new AppError('CONFLICT', '任务补充的资料有新版本，请刷新后重试');
    references.push({ title: document.title, path: document.path, kind: document.kind,
      status: '作者补充原档，未据此确认剧情事实', excerpt: content.slice(0, 800) });
  }
  if (task) context.input.task = { title: task.title, goal: task.goal.trim() === words ? '' : task.goal, notes: task.notes,
    status: '作者的任务要求与未决问题，不是已发生事实', references };
  const cited = reference ? (Array.isArray(reference) ? reference : [reference]) : [];
  if (cited.length > 8) throw new AppError('VALIDATION', '一次最多引用八份资料');
  const excerptLimit = Math.floor(citedTextBudget / Math.max(1, cited.filter(item => ['document', 'stage'].includes(item?.kind)).length));
  for (const item of cited) {
    const entry = await discussionSource(workspace, item, chapter, context, excerptLimit);
    if (!context.input.discussionSource) context.input.discussionSource = entry;
    else (context.input.discussionReferences ||= []).push(entry);
  }
  return context;
}

export function writingManifest(workspace, source, range, context, { task, words = '', lookups = [] } = {}) {
  const input = context.input, sections = [];
  const add = (kind, title, excerpt, status, path = '', reason = '') => {
    if (!excerpt) return;
    const document = workspace.documents.find(d => d.path === path);
    sections.push({ id: `${kind}_${sections.length}`, kind, title, excerpt: String(excerpt), status, path,
      documentId: document?.id || null, hash: context.heads[path]?.hash || (path === source.path ? source.hash : null), reason });
  };
  add('source', source.title, [input.beforeScope, input.currentScope, input.afterScope].filter(Boolean).join('\n'),
    source.planning ? input.currentPlanStatus || '规划材料' : '当前保存版本', source.path, `本轮范围：${range.label}`);
  if (input.previousEnding) {
    const previous = workspace.documents.find(d => d.title === input.previousEnding.title && context.heads[d.path]);
    add('previous', input.previousEnding.title, input.previousEnding.excerpt, input.previousEnding.status, previous?.path, '承接上文');
  }
  for (const outline of input.outlines) add('outline', outline.title, outline.excerpt, outline.status, outline.path, '当前章适用的大纲');
  const progressLabels = { completed: '已完成', pending: '未完成', changed: '安排有变动', conflict: '内容冲突', review: '待核对' };
  const stages = new Map((input.stagePlans || []).map(plan => [plan.id, plan]));
  for (const lookup of lookups) for (const plan of lookup.result?.matches || []) {
    if (plan.nodes && plan.fromChapter) stages.set(plan.id, plan);
  }
  for (const plan of stages.values()) {
    const rows = plan.nodes.map(node => '- ' + node.title + ' · ' + progressLabels[node.state]
      + (node.event ? ' · 第' + node.event.chapter + '章 ' + node.event.title : '') + (node.note ? ' · ' + node.note : ''));
    add('stage', plan.title, [plan.description, ...rows].filter(Boolean).join('\n\n'), '阶段计划与实际进展',
      plan.path, '第' + plan.fromChapter + '–' + plan.toChapter + '章适用');
  }
  for (const setting of input.researchSettings || []) {
    const sources = (setting.sources || []).map(source => `- ${source.title} <${source.url}>`);
    add('research', setting.title, [setting.excerpt, ...sources].join('\n\n'), setting.status, setting.path, `适用范围 · ${setting.scope}`);
  }
  const locations = new Map((input.locationContext || []).map(place => [place.id, place]));
  for (const lookup of lookups) for (const place of lookup.result?.matches || []) {
    if (place.map && place.settings) locations.set(place.id, place);
  }
  for (const place of locations.values()) {
    const mapStatus = place.map.available ? '作者指定现行地图' : '指定地图文件不可用';
    add('map', [place.title, place.map.title, place.map.version].join(' · '), place.summary,
      mapStatus, place.map.available ? place.map.path : '', '地点与图面版本');
    for (const setting of place.settings) {
      add('location', setting.title, setting.excerpt, setting.status, setting.path, place.title + ' · 地点设定');
    }
  }
  for (const character of input.continuity.characters) {
    add('character', character.name, describeCharacter(character), character.confirmedBaseline ? '已核对基座与适用变化' : '基座未确认或尚无明确资料', '', '人物与关系依据');
  }
  for (const event of input.continuity.events) add('event', event.title, event.summary, '已核对事件', '', '已确认前情');
  const hookStatus = { planned: '计划中', introduced: '已埋设', progressing: '推进中', paid_off: '已回收' };
  for (const hook of input.continuity.hooks) add('hook', hook.title,
    [`状态：${hookStatus[hook.status] || hook.status}`, hook.note, hook.target ? `预期范围：${hook.target}` : ''].filter(Boolean).join('\n\n'), '当前适用伏笔', '', '避免遗漏未收事项');
  for (const rule of context.writingRules.sources) {
    const status = rule.use === 'examples' ? '校订判例 · 按词查阅'
      : rule.use === 'lookup' ? '作品词表 · 按词查阅' : rule.excerpted ? '当前规则 · 摘录' : '当前规则';
    add('rule', rule.title, rule.excerpt, status, rule.path, '使用本轮稿件和任务范围选取');
  }
  for (const card of input.obligations) add('obligation', card.title, JSON.stringify(card, null, 2), '作者场景约定');
  if (input.authorWording.length) add('wording', '作者用词裁定', JSON.stringify(input.authorWording, null, 2), '按放行范围适用');
  if (input.task?.goal || input.task?.notes) add('task', input.task.title, [input.task.goal, input.task.notes].filter(Boolean).join('\n\n'), '任务要求与未决问题');
  for (const annotation of input.authorAnnotations || []) add('annotation', '作者批注', `${annotation.quote}\n\n批注：${annotation.note}`, '绑定保存版本的选段', source.path);
  for (const reference of input.task?.references || []) add('reference', reference.title, reference.excerpt, reference.status, reference.path, '作者手动补充');
  for (const { title, path, excerpt, status } of [input.discussionSource, ...(input.discussionReferences || [])].filter(Boolean)) {
    add('reference', title, excerpt, status, path, '作者明确引用给本轮对话');
  }
  for (const item of input.memlayerRecall || []) {
    add('memory', `Memlayer · ${item.scope}`, item.text, '本轮读取的已确认记忆', '', item.evidence.length ? `出处编号 · ${item.evidence.join('、')}` : `记忆编号 · ${item.id}`);
    sections.at(-1).factId = item.id;
  }
  for (const lookup of lookups) add('lookup', lookup.title, JSON.stringify(lookup.result, null, 2).slice(0, 2200), '本轮工具实际查阅');
  const missing = [...(context.omitted || [])];
  for (const place of locations.values()) for (const source of place.settings) {
    if (!source.excerpt) missing.push(source.title + '的原档或摘录位置待核对。');
  }
  if (!input.previousEnding && source.chapter > 1) missing.push('尚无可用的已确认前章结尾，未自动把未确认稿当作正式前情。');
  if (!input.outlines.some(o => o.status === '作者已定卷纲')) missing.push('尚无适用的已定卷纲；已有草案仅作规划参考。');
  for (const path of context.writingRules.missing) missing.push('当前规则资料不可读 · ' + path);
  if (source.text.length > range.end && range.start === 0 && range.end > 0) missing.push(`本轮正文范围读取前 ${range.end} 字符，未读取后续全文；不能据此认定整章已核对。`);
  const signature = hash(Buffer.from(JSON.stringify([source.id, source.hash, range, context.heads, input.task, input.authorWording,
    input.continuity, input.outlines, input.discussionSource, input.discussionReferences, words])));
  return { schema: 1, workId: workspace.project.id, taskId: task?.id || null, taskStamp: task ? creativeTaskStamp(task) : null,
    wordingHash: hash(Buffer.from(JSON.stringify(workspace.project.wordingDecisions || []))),
    continuityStamp: storyContinuityStamp(workspace, context.chapterScope), documentId: source.id, chapterScope: context.chapterScope,
    targetTitle: source.title, sceneId: context.sceneId ?? null,
    sourcePath: source.path, sourceHash: source.hash, range: range.label, created_at: stamp(), signature,
    heads: structuredClone(context.heads), sections, missing, request: words, stale: false };
}

export async function manifestIsStale(workspace, manifest) {
  if (!manifest || manifest.workId !== workspace.project.id) return false;
  const source = await workspace.store.read(manifest.sourcePath);
  if (hash(source || Buffer.alloc(0)) !== manifest.sourceHash) return true;
  for (const head of Object.values(manifest.heads || {})) {
    if (workspace.documents.some(doc => doc.path === head.path && workspace.project.hiddenChapterMaterials?.includes(doc.id))) return true;
    const bytes = await workspace.store.read(head.path);
    if (!bytes || hash(bytes) !== head.hash) return true;
  }
  if (manifest.taskId) {
    try { if (creativeTaskStamp(await readCreativeTask(workspace, manifest.taskId)) !== manifest.taskStamp) return true; }
    catch { return true; }
  }
  if (manifest.wordingHash !== hash(Buffer.from(JSON.stringify(workspace.project.wordingDecisions || [])))) return true;
  let chapter = manifest.chapterScope;
  if (chapter === undefined) {
    const target = planningTarget(manifest.documentId);
    chapter = target?.type === 'chapter' ? target.number : workspace.documents.find(d => d.id === manifest.documentId)?.chapter;
  }
  if (manifest.continuityStamp !== storyContinuityStamp(workspace, chapter)) return true;
  return false;
}
