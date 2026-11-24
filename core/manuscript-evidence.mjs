const dateCue = /(?:[〇零一二三四五六七八九十正冬腊\d]{1,3}月[初廿卅〇零一二三四五六七八九十\d]{1,4}(?:日|(?=[，。；、\s]|$))|翌日|次日)/u;
const routeCue = /(?:启程|动身|出发|抵达|赶到|上岸|登船|[一二两三四五六七八九十百千几数\d]{1,5}(?:余|多)?[里程])/u;
const continuityFields = new Set(['identity', 'location', 'relationship', 'status', 'condition', 'knowledge']);
const sourceLine = (text, start) => text.slice(0, start).split('\n').length;

export function manuscriptContinuityCues(text, spans) {
  const cues = [];
  for (const span of spans) {
    for (const [kind, pattern] of [['time', dateCue], ['route', routeCue]]) {
      const match = pattern.exec(span.text);
      if (!match) continue;
      const start = span.start + Math.max(0, match.index - 55);
      cues.push({ kind, start, end: Math.min(start + 200, span.end) });
    }
  }
  const frontmatterEnd = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text)?.[0].length || 0;
  for (const heading of text.matchAll(/^#{1,6}[ \t]+[^\r\n]+/gmu)) {
    if (heading.index < frontmatterEnd) continue;
    cues.push({ kind: 'heading', start: heading.index, end: heading.index + Math.min(160, heading[0].length) });
  }
  return cues.sort((a, b) => a.start - b.start);
}

async function addContinuityEvidence(add, workspace, doc, context) {
  const previous = context.confirmedPreviousDocument;
  if (previous) {
    const text = await context.readPinned(previous.path, previous.hash);
    if (text) add(previous, text, Math.max(0, text.length - 430), text.length, 'prior', '章节末尾');
  }

  const characters = context.input.continuity.characters;
  for (const { name, confirmedBaseline } of characters) {
    if (!confirmedBaseline) continue;
    const people = workspace.project.characters.filter(c => c.name === name && c.status !== 'merged');
    if (people.length !== 1) continue;
    const person = people[0], key = `baseline-${person.id}`;
    const card = workspace.documents.find(d => d.id === workspace.project.baselines[person.id]?.documentId);
    const text = card && await context.readPinned(card.path, card.hash);
    if (!text) continue;
    const open = text.indexOf(`<!-- storydesk:${key}:start -->`);
    const close = text.indexOf(`<!-- storydesk:${key}:end -->`, open);
    if (open < 0 || close < 0) continue;
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    for (const { field, value } of confirmedBaseline.fields) {
      const heading = `${newline}### ${field}${newline}${newline}`;
      const position = text.indexOf(heading, open);
      const quote = value.replace(/\r?\n/gu, newline);
      const start = position + heading.length;
      if (position >= 0 && start + quote.length <= close && text.startsWith(quote, start)) {
        add(card, text, start, start + quote.length, 'baseline', card.title === name ? field : `${name} · ${field}`);
      }
    }
  }

  if (!Number.isInteger(doc.chapter)) return;
  const names = new Set(characters.filter(c => !c.issue).map(c => c.name));
  const people = new Set(workspace.project.characters.filter(c => c.status !== 'merged' && names.has(c.name)).map(c => c.id));
  const approvals = new Set(workspace.project.approvals.filter(a => a.status === 'active').map(a => a.id));
  const facts = workspace.visibleFacts(doc.chapter - 1, { currentOnly: true })
    .filter(f => Number.isInteger(f.source_chapter) && approvals.has(f.approvalId) &&
      context.heads[`_创作管理/事件/${f.eventId}.md`] && continuityFields.has(f.field) && ['occurred', 'ruling'].includes(f.layer) &&
      (people.has(f.entity_id) || f.field === 'relationship' && people.has(f.value?.otherId)))
    .sort((a, b) => b.source_chapter - a.source_chapter || (b.start ?? 0) - (a.start ?? 0));
  for (const fact of facts.slice(0, 4)) {
    const source = workspace.documents.find(d => d.id === fact.source_document_id && d.kind === 'chapter');
    if (!source || source.hash !== fact.source_hash || !Number.isInteger(fact.start) || !Number.isInteger(fact.end)) continue;
    const text = await context.readPinned(source.path, source.hash);
    if (text && fact.end > fact.start && text.slice(fact.start, fact.end) === fact.evidence) {
      add(source, text, fact.start, Math.min(fact.end, fact.start + 360), 'prior', '已归档变化的原文');
    }
  }
}

