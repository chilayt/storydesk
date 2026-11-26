import { hash } from './io.mjs';

export const specialReviewInstruction = '必须逐条回答 candidates，使用 candidateReplies 数组。每项原样返回 id、包含命中处的段内逐字原句 quote、verdict 和一句具体 reason。' +
  '普通疑点 verdict 为 issue（问题成立）、okay（说明语境或例外）或 pending（说明缺的依据）。空数组不能处理已发的疑点。' +
  '比喻候选 verdict 为 simile、inference（推测）、okay（固定用法或非比喻）、pending（分不清）。simile 必须另填 subject、image（两者均为 quote 里的逐字原文）、shared（从喻体借用的具体特征）。' +
  '像是有人进来属于推测。把梆声写成空坛里的石响才是比喻。命中词不代表比喻成立。' +
  '主动查本轮 style 段落中未列为候选的暗喻等例子，用 discoveredFigures 数组返回，每项填 segmentId、quote、subject、image、shared，没有则返回空数组。不要重复列出已作为候选的比喻。' +
  '核对动作句时覆盖一切动作，摘出可以去掉的肢体或衣着定语并说明它承担的作用，区别动作所需信息和有意亮相或感官描写。检查以身份、履历、伪装、功法或设定当修饰语的地方，以及紧张段落中的套式比喻。';

const marker = /似的|犹如|仿佛|如同|像是|好似|恰似|一般|宛如|宛若|如(?!何|今|果|实|此|期|旧|常|数|约|故|意|往|初|愿|许|若|下|上)|像|恍若/gu;
const lineAt = (text, start) => text.slice(0, start).split('\n').length;

