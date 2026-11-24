import { AppError, decode, hash } from './io.mjs';
import { wordingNotices } from './wording.mjs';
import { locateReviewBasis } from './manuscript-evidence.mjs';

export const reviewCategories = ['wording', 'dialogue', 'behavior', 'style'];
export const manuscriptRulesPath = '00-项目导航/稿件核对.json';
export const ruleGroups = ['style', 'wording', 'context', 'legacy', 'workflow'];

export async function readManuscriptRules(store) {
  const bytes = await store.read(manuscriptRulesPath);
  if (!bytes) return { rules: {}, ruleHash: null };
  let rules;
  try { rules = JSON.parse(decode(bytes).text); }
  catch { throw new AppError('REVIEW_RULES', '稿件核对规则文件无法读取，请修正后重跑。'); }
  if (!rules || typeof rules !== 'object' || !Array.isArray(rules.wording) ||
    rules.wording.some(r => typeof r?.term !== 'string' || !r.term || typeof r.message !== 'string') ||
    rules.ruleFiles !== undefined && (!Array.isArray(rules.ruleFiles) || rules.ruleFiles.some(path => typeof path !== 'string')) ||
    rules.ruleSources !== undefined && (!Array.isArray(rules.ruleSources) || rules.ruleSources.some(source =>
      typeof source?.path !== 'string' || !source.path || typeof source.label !== 'string' ||
      !ruleGroups.includes(source.group) || !['core', 'chapter', 'lookup', 'examples', 'reference'].includes(source.use) ||
      source.limit !== undefined && (!Number.isInteger(source.limit) || source.limit < 100 || source.limit > 1500) ||
      source.use === 'chapter' && (!Array.isArray(source.chapters) || !source.chapters.length ||
        source.chapters.some(chapter => !Number.isInteger(chapter) || chapter < 1)))) ||
    Object.values(rules.exceptions || {}).some(values => !Array.isArray(values) || values.some(v => typeof v !== 'string'))) {
    throw new AppError('REVIEW_RULES', '稿件核对的作品词表或排除条件格式有误。');
  }
  return { rules, ruleHash: hash(bytes) };
}

export function manuscriptSpans(text) {
  const spans = [];
  let start = null, end = 0, body = 0;
  const flush = () => {
    if (start === null) return;
    body++;
    for (let from = start; from < end;) {
      let to = Math.min(from + 820, end);
      if (to < end) {
        const window = text.slice(from + 450, to);
        const boundary = Math.max(...['。', '！', '？', '\n', '；'].map(mark => window.lastIndexOf(mark)));
        if (boundary >= 0) to = from + 450 + boundary + 1;
        else if (/[\uD800-\uDBFF]/u.test(text[to - 1])) to--;
      }
      spans.push({ id: String(spans.length + 1), paragraph: body, start: from, end: to, text: text.slice(from, to) });
      from = to;
    }
    start = null;
  };
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text)?.[0].length || 0;
  for (const m of text.matchAll(/[^\r\n]*(?:\r?\n|$)/gu)) {
    if (m.index < frontmatter || !m[0].trim() || /^(?:#{1,6}\s|(?:[-*_]\s*){3,}$)/u.test(m[0].trim())) {
      flush();
      continue;
    }
    if (start === null) start = m.index;
    end = m.index + m[0].replace(/\r?\n$/u, '').length;
  }
  flush();
  return spans;
}

export function reviewWindows(spans) {
  const windows = [];
  let part = [], size = 0;
  for (const span of spans) {
    if (part.length && (part.length >= 20 || size + span.text.length > 2900 || Number(span.id) !== Number(part.at(-1).id) + 1)) {
      windows.push(part);
      part = []; size = 0;
    }
    part.push(span); size += span.text.length;
  }
  if (part.length) windows.push(part);
  return windows;
}

function matches(text, term) {
  if (!term) return [];
  const rows = [];
  for (let start = text.indexOf(term); start !== -1; start = text.indexOf(term, start + term.length)) {
    rows.push({ start, end: start + term.length });
  }
  return rows;
}

export function suppressedWording(text, term, start, rules) {
  return (rules.exceptions?.[term] || []).some(phrase => {
    const offset = phrase.indexOf(term);
    return offset >= 0 && text.slice(start - offset, start - offset + phrase.length) === phrase;
  });
}

function linesOf(text) {
  return [...text.matchAll(/\n/gu)].map(m => m.index);
}

