import { AppError, decode, encode, hash, stamp, uid } from './io.mjs';

export const issueLocation = issue => JSON.stringify([issue.origin, issue.category, issue.term || '',
  issue.start, issue.end, issue.start == null ? issue.id : issue.quote]);
export const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const historyPath = id => `_创作管理/稿件核对/${id}.history.json`;

export function contextAnchor(text, start, end) {
  return { start, left: text.slice(Math.max(0, start - 36), start), right: text.slice(end, end + 36) };
}

export function anchorPosition(text, quote, anchor) {
  const surrounding = anchor.left + quote + anchor.right;
  if (!surrounding) return -1;
  const at = text.indexOf(surrounding);
  return at >= 0 && text.indexOf(surrounding, at + 1) < 0 ? at + anchor.left.length : -1;
}

export async function readManuscriptHistory(workspace, documentId) {
  const path = historyPath(documentId);
  const bytes = await workspace.store.read(path);
  const data = { schema: 1, workId: workspace.project.id, documentId, entries: [] };
  if (bytes) {
    let existing;
    try { existing = JSON.parse(bytes.toString('utf8')); } catch {}
    if (existing?.schema !== data.schema || existing?.workId !== data.workId ||
      existing?.documentId !== documentId || !Array.isArray(existing.entries)) {
      throw new AppError('DAMAGED_DATA', '稿件核对记录无法读取，已保留原文件。');
    }
    data.entries = existing.entries;
  }
  return { data, path, expectedHash: bytes ? hash(bytes) : null };
}

export function historyChange({ data, path, expectedHash }) {
  return { path, expectedHash, text: JSON.stringify(data, null, 2) };
}

function passageAnchor(text, start, end) {
  const breaks = [...text.matchAll(/\r?\n[\t ]*\r?\n/gu)];
  const before = breaks.findLast(match => match.index + match[0].length <= start);
  const after = breaks.find(match => match.index >= end);
  return { start, left: text.slice(before ? before.index + before[0].length : 0, start),
    right: text.slice(end, after?.index ?? text.length) };
}

export async function keptManuscriptDecisions(workspace, doc, report, entries) {
  const matched = new Map(), snapshots = new Map();
  for (const row of entries) {
    if (row.kind !== 'keep' || row.reversedAt) continue;
    if (row.reviewHeads && row.reviewHeads.some(key => row[key] !== report[key])) continue;
    let signature;
    try { signature = JSON.parse(row.key); } catch { continue; }
    if (!Array.isArray(signature)) continue;
    const [origin, category, term, start, end] = signature;
    if (start === null) {
      const issue = report.issues.find(issue => row.sourceHash === doc.hash && issueLocation(issue) === row.key);
      if (issue) matched.set(issue.id, row.id);
      continue;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || !row.before) continue;
    let position = start;
    if (row.sourceHash !== doc.hash) {
      let anchor = row.passage;
      if (!anchor && /^[a-f0-9]{64}$/u.test(row.sourceHash)) {
        if (!snapshots.has(row.sourceHash)) {
          const bytes = await workspace.store.read(`_创作管理/历史/文档版本/${doc.id}/${row.sourceHash}.md`);
          snapshots.set(row.sourceHash, bytes && hash(bytes) === row.sourceHash ? decode(bytes).text : '');
        }
        const prior = snapshots.get(row.sourceHash);
        if (prior.slice(start, end) === row.before) anchor = passageAnchor(prior, start, end);
      }
      if (!anchor) continue;
      position = anchorPosition(doc.text, row.before, anchor);
      if (position < 0) continue;
      const current = passageAnchor(doc.text, position, position + row.before.length);
      if (current.left !== anchor.left || current.right !== anchor.right) continue;
    }
    if (position < 0 || doc.text.slice(position, position + row.before.length) !== row.before) continue;
    for (const issue of report.issues) {
      if (issue.origin === origin && issue.category === category && (issue.term || '') === term &&
        issue.start != null && issue.start < position + row.before.length && issue.end > position &&
        (origin === 'ai' || issue.message === row.message)) matched.set(issue.id, row.id);
    }
  }
  return matched;
}

