import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, configure } from './helpers.mjs';

const one = '05-剧本/正文/第01章_渡口.md';
const two = '05-剧本/正文/第02章_北城.md';
const testFirst = '# 第一章 渡口\n\n## 天宝三载七月廿九\n\n两人约定日后翻阅《试笔录》。\n';
const testSecond = '# 第二章 北城\n\n## 天宝三载七月廿七\n\n沈舟果然翻开了《试笔录》。\n';

async function completed(w) {
  for (let tries = 0; tries < 150; tries++) {
    const current = await w.getBookReview();
    if (current && !current.active) return current;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('全书核对未完成');
}

test('book review links timeline and recurring clues, anchors both versions, and only writes after explicit approval', async t => {
  const { workspace: w, write, read, close } = await fixture('book-review-corrections');
  t.after(close);
  await write(one, testFirst);
  await write(two, testSecond);
  await w.createChapterDraft({ chapter: 3, title: '只在草稿', importedText: '# 未发布\n\n七月廿八。' });
  await w.refresh();
  await w.startBookReview();
  const report = await completed(w);
  assert.equal(report.status, 'complete', report.error);
  assert.deepEqual(report.chapters.map(row => row.chapter), [1, 2]);
  assert.equal(report.links[0].mentions.length, 2);
  assert.equal(report.links[0].mentions[1].date, '七月廿七');
  const date = report.issues.find(issue => issue.category === 'timeline');
  const hook = report.issues.find(issue => issue.category === 'hook');
  assert.equal(hook.evidence.length, 4);
  const evidence = date.evidence[1];
  assert.equal((await w.previewBookEvidence(evidence)).exact, true);
  const args = { reportId: report.id, issueId: date.id };
  const patch = { ...args, action: 'write', evidenceIndex: 1, replacement: '## 天宝三载八月初一' };
  await assert.rejects(w.decideBookReview({ ...patch, confirmed: true }), { code: 'VALIDATION' });
  await w.decideBookReview({ ...args, action: 'confirm' });
  assert.equal(await read(two), testSecond);
  await assert.rejects(w.decideBookReview(patch), { code: 'VALIDATION' });
  const result = await w.decideBookReview({ ...patch, confirmed: true });
  assert.equal(result.issues.find(issue => issue.id === date.id).status, 'written');
  assert.match(await read(two), /八月初一/u);
  assert.equal((await w.previewBookEvidence(evidence)).current, false);
  assert.ok((await w.previewBookEvidence(evidence)).exact);
  assert.equal(await read(one), testFirst);
  await w.startBookReview();
  assert.equal((await completed(w)).issues.some(issue => issue.category === 'timeline'), false);
});

test('a paused book task resumes at the next unread chapter', async t => {
  const { workspace: w, close } = await fixture('book-review-pause');
  t.after(close);
  const snapshot = w.snapshotDocument.bind(w);
  const examined = [];
  w.snapshotDocument = async doc => {
    examined.push(doc.chapter);
    if (examined.length === 1) w.stopBookReview();
    return snapshot(doc);
  };
  await w.startBookReview();
  const paused = await completed(w);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.chapters.map(row => row.status), ['read', 'queued']);
  await w.startBookReview({ resume: true });
  assert.equal((await completed(w)).status, 'complete');
  assert.deepEqual(examined, [1, 2]);
});

