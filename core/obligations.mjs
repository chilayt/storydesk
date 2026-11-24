import { AppError, hash, uid } from './io.mjs';
import { sourceSpans, locateEvidence } from './evidence.mjs';

export const OBLIGATION_METHODS = { semantic: '剧情语义 · AI初核后作者确认', required_text: '逐字必含 · 机检', forbidden_text: '逐字禁含 · 机检', character_mention: '人物姓名或别名被提及 · 机检' };
export const OBLIGATION_CATEGORIES = { plot: '剧情推进', character: '人物行动', relationship: '关系变化', knowledge: '知情范围', item: '道具流转', skill: '武学阶段', continuity: '前后承接', style: '表达约定', other: '其他' };
export const obligationHash = v => hash(Buffer.from(JSON.stringify(v)));
export function obligationFile(id, report = false) {
  if (!(report ? /^obcheck_[\w-]+$/ : /^obcard_[\w-]+$/).test(id)) throw new AppError('VALIDATION', '场景义务记录ID无效');
  return `_创作管理/${report ? '义务核对' : '场景义务'}/${id}.md`;
}
const value = (x, max, name, required = false) => {
  if (x == null && !required) return '';
  if (typeof x !== 'string' || x.length > max || /\0/.test(x) || required && !x.trim()) throw new AppError('VALIDATION', `${name}为空或超过长度限制`);
  return x.trim();
};
export function validateObligationCard(input, w, old = null) {
  const doc = w.doc(input.documentId);
  if (!['chapter', 'draft'].includes(doc.kind)) throw new AppError('VALIDATION', '义务卡需关联正文或稿件');
  const status = input.status || 'draft';
  if (!['draft', 'confirmed', 'disabled'].includes(status)) throw new AppError('VALIDATION', '义务卡状态无效');
  if (status === 'confirmed' && input.authorConfirmed !== true) throw new AppError('VALIDATION', '需作者确认义务卡后才能纳入正式核对');
  const scene = input.sceneId ? w.project.scenes.find(s => s.id === input.sceneId && s.documentId === doc.id) : null;
  if (input.sceneId && (!scene || status === 'confirmed' && scene.sourceHash !== doc.hash)) throw new AppError('SCENE', '场景范围已失效，请在正文中重新划分后绑定');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 40) throw new AppError('VALIDATION', '每张卡需有1至40项义务');
  const ids = new Set();
  const items = input.items.map((x, index) => {
    if (!x || !Object.hasOwn(OBLIGATION_METHODS, x.method) || !Object.hasOwn(OBLIGATION_CATEGORIES, x.category) || !['required', 'reminder'].includes(x.severity)) throw new AppError('VALIDATION', `第${index + 1}项检查方式、分类或要求无效`);
    const id = x.id || uid('obitem');
    if (!/^obitem_[\w-]+$/.test(id) || ids.has(id) || x.id && !old?.items.some(v => v.id === id)) throw new AppError('VALIDATION', '义务项ID无效或重复');
    ids.add(id);
    let terms = [], characterIds = [];
    if (['required_text', 'forbidden_text'].includes(x.method)) {
      if (!Array.isArray(x.terms) || x.terms.some(t=>typeof t!=='string')) throw new AppError('VALIDATION', '逐字检查需填写连续词句，不支持正则');
      terms = [...new Set(x.terms.map(t => t.trim()).filter(Boolean).map(t=>value(t,100,'检查词句',true)))];
      if(!terms.length||terms.length>12)throw new AppError('VALIDATION','逐字检查需填写1至12个连续词句');
    }
    if (x.method === 'character_mention') {
      if (!Array.isArray(x.characterIds) || !x.characterIds.length || x.characterIds.length > 12) throw new AppError('VALIDATION', '请选择要检查提及的人物');
      characterIds = [...new Set(x.characterIds)]; for (const id of characterIds) w.character(id);
    }
    return { id, title: value(x.title, 100, '义务标题', true), description: value(x.description, 700, '义务说明'), category: x.category, severity: x.severity, method: x.method, terms, characterIds };
  });
  return { title: value(input.title, 100, '义务卡名称', true), documentId: doc.id, sceneId: scene?.id || null, status, goal: value(input.goal, 1000, '本场目标'), opening: value(input.opening, 1000, '入场状态'), closing: value(input.closing, 1000, '结束状态'), source: value(input.source, 600, '约定来源', true), items };
}
export function isObligationCard(r) {
  return /^obcard_[\w-]+$/.test(r.id) && typeof r.title === 'string' && typeof r.documentId === 'string'
    && ['draft', 'confirmed', 'disabled'].includes(r.status) && Number.isInteger(r.revision)
    && ['goal', 'opening', 'closing', 'source'].every(k => typeof r[k] === 'string')
    && Array.isArray(r.items) && r.items.length > 0 && r.items.length <= 40 && new Set(r.items.map(x => x.id)).size === r.items.length
    && r.items.every(x => /^obitem_[\w-]+$/.test(x.id) && typeof x.title === 'string' && typeof x.description === 'string' && Object.hasOwn(OBLIGATION_METHODS, x.method) && ['required', 'reminder'].includes(x.severity) && Array.isArray(x.terms) && x.terms.every(t => typeof t === 'string' && !!t) && Array.isArray(x.characterIds));
}
export function isObligationReport(r) {
  return /^obcheck_[\w-]+$/.test(r.id) && typeof r.cardId === 'string' && typeof r.cardHash === 'string' && typeof r.documentId === 'string' && typeof r.sourceHash === 'string'
    && Number.isInteger(r.start) && Number.isInteger(r.end) && typeof r.contextSignature==='string' && Array.isArray(r.items) && r.items.every(i=>i&&typeof i.id==='string'&&Object.hasOwn(OBLIGATION_METHODS,i.method))
    && Array.isArray(r.mechanical)&&r.mechanical.every(x=>x&&typeof x.itemId==='string'&&Array.isArray(x.evidence))
    && Array.isArray(r.parts)&&r.parts.every(p=>p&&typeof p.id==='string'&&Number.isInteger(p.start)&&Number.isInteger(p.end)&&Array.isArray(p.itemIds)&&Array.isArray(p.results)&&p.results.every(x=>x&&typeof x.itemId==='string'&&Array.isArray(x.evidence)))
    && Array.isArray(r.reviews)&&r.reviews.every(x=>x&&typeof x.itemId==='string'&&['satisfied','waive','pending'].includes(x.decision)&&Array.isArray(x.evidence))&&r.usage&&Number.isFinite(r.usage.total_tokens)&&Number.isInteger(r.revision);
}
export function cardBody(c) {
  return `目标：${c.goal || '未另写'}\n\n入场状态：${c.opening || '未另写'}\n\n结束状态：${c.closing || '未另写'}\n\n来源：${c.source}\n\n${c.items.map((x, i) => `## ${i + 1}. ${x.title}\n\n${x.description}\n\n方式：${OBLIGATION_METHODS[x.method]}；${x.severity === 'required' ? '确认前需处理' : '仅提醒'}\n\n${x.terms.length ? `逐字词句：${x.terms.join(' / ')}` : ''}`).join('\n\n')}\n\n> 义务卡记录作者要求，不自动成为已发生剧情。结构化元数据为正式内容；本区为可读副本。`;
}
export function resolveCharacter(characters, id) {
  const seen = new Set(); let c = characters.find(c => c.id === id);
  while (c?.status === 'merged' && !seen.has(c.id)) { seen.add(c.id); c = characters.find(v => v.id === c.redirectTo); }
  return c?.status === 'merged' ? null : c;
}
export function mechanicalObligations(items, text, start, end, characters) {
  const source = text.slice(start, end);
  return items.filter(x => x.method !== 'semantic').map(item => {
    let terms = item.terms, missing = [], evidence = [];
    const take = t => { const at = source.indexOf(t); if (at >= 0) evidence.push({ evidence: t, start: start + at, end: start + at + t.length }); return at >= 0; };
    if (item.method === 'character_mention') {
      missing = item.characterIds.filter(id => { const c = resolveCharacter(characters, id); return !c || ![c.name, ...c.aliases].filter(Boolean).some(take); });
    } else if (item.method === 'required_text') missing = terms.filter(t => !take(t));
    else evidence = terms.flatMap(t => { const at = source.indexOf(t); return at < 0 ? [] : [{ evidence: t, start: start + at, end: start + at + t.length }]; });
    const satisfied = item.method === 'forbidden_text' ? !evidence.length : !missing.length;
    return { itemId: item.id, verdict: satisfied ? 'satisfied' : 'unsatisfied', by: 'machine', evidence, reason: item.method === 'character_mention' ? `仅检查姓名或别名提及，不代表正面出场。${missing.length ? `缺少${missing.length}个人物称呼。` : '指定人物称呼均出现。'}` : item.method === 'required_text' ? missing.length ? `未出现逐字词句：${missing.join('、')}` : '指定连续词句全部出现。' : satisfied ? '检查范围中未出现指定连续词句。' : '检查范围中出现了指定禁含词句。' };
  });
}
export function validateObligationResponse(raw, expectedItems, text, start, end) {
  if (!Array.isArray(raw) || raw.length > 40) throw new AppError('AI_FORMAT', '核对模型需返回results数组，未把检查标为通过');
  const spans = sourceSpans(text.slice(start, end), start), expected = new Set(expectedItems), seen = new Set(), errors = [], results = [];
  for (const x of raw) {
    if (!expected.has(x?.obligation_id) || seen.has(x.obligation_id)) { errors.push('返回了未知或重复义务ID'); continue; }
    seen.add(x.obligation_id);
    if (!['satisfied', 'not_found', 'needs_author'].includes(x.verdict)) { errors.push(`义务${x.obligation_id}的判定值无效`); continue; }
    const quotes = Array.isArray(x.evidence) ? x.evidence.slice(0, 5) : [], evidence = [];
    if (Array.isArray(x.evidence_span_ids)) for (const id of x.evidence_span_ids.slice(0, 5)) quotes.push({ span_id: id });
    if (typeof x.quote === 'string') quotes.push({ quote: x.quote });
    const invalid = [];
    for (const q of quotes) {
      const found = locateEvidence(text, { quote: typeof q === 'string' ? q : q?.quote || '', spanId: typeof q === 'object' ? q?.span_id || '' : '', start, end, spans });
      if (found.status === 'matched' && !found.duplicate) evidence.push({ evidence: found.evidence, start: found.start, end: found.end, method: found.method });
      else invalid.push(found.reason || '原句无法唯一定位');
    }
    const proofRequired = x.verdict === 'satisfied';
    results.push({ itemId: x.obligation_id, by: 'ai', verdict: invalid.length || proofRequired && !evidence.length ? 'needs_author' : x.verdict, proposedVerdict: x.verdict, evidence, reportedEvidence: invalid.length ? quotes.map(q => typeof q === 'string' ? q : q?.quote || q?.span_id || '').join('\n').slice(0, 1500) : '', reason: String(x.reason || '').slice(0, 1000), evidenceIssue: invalid.join('；') || (proofRequired && !evidence.length ? 'AI声称满足，但未提供本场可定位的依据' : '') });
  }
  const missing = expectedItems.filter(id => !results.some(r => r.itemId === id));
  return { results, errors, missing, complete: !errors.length && !missing.length };
}
export function obligationResults(report) {
  return report.items.map(item => {
    const machine = report.mechanical.find(r => r.itemId === item.id);
    const applicable = report.parts.filter(p => p.itemIds.includes(item.id));
    const responses = applicable.flatMap(p => p.results.filter(r => r.itemId === item.id));
    const complete = item.method !== 'semantic' || applicable.length > 0 && applicable.every(p => p.status === 'done' && p.results.some(r => r.itemId === item.id));
    let base = machine || { itemId: item.id, by: 'ai', verdict: !complete ? 'incomplete' : responses.some(r => r.verdict === 'needs_author') ? 'needs_author' : responses.some(r => r.verdict === 'satisfied') ? 'satisfied' : 'unsatisfied', evidence: responses.flatMap(r => r.evidence).slice(0, 12), reason: !complete ? '存在尚未完整检查的分段' : responses.map(r => r.reason || r.evidenceIssue).filter(Boolean).join('；').slice(0, 1600) || 'AI未在完整范围找到满足依据' };
    const review = [...report.reviews].reverse().find(r => r.itemId === item.id);
    return { ...base, item, complete, review: review || null, resolved: review?.decision === 'satisfied' || review?.decision === 'waive' || item.method !== 'semantic' && base.verdict === 'satisfied', evidenceIssues: responses.filter(r => r.evidenceIssue).map(r => ({ reported: r.reportedEvidence, reason: r.evidenceIssue })) };
  });
}
export function obligationCoverage(report) {
  const expected = report.parts.reduce((n, p) => n + p.itemIds.length, 0);
  const checked = report.parts.reduce((n, p) => n + (p.status === 'done' ? p.itemIds.filter(id => p.results.some(r => r.itemId === id)).length : 0), 0);
  return { expected, checked, complete: expected === checked, missingParts: report.parts.filter(p => p.status !== 'done').length, items: report.items.length };
}
export function reportBody(r) {
  const coverage = obligationCoverage(r);
  return `稿件版本：${r.sourceHash}\n\n义务卡版本：${r.cardHash}\n\n语义核对覆盖：${coverage.checked}/${coverage.expected}；${coverage.complete ? '完整' : '未完成'}\n\n${obligationResults(r).map(x => `## ${x.item.title}\n\n${x.resolved ? '已处理' : '待处理'} · ${x.verdict}\n\n${x.reason}\n\n${x.evidence.map(e => `> ${e.evidence}`).join('\n\n')}\n\n${x.review ? `作者裁定：${x.review.decision}；${x.review.reason}` : ''}`).join('\n\n')}\n\n> 本报告是检查记录，不生成剧情事实。放宽只适用于该义务卡和本次稿件版本；原门禁不受其影响。`;
}