export function manuscriptDecision(doc, issue, kind, report) {
  return { id: uid('manuscript-decision'), kind, at: stamp(), sourceHash: doc.hash,
    key: issueLocation(issue), category: issue.category, line: issue.line, term: issue.term || '',
    message: issue.message, before: issue.quote,
    ...(kind === 'keep' && issue.start != null ? { passage: passageAnchor(doc.text, issue.start, issue.end) } : {}),
    ...(report ? { reviewHeads: ['ruleHash', 'continuityStamp'], ruleHash: report.ruleHash, continuityStamp: report.continuityStamp } : {}) };
}

export function addManuscriptEdits(history, doc, finalText, issues, edits) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const afterHash = hash(encode(finalText, doc));
  const ordered = edits.map(edit => ({ issue: byId.get(edit.id), after: edit.after })).sort((a, b) => a.issue.start - b.issue.start);
  let shift = 0;
  for (const { issue, after } of ordered) {
    const start = issue.start + shift, end = start + after.length;
    history.data.entries.push({ ...manuscriptDecision(doc, issue, 'edit'), after, afterHash,
      anchor: contextAnchor(finalText, start, end) });
    shift += after.length - issue.quote.length;
  }
}

export function undoPosition(doc, entry) {
  if (entry.kind !== 'edit' || entry.reversedAt || doc.readOnly) return -1;
  if (doc.hash === entry.afterHash && doc.text.slice(entry.anchor.start, entry.anchor.start + entry.after.length) === entry.after) {
    return entry.anchor.start;
  }
  return anchorPosition(doc.text, entry.after, entry.anchor);
}

function historyPaths(workspace, doc) {
  const publication = workspace.project.chapterPublications?.[doc.id];
  const moves = (workspace.project.sourceHistory?.moves || []).filter(row => row.documentId === doc.id);
  return new Set([doc.path, publication?.from, ...moves.map(row => row.from)].filter(Boolean));
}

export async function manuscriptLegacySaves(workspace, doc) {
  const paths = historyPaths(workspace, doc);
  return (await workspace.store.history()).flatMap(batch => {
    if (batch.status !== 'committed' || batch.label.startsWith('稿件核对 ·')) return [];
    const index = batch.files.findIndex(file => paths.has(file.path) && file.beforeHash && file.afterHash && file.beforeHash !== file.afterHash);
    if (index < 0) return [];
    return [{ id: batch.id, index, at: batch.completed_at || batch.created_at, label: batch.label, ...batch.files[index] }];
  });
}

export async function readLegacySave(workspace, doc, id) {
  const row = (await manuscriptLegacySaves(workspace, doc)).find(batch => batch.id === id);
  if (!row) throw new AppError('NOT_FOUND', '未找到这次保存的前后版本');
  const base = `_创作管理/历史/${row.id}/${row.index}`;
  const [before, after] = await Promise.all([workspace.store.read(base + '.before'), workspace.store.read(base + '.after')]);
  if (!before || !after || hash(before) !== row.beforeHash || hash(after) !== row.afterHash) {
    throw new AppError('DAMAGED_SNAPSHOT', '这次保存的版本快照缺失或损坏');
  }
  return { row, before: decode(before).text, after: decode(after).text };
}

export function legacyDifference(before, after) {
  let start = 0, left = before.length, right = after.length;
  while (start < left && start < right && before[start] === after[start]) start++;
  while (left > start && right > start && before[left - 1] === after[right - 1]) { left--; right--; }
  const limit = start + 2600;
  return { line: lineAt(before, start), before: before.slice(start, Math.min(left, limit)),
    after: after.slice(start, Math.min(right, limit)), truncated: Math.max(left, right) > limit };
}