export async function reviewEvidence(workspace, doc, window, spans, cues, context) {
  const byId = new Map(), evidence = [], seen = new Set();
  function add(source, raw, start, end, kind, label, segmentId) {
    const content = raw.slice(start, end);
    const text = content.trim();
    if (!text) return null;
    start += content.length - content.trimStart().length;
    const key = JSON.stringify([source.id, start, start + text.length]);
    if (seen.has(key)) return null;
    seen.add(key);
    const excerpt = { id: `e${byId.size + 1}`, kind, title: source.title, label, line: sourceLine(raw, start), text };
    byId.set(excerpt.id, { ...excerpt, documentId: source.id, sourceHash: source.hash, start });
    if (!segmentId) evidence.push(excerpt);
    return excerpt.id;
  }
  const segments = window.map(span => ({
    id: span.id, text: span.text, categories: span.categories, line: sourceLine(doc.text, span.start),
    basisId: add(doc, doc.text, span.start, span.end, 'draft', '本轮核对段落', span.id),
  }));
  const ids = new Set(window.map(span => span.id));
  for (const span of window) {
    const index = Number(span.id) - 1;
    const before = spans[index - 1], after = spans[index + 1];
    if (before && !ids.has(before.id)) add(doc, doc.text, Math.max(before.start, before.end - 170), before.end, 'draft', '前一段');
    if (after && !ids.has(after.id)) add(doc, doc.text, after.start, Math.min(after.end, after.start + 170), 'draft', '后一段');
  }
  const opening = spans[0];
  if (!ids.has(opening.id)) add(doc, doc.text, opening.start, Math.min(opening.end, opening.start + 220), 'draft', '本章开头');
  const leading = cues.filter(cue => cue.end <= window[0].start);
  for (const [kind, count, label] of [['time', 2, '前文时日线索'], ['route', 2, '前文行程线索'], ['heading', 1, '前文小节']]) {
    for (const cue of leading.filter(cue => cue.kind === kind).slice(-count)) add(doc, doc.text, cue.start, cue.end, 'draft', label);
  }
  for (const cue of cues.filter(cue => cue.kind === 'heading' && cue.start > window[0].start && cue.end < window.at(-1).end).slice(0, 4)) {
    add(doc, doc.text, cue.start, cue.end, 'draft', '本章小节线索');
  }
  await addContinuityEvidence(add, workspace, doc, context);
  return { byId, segments, evidence };
}

export function locateReviewBasis(issue, byId, primary) {
  const references = Array.isArray(issue.basis) ? issue.basis : [];
  const basis = new Map();
  let pending = issue.basisStatus !== 'supported' || !references.length || references.length > 4;
  for (const ref of references.slice(0, 4)) {
    const source = byId.get(ref?.id);
    const quote = ref?.quote;
    const offset = source && typeof quote === 'string' && quote.trim().length >= 2 && quote.length <= 430
      ? source.text.indexOf(quote) : -1;
    if (offset < 0 || source.text.indexOf(quote, offset + 1) >= 0) { pending = true; continue; }
    const start = source.start + offset;
    if (source.documentId === primary.documentId && start < primary.end && start + quote.length > primary.start) {
      pending = true;
      continue;
    }
    const { documentId, sourceHash, kind, title, label } = source;
    const line = source.line + sourceLine(source.text, offset) - 1;
    basis.set(JSON.stringify([documentId, start, quote.length]), { documentId, sourceHash, kind, title, label, line, start, quote });
  }
  return { basis: [...basis.values()], basisStatus: pending ? 'pending' : 'located' };
}