function sourceLine(lines, start) {
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function finding(text, lines, data, position) {
  const { start, end } = position || {};
  const quote = position ? text.slice(start, end) : '';
  const id = hash(JSON.stringify([data.origin, data.category, data.term, data.message, start, end])).slice(0, 22);
  return { id, ...data, start: start ?? null, end: end ?? null,
    line: position ? sourceLine(lines, start) : null, quote };
}

export function repairOpening(text, issue) {
  if (issue.origin !== 'machine' || !issue.message.startsWith('相邻段同名起句') || !issue.quote ||
    !/^[\p{L}]+$/u.test(issue.quote) || text.slice(issue.start, issue.end) !== issue.quote) return issue;
  const available = text.slice(issue.start, issue.start + 220).split(/\r?\n/u, 1)[0];
  const sentence = available.match(/^.+?[。！？](?:[”’])?/u)?.[0] || available;
  if (sentence === issue.quote) return issue;
  const id = hash(JSON.stringify([issue.id, issue.start, sentence])).slice(0, 22);
  return { ...issue, id, openingName: issue.quote, quote: sentence, end: issue.start + sentence.length };
}

function gateParts(line) {
  const content = line.slice(line.indexOf('：') + 1);
  return content.split(/；(?![^（〔(]*[）〕)])/u);
}

function formatFindings(text, add) {
  const addAll = (pattern, message) => {
    for (const m of text.matchAll(pattern)) add({ category: 'style', severity: 'hard', message }, { start: m.index, end: m.index + m[0].length });
  };
  addAll(/"/gu, 'ASCII 直引号');
  addAll(/&#(?:x[0-9a-f]+|\d+);|&(?:quot|amp|lt|gt|apos);/giu, 'HTML 实体残留');
  let open = null;
  for (const m of text.matchAll(/[“”]/gu)) {
    if (m[0] === '“') {
      if (open !== null) add({ category: 'style', severity: 'hard', message: '左引号未闭合，又出现左引号' }, { start: open, end: open + 1 });
      open = m.index;
    } else if (open !== null) open = null;
    else add({ category: 'style', severity: 'hard', message: '右引号缺少对应的左引号' }, { start: m.index, end: m.index + 1 });
  }
  if (open !== null) add({ category: 'style', severity: 'hard', message: '左引号未闭合' }, { start: open, end: open + 1 });
}

function stylePositions(text, spans, notice, dialogue) {
  const paragraphs = spans.filter((span, i) => i === 0 || spans[i - 1].paragraph !== span.paragraph);
  const named = [...notice.matchAll(/'([^']+)'|"([^"]+)"/gu)].map(m => m[1] || m[2]);
  if (notice.startsWith('相邻段同名起句')) {
    return paragraphs.flatMap((span, i) => named.filter(name =>
      span.text.trimStart().startsWith(name) && paragraphs[i - 1]?.text.trimStart().startsWith(name)).map(name => {
      const start = span.start + span.text.indexOf(name);
      return { start, end: start + name.length };
    }));
  }
  if (notice.startsWith('同段专名')) {
    const names = [...notice.matchAll(/([\p{L}]+)×\d+/gu)].map(m => m[1]);
    return spans.flatMap(span => names.flatMap(name => {
      const positions = matches(span.text, name);
      return positions.length > 2 ? positions.map(({ start, end }) => ({ start: start + span.start, end: end + span.start })) : [];
    }));
  }
  if (/^用力②/u.test(notice)) named.push(...[...notice.matchAll(/([\p{L}]+)×\d+/gu)].map(m => m[1]));
  if (/^破折号/u.test(notice)) named.push('——');
  if (/^比喻 \d/u.test(notice)) named.push('似的', '犹如', '仿佛', '宛如', '如同', '一般', '像是', '好似', '恰似');
  const insideParagraph = position => spans.some(span => position.start >= span.start && position.end <= span.end);
  return named.flatMap(term => matches(text, term)).filter(position => insideParagraph(position) &&
    (!/^(?:用力|套语|叙述用力|≤6字叙述)/u.test(notice) || !dialogue.some(d => position.start >= d.start && position.end <= d.end)));
}

export function machineFindings(text, gate, rules = {}, spans = manuscriptSpans(text)) {
  const rows = [], lines = linesOf(text);
  const add = (data, position) => rows.push(finding(text, lines, { origin: 'machine', ...data }, position));
  formatFindings(text, add);
  const dialogue = [...text.matchAll(/“[^”]*”/gu)].map(m => ({ start: m.index, end: m.index + m[0].length }));
  const rulesByTerm = new Map((rules.wording || []).map(rule => [rule.term, rule]));
  for (const n of wordingNotices(gate.output)) {
    if (rulesByTerm.has(n.term)) continue;
    const expression = n.raw.match(/（对白；正则 (.+)）/u)?.[1];
    const onlyDialogue = /（对白|（唐义.+对白/u.test(n.raw);
    const positions = expression ? dialogue.flatMap(span => {
      try {
        return [...text.slice(span.start + 1, span.end - 1).matchAll(new RegExp(expression, 'gu'))]
          .filter(m => !!m[0]).map(m => ({ start: span.start + 1 + m.index, end: span.start + 1 + m.index + m[0].length }));
      } catch { return []; }
    }) : matches(text, n.term).filter(p => !onlyDialogue || dialogue.some(d => p.start >= d.start && p.end <= d.end));
    for (const position of positions) if (!suppressedWording(text, n.term, position.start, rules)) {
      add({ category: 'wording', severity: 'reminder', term: n.term, message: n.raw, research: true }, position);
    }
  }
  for (const rule of rulesByTerm.values()) {
    for (const position of matches(text, rule.term)) {
      if (!spans.some(span => position.start >= span.start && position.end <= span.end) || suppressedWording(text, rule.term, position.start, rules)) continue;
      add({ category: 'wording', research: !!rules.historicalPeriod, ...rule }, position);
    }
  }
  for (const line of String(gate.coreOutput || gate.output).split('\n').map(s => s.trim())) {
    if (/^[✗⚠] (?:硬线未过|软线提醒|作品文风禁用词)/u.test(line)) {
      for (const message of gateParts(line)) {
        if (/^(?:唐代用词检查未完成|ASCII 直引号|HTML 实体残留|中文引号)/u.test(message)) continue;
        const ban = line.startsWith('✗ 作品文风禁用词') && message.split('×')[0];
        const positions = ban ? matches(text, ban) : stylePositions(text, spans, message, dialogue);
        const data = { category: 'style', severity: line.startsWith('✗') ? 'hard' : 'reminder', message };
        for (const position of positions.length ? positions : [null]) add(data, position);
      }
    } else if (/^～ 文风.*：/u.test(line)) {
      for (const message of gateParts(line)) {
        const term = message.split('×')[0];
        for (const position of matches(text, term)) add({ category: 'style', severity: 'reminder', message }, position);
      }
    }
  }
  return [...new Map(rows.map(row => [row.id, row])).values()];
}

export function semanticFindings(data, spans, doc, rules, evidence) {
  const { text } = doc;
  const lines = linesOf(text);
  const rows = Array.isArray(data?.results) ? data.results : [];
  const coverage = [], findings = [];
  for (const span of spans) {
    const replies = rows.filter(row => String(row?.id) === span.id);
    const entry = replies[0];
    const checked = new Set(replies.length === 1 && Array.isArray(entry.checked) && Array.isArray(entry.issues) &&
      entry.issues.length <= 20 && entry.issues.every(issue => reviewCategories.includes(issue?.category))
      ? entry.checked.filter(c => (span.categories || reviewCategories).includes(c)) : []);
    for (const issue of checked.size ? entry.issues : []) {
      const category = issue?.category;
      if (!checked.has(category)) continue;
      const quote = issue.quote;
      const offset = typeof quote === 'string' && quote.trim() && quote.length <= 820 ? span.text.indexOf(quote) : -1;
      if (offset < 0 || span.text.indexOf(quote, offset + 1) >= 0 || typeof issue.message !== 'string' || !issue.message.trim()) {
        checked.delete(category);
        continue;
      }
      const term = category === 'wording' && typeof issue.term === 'string' && issue.term.trim().length <= 20 &&
        quote.includes(issue.term.trim()) ? issue.term.trim() : '';
      const rule = (rules.wording || []).find(r => r.term === term);
      const start = span.start + offset;
      const end = start + quote.length;
      if (term && (rule || matches(quote, term).every(match => suppressedWording(text, term, start + match.start, rules)))) continue;
      const support = category === 'wording' ? {} : locateReviewBasis(issue, evidence, { documentId: doc.id, start, end });
      const suggestion = support.basisStatus !== 'pending' && typeof issue.suggestion === 'string' ? issue.suggestion.slice(0, 1200) : '';
      const wordingSense = term && typeof issue.usage === 'string' ? issue.usage.trim().slice(0, 120) : '';
      findings.push(finding(text, lines, { origin: 'ai', category, term, severity: term && rules.historicalPeriod ? 'research' : 'review',
        ...support, segmentId: span.id, wordingSense,
        research: !!(term && rules.historicalPeriod), message: issue.message.slice(0, 700),
        suggestion,
      }, { start, end }));
    }
    coverage.push({ id: span.id, checked: [...checked] });
  }
  return { coverage, findings };
}
