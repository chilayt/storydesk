import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, confirmFirst, fixture } from './helpers.mjs';
import { manuscriptSpans, machineFindings, reviewCategories, reviewWindows } from '../core/manuscript-findings.mjs';
import { RESEARCH_MCP_URL } from '../core/research-search.mjs';

const rules = {
  historicalPeriod: '架空唐',
  wording: [
    { term: '免费', message: '用词偏现代', severity: 'reminder' },
    { term: '看客', message: '词义待考', severity: 'research', usage: '指旁观者', searchHint: '看客 旁观者 唐代 书证' },
  ],
  exceptions: { 在下: ['在下榻'] },
};
const profilePath = '00-项目导航/稿件核对.json';
const pieces = [
  '阿青在下榻的客店外打量了片刻。有人招呼看客免费进门。',
  '沈舟说：“三日前的旧事，谁告诉你的？”',
  '阿青从来不识水性，却一步跳下船沿。',
  '她替她扶住门板，始终没有回头。',
];
const response = data => Response.json({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { total_tokens: 320 } });

test('machine matches literal terms with context exclusions and exact line locations', () => {
  const prose = '---\r\nmeta: 看客\r\n---\r\n# 章名\r\n\r\n在下榻的店里接待看客。\r\n\r\n“在下见过诸位，今日免费。”';
  const gate = { output: '⚠ 唐代用词醒目提醒（作者裁定，可放宽）：在下×1' };
  const issues = machineFindings(prose, gate, rules);
  assert.deepEqual(issues.filter(i => i.term === '在下').map(i => i.line), [8]);
  assert.deepEqual(issues.filter(i => i.term === '看客').map(i => i.line), [6]);
  assert.deepEqual(issues.filter(i => i.term === '免费').map(i => i.line), [8]);
  assert.equal(manuscriptSpans(prose).length, 2);
});

test('missing or ungrounded AI reviews stay incomplete and only unfinished windows are sent on retry', async t => {
  let pass = 0;
  const sent = [];
  const f = await fixture('manuscript-coverage', { fetcher: async (_url, request) => {
    const { segments } = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    sent.push(segments.map(s => s.id));
    return response({ results: segments.map(s => ({ id: s.id, checked: reviewCategories,
      issues: s.id === '1' && !pass ? [{ category: 'dialogue', quote: '模型凭空拼的句子', message: '不可定位' }] :
        [2, 3, 4].includes(Number(s.id)) ? [{ category: reviewCategories[Number(s.id) - 1], quote: s.text, message: '虚构问题' }] : [],
    })) });
  } });
  t.after(f.close);
  const w = f.workspace;
  await f.write(profilePath, JSON.stringify(rules));
  await configure(w);
  const text = ['# 样稿', ...pieces, ...Array.from({ length: 26 }, (_, i) => `回程第${i + 1}步，沈舟看着江上的水光。`)].join('\n\n');
  const doc = await w.createChapterDraft({ chapter: 23, title: '样稿', importedText: text });
  const parameters = { documentId: doc.id, sourceHash: doc.hash };
  const result = await w.checkManuscript(parameters);
  assert.equal(result.semanticStatus, 'partial', result.error);
  assert.equal(result.totals.dialogue, result.passages - 1);
  assert.equal(result.totals.behavior, result.passages);
  assert.ok(!result.issues.some(issue => issue.quote === '模型凭空拼的句子'));
  assert.equal(await f.read(doc.path), text);
  assert.equal(sent.length, reviewWindows(manuscriptSpans(text)).length + 1);
  assert.deepEqual(sent.at(-1), ['1']);
  pass++;
  sent.length = 0;
  const retry = await w.checkManuscript(parameters);
  assert.equal(sent.length, 1);
  assert.equal(retry.semanticStatus, 'complete');
  for (const issue of retry.issues) assert.equal(text.slice(issue.start, issue.end), issue.quote);
  assert.ok(retry.issues.some(issue => issue.category === 'dialogue' && issue.line === 5 && issue.origin === 'ai'));
});