test('scene dates retain repeated headings and exclude dates from dialogue or an unrelated scene', async t => {
  const f = await fixture('book-scene-dates');
  t.after(f.close);
  await f.write(one, '# 第一章 渡口\n\n## 天宝三载七月初一\n\n船靠岸。\n\n## 天宝三载七月初二\n\n雨停了。\n\n## 天宝三载七月初一\n\n沈舟说：“七月初十，且再等等。”\n\n两人约定日后翻阅《试笔录》。\n\n## 未标日期的场次\n\n小舟仍未拆开《纸鸢册》。\n');
  await f.write(two, '# 第二章 北城\n\n## 天宝三载七月初三\n\n沈舟果然翻开了《试笔录》。船工也终于拆开《纸鸢册》。\n');
  const w = f.workspace;
  await w.refresh(); await w.startBookReview();
  const report = await completed(w);
  assert.deepEqual(report.chapters[0].timeline.filter(row => row.kind === 'heading').map(row => [row.label, row.evidence.line]),
    [['七月初一', 3], ['七月初二', 7], ['七月初一', 11]]);
  assert.ok(report.chapters[0].timeline.some(row => row.kind === 'mention' && row.label === '七月初十'));
  const dated = report.links.find(link => link.key === '试笔录').mentions[0];
  assert.deepEqual([dated.date, dated.dateEvidence.line], ['七月初一', 11]);
  assert.equal(report.links.find(link => link.key === '纸鸢册').mentions[0].date, undefined);
  const reversal = report.issues.find(issue => issue.title === '日期标题的顺序回退');
  assert.deepEqual(reversal.evidence.map(row => row.line), [7, 11]);
  assert.equal(report.needsRescan, false);
});

test('semantic review records exact submitted versions, rejects invented evidence and exposes provider failure per item', async t => {
  let calls = 0;
  const f = await fixture('book-semantic-evidence', { fetcher: async (_url, request) => {
    const items = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    calls++;
    if (calls === 2) return new Response('rate limit', { status: 429, headers: { 'retry-after': '0' } });
    const results = items.map(item => ({ id: item.id, status: 'supported', conclusion: '建议核对两处叙事时间。',
      limit: '只有摘录，是否倒叙待作者核对。', evidence: item.id.startsWith('timeline')
        ? item.sources.slice(0, 2).map(source => ({ id: source.id, quote: source.quote.trim() })) : [{ id: item.sources[0].id, quote: '虚构引文不会通过' }] }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: results }) }, finish_reason: 'stop' }], usage: { total_tokens: 50 } });
  } });
  t.after(f.close);
  await f.write(one, testFirst); await f.write(two, testSecond);
  const w = f.workspace;
  await w.refresh(); await configure(w); await w.startBookReview();
  const report = await completed(w);
  const reportId = report.id;
  async function wait() {
    for (let index = 0; index < 100; index++) {
      const result = await w.getBookSemanticReview({ reportId });
      if (!result.active) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('语义复核未完成');
  }
  await w.startBookSemanticReview({ reportId });
  const { items } = await wait();
  const [date, hook, link] = items;
  assert.equal(date.status, 'candidate');
  assert.equal(date.verified.length, 2);
  assert.ok(date.verified.every(row => row.sourceHash && row.clipped));
  assert.equal(hook.status, 'pending');
  assert.equal(hook.suggestion, '');
  assert.match(hook.validation.join(''), /唯一定位/u);
  assert.equal(link.status, 'failed');
  assert.match(link.error, /429|限|额度/u);
  assert.equal(link.attempted, true);
  assert.notEqual(link.received, true);
  assert.ok(link.sources.length);
  await w.startBookSemanticReview({ reportId, itemIds: [link.id] });
  const next = await wait();
  assert.deepEqual(next.items[0], date);
  assert.equal(next.items.find(row => row.id === link.id).status, 'pending');
  assert.equal(calls, 3);
  assert.equal(await f.read(one), testFirst);
  assert.equal(await f.read(two), testSecond);
  assert.deepEqual((await w.getBookReview()).issues, report.issues);
});