export function manuscriptSceneRanges(workspace, doc) {
  const saved = workspace.project.scenes.filter(row => row.documentId === doc.id && row.sourceHash === doc.hash)
    .map(({ id, name, start, end }) => ({ id, name, start, end }));
  if (saved.length) return saved.sort((a, b) => a.start - b.start);
  const headings = [...doc.text.matchAll(/^[ \t]{0,3}#{1,6}[ \t]+((?:第[一二三四五六七八九十百零〇两\d]+场|场(?:次)?[ \t]*[\d一二三四五六七八九十]+)(?:[ \t：:·、].*)?)[ \t]*$/gmu)];
  return headings.map((m, i) => ({ id: `heading_${m.index}`, name: m[1].trim(), start: m.index + m[0].length,
    end: headings[i + 1]?.index ?? doc.text.length }));
}

export function specialTargets(doc, spans, issues, excluded) {
  const known = issues.flatMap(issue => {
    if (issue.severity === 'hard' || !issue.quote || excluded.has(issue.id)) return [];
    const span = spans.find(row => row.start <= issue.start && row.end >= issue.end);
    return span ? [{ id: issue.id, kind: 'issue', segmentId: span.id, category: issue.category,
      start: issue.start, end: issue.end, quote: issue.quote, line: issue.line, label: issue.message }] : [];
  });
  const figures = spans.flatMap(span => [...span.text.matchAll(marker)].map(m => {
    const start = span.start + m.index;
    return { id: `simile_${start}`, kind: 'simile', segmentId: span.id, category: 'style', start,
      end: start + m[0].length, quote: m[0], line: lineAt(doc.text, start), label: '比喻或推测候选' };
  }));
  return [...known, ...figures].sort((a, b) => a.start - b.start);
}

function locate(span, quote, target) {
  if (typeof quote !== 'string' || !quote.trim() || quote.length > 820 || !span) return null;
  const offset = span.text.indexOf(quote);
  if (offset < 0 || span.text.indexOf(quote, offset + 1) >= 0) return null;
  const start = span.start + offset, end = start + quote.length;
  return !target || start <= target.start && end >= target.end
    ? { start, end, lineOffset: span.text.slice(0, offset).split('\n').length - 1 } : null;
}

function figureEvidence(row, anchor, target) {
  if (typeof row.shared !== 'string' || !row.shared.trim()) return null;
  const terms = [row.subject, row.image].map(text => {
    if (typeof text !== 'string' || !text.trim()) return null;
    const index = row.quote.indexOf(text);
    return index >= 0 && row.quote.lastIndexOf(text) === index ? { start: anchor.start + index, end: anchor.start + index + text.length } : null;
  });
  if (terms.includes(null)) return null;
  const [first, second] = terms.sort((a, b) => a.start - b.start);
  if (first.end > second.start || target && (target.start < first.end || target.end > second.start)) return null;
  return { subject: row.subject, image: row.image, shared: row.shared.trim().slice(0, 160),
    figureStart: first.start, figureEnd: second.end, comparison: row.quote.slice(first.end - anchor.start, second.start - anchor.start) };
}

export function collectSpecialReview(data, window, targets) {
  const byId = new Map(window.map(span => [span.id, span]));
  const available = Array.isArray(data?.candidateReplies) ? data.candidateReplies : [];
  const replies = [];
  for (const target of targets) {
    const matching = available.filter(row => row?.id === target.id);
    const row = matching[0];
    if (matching.length !== 1 || typeof row.reason !== 'string' || !row.reason.trim()) continue;
    const options = target.kind === 'simile' ? ['simile', 'inference', 'okay', 'pending'] : ['issue', 'okay', 'pending'];
    const anchor = locate(byId.get(target.segmentId), row.quote, target);
    if (!options.includes(row.verdict) || !anchor) continue;
    const figure = row.verdict === 'simile' ? figureEvidence(row, anchor, target) : null;
    if (row.verdict === 'simile' && !figure) continue;
    replies.push({ id: target.id, ...anchor, quote: row.quote, verdict: row.verdict, reason: row.reason.trim().slice(0, 220), ...figure });
  }
  const figures = [], invalidStyle = new Set();
  if (!Array.isArray(data?.discoveredFigures)) {
    for (const span of window) if (span.categories.includes('style')) invalidStyle.add(span.id);
  }
  for (const row of Array.isArray(data?.discoveredFigures) ? data.discoveredFigures : []) {
    const span = byId.get(row?.segmentId);
    if (!span?.categories.includes('style')) continue;
    const anchor = locate(span, row.quote);
    const evidence = anchor && figureEvidence(row, anchor);
    if (!evidence) { invalidStyle.add(span.id); continue; }
    if (evidence.comparison.match(marker)) continue;
    figures.push({ id: hash(JSON.stringify([anchor.start, anchor.end])).slice(0, 20), ...anchor, quote: row.quote, ...evidence });
  }
  return { replies, figures, invalidStyle };
}

export function specialReviewView(special, coverage) {
  const replied = new Map(special.replies.map(row => [row.id, row]));
  const targets = special.targets.map(row => ({ ...row, reply: replied.get(row.id) }));
  const figures = [];
  const discoveries = targets.filter(row => row.reply?.verdict === 'simile').map(row => row.reply).concat(special.figures);
  for (const item of discoveries) {
    if (figures.some(row => item.figureStart < row.figureEnd && item.figureEnd > row.figureStart)) continue;
    const anchor = `${item.figureStart}:${item.figureEnd}`;
    figures.push({ ...item, anchor, dismissed: special.excludedFigures?.includes(anchor) || false,
      line: (coverage.find(span => span.start <= item.start && span.end >= item.end)?.line || 1) + (item.lineOffset || 0),
      sceneId: special.scenes.find(scene => scene.start <= item.figureStart && scene.end >= item.figureEnd)?.id });
  }
  const counted = figures.filter(row => !row.dismissed);
  const pendingFigures = targets.filter(row => row.kind === 'simile' && (!row.reply || row.reply.verdict === 'pending'));
  const unfinishedStyle = coverage.filter(row => !row.checked.includes('style'));
  const partial = pendingFigures.length > 0 || unfinishedStyle.length > 0;
  const scenes = special.scenes.map(scene => {
    const count = counted.filter(row => row.sceneId === scene.id).length;
    const pending = pendingFigures.some(row => scene.start <= row.start && row.end <= scene.end) ||
      unfinishedStyle.some(row => row.start < scene.end && row.end > scene.start);
    return { id: scene.id, name: scene.name, count, limit: special.limits.perScene,
      status: count > special.limits.perScene ? 'over' : pending ? 'pending' : 'within' };
  });
  const chapter = { count: counted.length, limit: special.limits.perChapter,
    status: counted.length > special.limits.perChapter ? 'over' : partial ? 'pending' : 'within' };
  const unscoped = !scenes.length || coverage.some(row => !special.scenes.some(scene => scene.start <= row.start && scene.end >= row.end));
  return { targets, figures, chapter, scenes, unscoped, missing: targets.filter(row => !row.reply).length,
    pending: targets.filter(row => row.reply?.verdict === 'pending').length };
}