test('author releases and reviewed patches stay in scope and defer manuscript writes', async t => {
  const f = await fixture('manuscript-author');
  t.after(f.close);
  const w = f.workspace;
  await f.write(profilePath, JSON.stringify(rules));
  const text = '# 样稿\n\n' + pieces[0];
  const doc = await w.createChapterDraft({ chapter: 23, title: '样稿', importedText: text });
  const report = await w.checkManuscript({ documentId: doc.id, sourceHash: doc.hash });
  assert.equal(report.semanticStatus, 'not_run');
  const key = { documentId: doc.id, reportId: report.id, sourceHash: doc.hash };
  const { id: issueId } = report.issues.find(i => i.term === '看客');
  await assert.rejects(w.decideManuscriptWording({ ...key, issueId, scope: 'revision' }), { code: 'VALIDATION' });
  const decision = await w.decideManuscriptWording({ ...key, issueId, scope: 'revision', confirmed: true });
  assert.ok(decision.issues.find(i => i.term === '看客').allowed);
  assert.equal(await f.read(doc.path), text);
  const selected = [{ id: report.issues.find(i => i.term === '免费').id, after: '不收一文' }];
  await assert.rejects(w.applyManuscriptEdits({ ...key, edits: selected }), { code: 'VALIDATION' });
  const changed = await w.applyManuscriptEdits({ ...key, edits: selected, confirmed: true });
  assert.match(await f.read(doc.path), /不收一文/u);
  assert.equal(w.project.approvals.length, 0);
  assert.ok((await w.getManuscriptReport({ documentId: doc.id })).stale);
  await assert.rejects(w.applyManuscriptEdits({ ...key, edits: selected, confirmed: true }), { code: 'CONFLICT' });
  const newer = await w.checkManuscript({ documentId: doc.id, sourceHash: changed.document.hash });
  assert.ok(!newer.issues.find(i => i.term === '看客').allowed);
  assert.ok(newer.issues.find(i => i.term === '看客').olderRelease.id);
  const records = await w.getManuscriptHistory({ documentId: doc.id });
  assert.deepEqual(records.entries.map(e => [e.kind, e.before, e.after, e.canUndo]), [['edit', '免费', '不收一文', true]]);
  assert.equal(records.wordings[0].effective, false);
  await w.undoManuscriptDecision({ documentId: doc.id, entryId: records.entries[0].id,
    sourceHash: changed.document.hash, type: 'edit', confirmed: true });
  assert.equal(await f.read(doc.path), text);
  assert.ok((await w.getManuscriptHistory({ documentId: doc.id })).entries[0].reversedAt);
});