test('a changed version is flagged on reply and after completion, and a failed retry preserves its prior opinion and history', async t => {
  let delay;
  let entered;
  let fail = false;
  const f = await fixture('book-semantic-version-and-history', { fetcher: async (_url, request) => {
    const items = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    entered?.resolve();
    if (delay) await delay.promise;
    if (fail) return new Response('rate limit', { status: 429 });
    const results = items.map(item => ({ id: item.id, status: 'supported', conclusion: '核对时间回退。', limit: '叙事顺序待确认。',
      evidence: item.sources.slice(0, 2).map(source => ({ id: source.id, quote: source.quote.trim() })) }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: results }) }, finish_reason: 'stop' }], usage: { total_tokens: 20 } });
  } });
  t.after(f.close);
  const w = f.workspace;
  await f.write(one, testFirst); await f.write(two, testSecond);
  await w.refresh(); await configure(w);
  await w.startBookReview();
  const report = await completed(w);
  const reportId = report.id, issueId = report.issues.find(row => row.category === 'timeline').id;
  async function retry() {
    await w.startBookSemanticReview({ reportId, itemIds: [issueId] });
    return settle();
  }
  async function settle() {
    for (let i = 0; i < 100; i++) {
      const run = await w.getBookSemanticReview({ reportId });
      if (!run.active) return run;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('语义复核未完成');
  }
  const original = await retry();
  assert.equal(original.items[0].status, 'candidate');
  const newChapter = testSecond.replace('七月廿七', '八月初一');
  await f.write(two, newChapter);
  const afterEdit = (await w.getBookSemanticReview({ reportId })).items[0];
  assert.equal(afterEdit.status, 'pending');
  assert.equal(afterEdit.verified.find(row => row.chapter === 2).versionState, 'changed');
  await f.write(two, testSecond);
  delay = Promise.withResolvers(); entered = Promise.withResolvers();
  await w.startBookSemanticReview({ reportId, itemIds: [issueId] });
  await entered.promise;
  try { await f.write(two, newChapter); } finally { delay.resolve(); }
  const changedDuringModel = await settle();
  assert.equal(changedDuringModel.items[0].status, 'pending');
  assert.equal(changedDuringModel.items[0].staleAtCompletion, true);
  assert.equal(changedDuringModel.items[0].verified.find(row => row.chapter === 2).versionState, 'changed');
  const oldQuote = changedDuringModel.items[0].verified.find(row => row.chapter === 2);
  const preview = await w.previewBookEvidence(oldQuote);
  assert.ok(preview.exact);
  assert.equal(preview.current, false);
  await f.write(two, testSecond);
  delay = undefined; entered = undefined;
  const recovered = await retry();
  assert.equal(recovered.items[0].status, 'candidate');
  fail = true;
  const failed = await retry();
  assert.equal(failed.items[0].status, 'failed');
  assert.match(failed.items[0].error, /429/u);
  assert.deepEqual(failed.items[0].previousCandidate.verified, recovered.items[0].verified);
  assert.equal(failed.items[0].previousCandidate.suggestion, recovered.items[0].suggestion);
  const reportPath = '_创作管理/全书核对/当前任务.json';
  const olderReport = JSON.parse(await f.read(reportPath));
  delete olderReport.scanVersion;
  await f.write(reportPath, JSON.stringify(olderReport));
  assert.equal((await w.getBookReview()).needsRescan, true);
  assert.equal((await w.getBookSemanticReview({ reportId })).id, failed.id);
  await assert.rejects(w.startBookSemanticReview({ reportId }), { code: 'CONFLICT' });
  await assert.rejects(w.decideBookReview({ reportId, issueId, action: 'confirm' }), { code: 'CONFLICT' });
  await w.startBookReview();
  const next = await completed(w);
  const history = await w.listBookSemanticHistory({ reportId: next.id });
  assert.deepEqual(new Set(history.entries.map(row => row.id)), new Set([original.id, changedDuringModel.id, recovered.id, failed.id]));
  const archived = await w.getBookSemanticReview({ reportId, runId: recovered.id });
  assert.equal(archived.active, false);
  assert.deepEqual(archived.items[0].verified, recovered.items[0].verified);
  assert.equal(archived.items[0].suggestion, recovered.items[0].suggestion);
  assert.deepEqual(await f.read(two), testSecond);
});