test('single-issue repair expands a repeated opening, rejects the same text, and writes only after approval', async t => {
  let responseText = '阿青推门进去。';
  let requests = 0;
  const f = await fixture('manuscript-opening', { fetcher: async (_url, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    assert.equal(payload.issue.quote, '阿青推门进去。');
    assert.match(payload.before, /阿青来到门外。/u);
    assert.equal(payload.segments, undefined);
    requests++;
    return response({ replacement: responseText, reason: '调整第二句的起句节奏。' });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const text = '# 虚构稿\n\n阿青来到门外。\n\n阿青推门进去。';
  const doc = await w.createChapterDraft({ chapter: 23, title: '起句', importedText: text });
  const checksFor = w.checksFor.bind(w);
  w.checksFor = async params => ({ ...await checksFor(params), coreOutput: "✗ 硬线未过：相邻段同名起句 '阿青'" });
  const params = { documentId: doc.id, sourceHash: doc.hash };
  const report = await w.checkManuscript({ ...params, useAI: false });
  const issue = report.issues.find(row => row.openingName === '阿青');
  const input = { ...params, reportId: report.id, issueId: issue.id };
  assert.equal((await w.suggestManuscriptEdit(input)).replacement, '');
  responseText = '门一推开，阿青便走了进去。';
  const suggested = await w.suggestManuscriptEdit(input);
  assert.equal(suggested.replacement, responseText);
  assert.equal(await f.read(doc.path), text);
  const edits = [{ id: issue.id, after: suggested.replacement }];
  await assert.rejects(w.applyManuscriptEdits({ ...input, edits }), { code: 'VALIDATION' });
  const saved = await w.applyManuscriptEdits({ ...input, edits, confirmed: true });
  assert.equal(saved.document.text, text.replace(issue.quote, responseText));
  const checked = await w.checkManuscript({ ...params, sourceHash: saved.document.hash, useAI: false });
  assert.ok(!checked.issues.some(row => row.openingName === '阿青'));
  assert.equal(requests, 2);
});

test('old releases can be carried together and original-passage confirmations survive a different paragraph edit', async t => {
  let quote = '阿青没有等船停稳，便纵身跳上岸。';
  const f = await fixture('manuscript-decisions-carry', { fetcher: async (_url, request) => {
    const { segments } = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    return response({ results: segments.map(s => ({ id: s.id, checked: reviewCategories,
      issues: s.text.includes(quote) ? [{ category: 'behavior', quote, message: '核对动作。' }] : [] })) });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  await f.write(profilePath, JSON.stringify(rules));
  const text = '# 样稿\n\n' + pieces[0] + '\n\n' + quote + '\n\n天已放晴。';
  const doc = await w.createChapterDraft({ chapter: 23, title: '决定沿用', importedText: text });
  const first = await w.checkManuscript({ documentId: doc.id, sourceHash: doc.hash });
  const old = { documentId: doc.id, sourceHash: doc.hash, reportId: first.id, confirmed: true };
  const issueIds = first.issues.filter(i => i.term).map(issue => issue.id);
  await assert.rejects(w.batchManuscriptWording({ ...old, issueIds: [...issueIds, 'missing'], scope: 'revision' }), { code: 'VALIDATION' });
  const batch = await w.batchManuscriptWording({ ...old, issueIds, scope: 'revision' });
  assert.ok(batch.issues.filter(issue => issue.term).every(issue => issue.allowed && issue.decision.scope === 'revision'));
  const behavior = first.issues.find(i => i.category === 'behavior');
  const accepted = await w.confirmManuscriptIssue({ ...old, issueId: behavior.id });
  const keepId = accepted.issues.find(i => i.id === behavior.id).confirmedOkay;
  assert.ok(keepId);
  // Exercise the journal stored by releases before passage anchors were added.
  const journalPath = `_创作管理/稿件核对/${doc.id}.history.json`;
  const journal = JSON.parse(await f.read(journalPath));
  delete journal.entries[0].passage;
  delete journal.entries[0].reviewHeads;
  await f.write(journalPath, JSON.stringify(journal));
  const edit = await w.saveDocument({ documentId: doc.id, expectedHash: doc.hash, text: text.replace('天已放晴。', '江风渐小了。') });
  quote = '纵身跳上岸';
  const second = await w.checkManuscript({ documentId: doc.id, sourceHash: edit.document.hash });
  assert.equal(second.issues.find(i => i.quote === quote).confirmedOkay, keepId);
  const decisionIds = second.issues.flatMap(i => i.olderRelease ? [i.olderRelease.id] : []);
  assert.equal(decisionIds.length, 2);
  const renewed = await w.carryManuscriptWording({ documentId: doc.id, sourceHash: edit.document.hash, reportId: second.id,
    decisionIds, confirmed: true });
  assert.ok(renewed.issues.filter(i => i.term).every(i => i.allowed && i.decision.scope === 'document'));
  assert.match(await f.read('05-剧本/设定/唐代用词_作者裁定.md'), /本章全文（包含后续修订）/u);
  const changed = await w.saveDocument({ documentId: doc.id, expectedHash: edit.document.hash,
    text: edit.document.text.replace('没有等船停稳', '看见船已停稳') });
  const third = await w.checkManuscript({ documentId: doc.id, sourceHash: changed.document.hash });
  assert.equal(third.issues.find(i => i.quote === quote).confirmedOkay, undefined);
  assert.ok(third.issues.filter(i => i.term).every(i => i.allowed));
});

test('a conversation can prepare a right-pane wording batch without writing rulings or changing the draft', async t => {
  const f = await fixture('manuscript-agent-batch', { fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    const { content } = request.messages.findLast(row => row.role === 'user');
    const { activeSource } = JSON.parse(typeof content === 'string' ? content : content[0].text);
    assert.ok(activeSource.workspaceReview.issues.length > 1);
    const args = { allowIds: [], rewriteIds: activeSource.workspaceReview.issues.map(issue => issue.id) };
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_review_batch', type: 'function', function: { name: 'prepare_wording_review', arguments: JSON.stringify(args) } },
    ] }, finish_reason: 'tool_calls' }] });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  await f.write(profilePath, JSON.stringify(rules));
  const original = '# 样稿\n\n' + pieces[0];
  const doc = await w.createChapterDraft({ chapter: 25, title: '措辞测试', importedText: original });
  const report = await w.checkManuscript({ documentId: doc.id, sourceHash: doc.hash, useAI: false });
  const design = await w.getCowriting({ documentId: 'outline_chapter_25' });
  const result = await w.sendCowriting({ documentId: design.documentId, sourceHash: design.sourceHash,
    workspaceReviewId: doc.id, message: '把右侧报告的用词准备拟改' });
  assert.equal(result.status, 'completed', result.error);
  const action = result.messages.at(-1).reviewAction;
  assert.equal(action.reportId, report.id);
  assert.equal(action.documentId, doc.id);
  assert.ok(action.rewriteIds.length > 1);
  assert.equal(await f.read(doc.path), original);
  assert.equal((w.project.wordingDecisions || []).length, 0);
});

test('rechecking retains unreported AI findings and reversible author decisions at the same location', async t => {
  let reviewRun = 0;
  const f = await fixture('manuscript-recheck-history', { fetcher: async (_url, request) => {
    const { segments } = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    reviewRun++;
    return response({ results: segments.map(s => ({ id: s.id, checked: reviewCategories,
      issues: reviewRun === 1 ? [{ category: 'dialogue', quote: s.text, message: '核对称呼。' }] : [],
    })) });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const doc = await w.createChapterDraft({ chapter: 23, title: '复检样稿', importedText: '# 虚构\n\n“请留步。”' });
  const params = { documentId: doc.id, sourceHash: doc.hash };
  const initial = await w.checkManuscript(params);
  const issue = initial.issues.find(i => i.category === 'dialogue');
  const accepted = await w.confirmManuscriptIssue({ ...params, reportId: initial.id, issueId: issue.id, confirmed: true });
  const recordId = accepted.issues.find(i => i.id === issue.id).confirmedOkay;
  assert.ok(recordId);
  const next = await w.checkManuscript({ ...params, restart: true });
  const retained = next.issues.find(i => i.id === issue.id);
  assert.equal(retained.recheck, 'not_seen');
  assert.equal(retained.confirmedOkay, recordId);
  await w.undoManuscriptDecision({ ...params, entryId: recordId, type: 'keep', confirmed: true });
  assert.equal((await w.getManuscriptReport(params)).issues.find(i => i.id === issue.id).confirmedOkay, undefined);
  assert.ok((await w.getManuscriptHistory(params)).entries[0].reversedAt);
});

test('selective manuscript undo tolerates distant edits and protects a changed replacement', async t => {
  const f = await fixture('manuscript-undo-anchor');
  t.after(f.close);
  const w = f.workspace;
  await f.write(profilePath, JSON.stringify(rules));
  const prose = '# 样稿\n\n阿青免费进门。\n\n' + '江面平静。'.repeat(70);
  const doc = await w.createChapterDraft({ chapter: 23, title: '差异样稿', importedText: prose });
  const params = { documentId: doc.id, sourceHash: doc.hash };
  const report = await w.checkManuscript({ ...params, useAI: false });
  const edits = [{ id: report.issues.find(issue => issue.term === '免费').id, after: '未付钱便' }];
  const written = await w.applyManuscriptEdits({ ...params, reportId: report.id, confirmed: true, edits });
  const saved = await w.saveDocument({ documentId: doc.id, expectedHash: written.document.hash,
    text: written.document.text + '新近增写一句。' });
  const history = await w.getManuscriptHistory(params);
  assert.equal(history.entries[0].canUndo, true);
  assert.equal(history.legacy.length, 1);
  const diff = await w.getManuscriptSaveDiff({ ...params, entryId: history.legacy[0].id });
  assert.deepEqual([diff.before, diff.after, diff.canUndo], ['', '新近增写一句。', true]);
  const conflicting = await w.saveDocument({ documentId: doc.id, expectedHash: saved.document.hash,
    text: saved.document.text.replace('未付钱便', '付过钱才') });
  const undo = { documentId: doc.id, entryId: history.entries[0].id, type: 'edit', confirmed: true };
  await assert.rejects(w.undoManuscriptDecision({ ...undo, sourceHash: conflicting.document.hash }), { code: 'CONFLICT' });
  const rollback = await w.getManuscriptHistory(params);
  const restored = await w.undoManuscriptDecision({ documentId: doc.id, entryId: rollback.legacy[0].id,
    type: 'legacy', confirmed: true, sourceHash: conflicting.document.hash });
  await w.undoManuscriptDecision({ ...undo, sourceHash: restored.document.hash });
  assert.equal(await f.read(doc.path), prose + '新近增写一句。');
});

test('a manuscript check is observable and cancellable while its machine report is being prepared', async t => {
  const f = await fixture('manuscript-stop');
  t.after(f.close);
  const w = f.workspace;
  const doc = await w.createChapterDraft({ chapter: 23, title: '停止核对样稿', importedText: '阿青等了一刻。' });
  let enteredGate;
  const gateStarted = new Promise(resolve => { enteredGate = resolve; });
  w.checksFor = async ({ signal }) => {
    enteredGate();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  };
  const params = { documentId: doc.id, sourceHash: doc.hash };
  const checking = w.checkManuscript(params);
  await gateStarted;
  assert.equal(w.manuscriptProgress(params).phase, 'machine');
  assert.equal(await w.cancelManuscriptReview(params), true);
  assert.equal(await checking, null);
  assert.equal(w.manuscriptProgress(params), null);
});

test('a truncated response is counted and bisected without losing the final paragraphs', async t => {
  const sent = [];
  const f = await fixture('manuscript-truncated', { fetcher: async (_url, request) => {
    const { segments } = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    sent.push(segments.map(s => Number(s.id)));
    if (segments.length > 2) return Response.json({ choices: [{ finish_reason: 'length',
      message: { reasoning_content: '测试截断' } }], usage: { total_tokens: 480 } });
    return response({ results: segments.map(s => ({ id: s.id, checked: reviewCategories, issues: [] })) });
  } });
  t.after(f.close);
  await configure(f.workspace);
  const doc = await f.workspace.createChapterDraft({ chapter: 23, title: '样稿', importedText: pieces.join('\n\n') });
  const result = await f.workspace.checkManuscript({ documentId: doc.id, sourceHash: doc.hash });
  assert.equal(result.semanticStatus, 'complete');
  assert.deepEqual(sent, [[1, 2, 3, 4], [1, 2], [3, 4]]);
  assert.equal(result.usage, 480 + 320 * 2);
  assert.equal(await f.read(doc.path), pieces.join('\n\n'));
});

test('semantic issues retain exact, versioned evidence from adjacent text, chapter time, character cards and prior confirmed chapters', async t => {
  const opening = '八月初七，沈舟在东埠借宿。';
  const route = '过了飞石桥，去西关还有百里。';
  const question = '沈舟问：“账上还有几文？”';
  const reply = '阿青说：“船桨昨天换了。”';
  const date = '沈舟掀帘时，日子还是七月廿九。';
  const journey = '一盏茶工夫，沈舟已经到了西关。';
  const identity = '沈舟应声道：“我一向在府里当掌书记。”';
  const baseline = '沈舟以渡船营生，从前没有在府署任职。';
  const prior = '沈舟开始试练第一层。';
  const capability = '沈舟使出早已练熟的第七层功法。';
  const ambiguity = '她替她守着门。';
  const f = await fixture('manuscript-basis', { fetcher: async (_url, request) => {
    const { evidence, segments } = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    const references = [...evidence, ...segments.map(s => ({ id: s.basisId, text: s.text }))];
    const ref = quote => ({ id: references.find(s => s.text.includes(quote))?.id || 'unknown-source', quote });
    const issue = (segment, category, support) => ({
      category, quote: segment.text, message: '虚构核对意见', basisStatus: 'supported',
      basis: support, suggestion: '供作者确认的候选文字。',
    });
    return response({ results: segments.map(s => ({
      id: s.id, checked: reviewCategories, issues: (s.text === reply ? [issue(s, 'dialogue', [ref(question)])]
        : s.text === date ? [issue(s, 'behavior', [ref(opening)])]
        : s.text === journey ? [issue(s, 'behavior', [ref(route)])]
        : s.text === identity ? [issue(s, 'dialogue', [ref(baseline)])]
        : s.text === capability ? [issue(s, 'behavior', [ref(prior)])]
        : s.text === ambiguity ? [issue(s, 'style', [
          ref(ambiguity), { id: s.basisId, quote: '伪造的另一句' }, { id: 'unknown-source', quote: '不在依据里' },
        ])] : []),
    })) });
  } });
  t.after(f.close);
  const w = f.workspace;
  await confirmFirst(w);
  const person = w.project.characters.find(c => c.name === '沈舟');
  const originalCard = w.doc(person.primarySourceId);
  await w.approveBaseline({ characterId: person.id, expectedSourceHash: originalCard.hash, fields: [{ field: '身份', value: baseline }] });
  const card = w.doc(originalCard.id), first = w.documents.find(d => d.chapter === 1 && d.kind === 'chapter');
  await configure(w);
  const prose = ['# 虚构稿', opening, ...Array.from({ length: 18 }, (_, i) => i === 7 ? route : `有第${i + 1}处石阶。`),
    question, reply, date, journey, identity, capability, ambiguity].join('\n\n');
  const doc = await w.createChapterDraft({ chapter: 23, title: '语义依据测试', importedText: prose });
  const report = await w.checkManuscript({ documentId: doc.id, sourceHash: doc.hash });
  assert.equal(report.semanticStatus, 'complete', report.error);
  assert.equal(report.issues.filter(i => i.origin === 'ai').length, 6);
  for (const [quote, support, source, kind] of [
    [reply, question, doc, 'draft'], [date, opening, doc, 'draft'], [journey, route, doc, 'draft'],
    [identity, baseline, card, 'baseline'], [capability, prior, first, 'prior'],
  ]) {
    const item = report.issues.find(i => i.quote === quote);
    assert.equal(item.basisStatus, 'located', quote);
    const [basis] = item.basis;
    assert.deepEqual([basis.documentId, basis.sourceHash, basis.kind, basis.quote], [source.id, source.hash, kind, support]);
    const original = await f.read(source.path);
    assert.ok(original.split('\n')[basis.line - 1].includes(support));
  }
  const pending = report.issues.find(i => i.quote === ambiguity);
  assert.deepEqual([pending.basisStatus, pending.basis.length, pending.suggestion], ['pending', 0, '']);
  assert.equal(await f.read(doc.path), prose);
  await f.write(card.path, (await f.read(card.path)).replace('营生', '谋生'));
  assert.equal((await w.getManuscriptReport({ documentId: doc.id })).stale, true);
  await assert.rejects(w.applyManuscriptEdits({ documentId: doc.id, reportId: report.id, sourceHash: doc.hash,
    edits: [{ id: report.issues.find(i => i.quote === identity).id, after: '人工确认试改' }], confirmed: true }), { code: 'CONFLICT' });
});

test('wording research sends only the selected expression to search, excludes period-only hits and validates any claimed usage', async t => {
  const term = '闲着也是闲着';
  const query = `"${term}" 唐代 古籍原文 书证 用法`;
  const original = `里中人说：“${term}，且拾几枝柴。”`;
  const work = '《样例文献甲》';
  const modern = `现今这句话通常表示左右无事可做，例如说“${term}”。`;
  let mode = 'same_sense', modelCalls = 0, alternateSearch = 0;
  const credit = () => mode === 'later' ? `北宋 作者甲${work}` : `唐代 作者甲${work}`;
  const f = await fixture('manuscript-term-evidence', { fetcher: async (url, request) => {
    const payload = JSON.parse(request.body);
    if (url === RESEARCH_MCP_URL) {
      if (payload.params.arguments.query === '"无事" 唐代 古籍原文 书证 用法') {
        alternateSearch++;
        return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text',
          text: `Title: 替代词样例\nURL: https://archive.example.org/alternative\nHighlights: ${credit()} 里中人说：“既然无事，可来帮忙。”` }] } });
      }
      assert.equal(payload.params.arguments.query, query);
      assert.doesNotMatch(request.body, /沈舟|华亭|天宝三载/u);
      const records = ['Title: 华亭县沿革\nURL: https://archive.example.org/unrelated\nHighlights: 天宝十载的建置。'];
      if (mode !== 'empty') records.push(`Title: 今义样例\nURL: https://archive.example.org/modern\nHighlights: ${modern}`);
      if (!['empty', 'modern'].includes(mode)) {
        records.push(`Title: 时代证据样例\nURL: https://archive.example.org/older\nPublished: 2026-02-05\nHighlights: ${'别页。'.repeat(130)}${credit()} 课本节录：${original}`);
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: records.join('\n\n') }] } });
    }
    const data = JSON.parse(payload.messages.at(-1).content);
    modelCalls++;
    assert.equal(data.period, '唐代');
    if (data.proposedReplacement) {
      assert.equal(data.proposedReplacement, '既然无事');
      assert.equal(data.term, '无事');
      return response({ status: 'same_sense', citations: [{ sourceId: data.sources[0].id, work, attribution: credit(),
        quote: '里中人说：“既然无事，可来帮忙。”', sense: '此刻空闲' }] });
    }
    assert.equal(data.term, term);
    assert.match(data.context, /沈舟/u);
    assert.ok(!data.sources.some(s => s.title.includes('华亭')));
    if (mode === 'empty') return response({ status: 'pending', citations: [], meaning: '说话人此刻没有事做',
      alternatives: [{ replacement: '既然无事', lookup: '无事', register: 'dialogue', reason: '对白承接下句，保留空闲含义' },
        { replacement: '正好得空', lookup: '', register: 'both', reason: '直接表达此时有空' }] });
    const source = data.sources.find(s => s.title === (mode === 'modern' ? '今义样例' : '时代证据样例'));
    return response({ status: ['invalid', 'modern'].includes(mode) ? 'same_sense' : mode,
      citations: [{ sourceId: source.id, work, attribution: credit(), quote: mode === 'invalid' ? original + '添字' :
        mode === 'modern' ? modern : original, sense: '有空时间' }] });
  } });
  t.after(f.close);
  const w = f.workspace;
  await f.write(profilePath, JSON.stringify({ ...rules, historicalPeriod: '架空唐 · 天宝三载（744）',
    wording: [{ term, message: '查同义书证', searchHint: '唐代历史的时间维度与奥秘' }] }));
  await configure(w);
  const prose = `# 样稿\n\n沈舟说：“${term}，来替我穿针。”`;
  const doc = await w.createChapterDraft({ chapter: 23, title: '用词查证样稿', importedText: prose });
  const report = await w.checkManuscript({ documentId: doc.id, sourceHash: doc.hash, useAI: false });
  const search = () => w.searchManuscriptWording({ documentId: doc.id, reportId: report.id, sourceHash: doc.hash,
    issueId: report.issues.find(i => i.term === term).id });
  for (const status of ['same_sense', 'different_sense', 'later', 'invalid', 'modern', 'empty']) {
    mode = status;
    const result = await search();
    assert.equal(result.query, query);
    assert.ok(result.results.every(s => s.excerpt.includes(term) && !s.title.includes('华亭')));
    assert.equal(result.assessment.status, ['invalid', 'modern', 'empty'].includes(status) ? 'pending' : status,
      JSON.stringify(result.assessment));
    if (['same_sense', 'different_sense', 'later'].includes(status)) {
      assert.equal(result.assessment.citations[0].quote, original);
      assert.equal(result.assessment.citations[0].attribution, credit());
    }
    if (status === 'empty') {
      assert.equal(result.meaning, '说话人此刻没有事做');
      assert.equal(result.alternatives[0].register, 'dialogue');
      assert.equal(result.alternatives[0].sources[0].url, 'https://archive.example.org/alternative');
      assert.equal(result.alternatives[1].sources, undefined);
    }
  }
  assert.equal(modelCalls, 7);
  assert.equal(alternateSearch, 1);
  assert.deepEqual(w.project.wordingDecisions || [], []);
  assert.equal(await f.read(doc.path), prose);
});
