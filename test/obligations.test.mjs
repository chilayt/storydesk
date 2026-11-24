import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../core/workspace.mjs';
import { recordMarkdown } from '../core/catalog.mjs';
import { validateObligationResponse, mechanicalObligations, obligationCoverage } from '../core/obligations.mjs';
import { fixture, configure, chapterText } from './helpers.mjs';
const item = (extra = {}) => ({ title: '交代功法册流转', description: '交代阿青把功法册交给沈舟，拿到不等于练成。', category: 'item', method: 'semantic', severity: 'required', ...extra });
async function card(w, items = [item()], extra = {}) { return w.saveObligationCard({ documentId: w.documents.find(d => d.chapter === 1).id, title: '渡口分场义务', status: 'confirmed', authorConfirmed: true, source: '作者已确认的测试分场单', goal: '交代相遇与传书', items, ...extra }); }
async function check(w, c, useAI = false, reportId = null) { return w.checkObligations({ cardId: c.id, sourceHash: w.doc(c.documentId).hash, useAI, reportId }); }
const model = fn => async (_url, req) => {
  const body = JSON.parse(req.body), data = JSON.parse(body.messages[1].content);
  const results = fn ? await fn(data, body) : data.obligations.map(i => ({ obligation_id: i.obligation_id, verdict: 'satisfied', reason: '本段明确发生了交付。', evidence: [{ quote: '阿青把《听潮诀》交给沈舟。' }] }));
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }], usage: { total_tokens: 100 } }), { status: 200 });
};

test('义务卡分草稿与确认，真实落盘和重启；不确认剧情或改写正文', async () => {
  const f = await fixture('ob-card'); let w = f.workspace;
  try {
    const c = await card(w, [item()], { status: 'draft' }); assert.equal(w.project.approvals.length, 0); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, true);
    await assert.rejects(w.saveObligationCard({ ...c, status: 'confirmed', expectedHash: c._hash, expectedRevision: c.revision, authorConfirmed: false }), { code: 'VALIDATION' });
    const next = await w.saveObligationCard({ ...c, status: 'confirmed', expectedHash: c._hash, expectedRevision: c.revision, authorConfirmed: true }); assert.equal(next.revision, 2);
    assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false); assert.ok((await f.read(`_创作管理/场景义务/${c.id}.md`)).includes('交代功法册流转'));
    assert.equal(await f.read(w.doc(c.documentId).path), chapterText);
    await w.close(); w = new Workspace(f.root); await w.init(); assert.equal(w.obligationCards[0].id, c.id); assert.equal(w.obligationCards[0].status, 'confirmed');
  } finally { await w.close(); }
});
test('机检按连续词句、别名和指定范围核对，不把提及当正面出场或执行正则', () => {
  const characters = [{ id: 'char_a', name: '周庭远', aliases: ['庭远'] }], text = '章外有印信。\n有人说：“庭远昨日来过。”\n';
  const rows = mechanicalObligations([item({ id: 'a', method: 'character_mention', characterIds: ['char_a'], terms: [] }), item({ id: 'b', method: 'required_text', terms: ['印信'], characterIds: [] }), item({ id: 'c', method: 'forbidden_text', terms: ['.*'], characterIds: [] })], text, text.indexOf('有人'), text.length, characters);
  assert.equal(rows[0].verdict, 'satisfied'); assert.ok(rows[0].reason.includes('不代表正面出场')); assert.equal(rows[1].verdict, 'unsatisfied'); assert.equal(rows[2].verdict, 'satisfied');
});
test('机检满足可离线确认成稿，必需失败阻断，提醒项不升级硬线', async () => {
  const f = await fixture('ob-machine'), w = f.workspace;
  try {
    const c = await card(w, [item({ method: 'required_text', terms: ['阿青', '听潮诀'] }), item({ title: '仅提醒', method: 'required_text', terms: ['不存在'], severity: 'reminder' })]);
    const r = await check(w, c); assert.equal(r.mechanical.length, 2); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, true);
    const d = w.doc(c.documentId); await w.checksFor({ documentId: d.id }); const created = await w.confirmRevision({ documentId: d.id, sourceHash: d.hash });
    assert.equal(created.job.status, 'waiting_config'); assert.equal(created.approval.obligationChecks[0].cardHash, c._hash); assert.equal(created.approval.obligationChecks[0].reportHash, r._hash);
  } finally { await f.close(); }
});
test('不满足的机检不能被直接确认满足；本版放宽留理由，改稿即失效', async () => {
  const f = await fixture('ob-waive'), w = f.workspace;
  try {
    const c = await card(w, [item({ method: 'required_text', terms: ['印信'] })]), r = await check(w, c), d = w.doc(c.documentId);
    await w.checksFor({ documentId: d.id }); await assert.rejects(w.confirmRevision({ documentId: d.id, sourceHash: d.hash }), { code: 'OBLIGATION_REVIEW' });
    await assert.rejects(w.reviewObligation({ reportId: r.id, expectedHash: r._hash, itemId: c.items[0].id, decision: 'satisfied', reason: '声称满足' }), { code: 'VALIDATION' });
    const reviewed = await w.reviewObligation({ reportId: r.id, expectedHash: r._hash, itemId: c.items[0].id, decision: 'waive', reason: '本章只传书，印信留待下一场。' });
    assert.equal(reviewed.results[0].resolved, true); assert.equal((await w.obligationGate({ documentId: d.id })).passed, true);
    await w.saveDocument({ documentId: d.id, expectedHash: d.hash, text: d.text + '\n阿青望向河岸。\n' });
    assert.equal((await w.getObligationReport({ id: r.id })).stale, true); assert.equal((await w.obligationGate({ documentId: d.id })).passed, false);
  } finally { await f.close(); }
});
test('AI初核有据仍需作者接受，精确调用记忆；接受后不自动生成剧情事实', async () => {
  let sent; const f = await fixture('ob-ai', { fetcher: model((data, body) => { sent = { data, body }; return data.obligations.map(i => ({ obligation_id: i.obligation_id, verdict: 'satisfied', evidence_span_ids: [data.source.split('\n').find(s => s.includes('阿青把《听潮诀》')).match(/^\[(p\d+)\]/)[1]] })); }) }), w = f.workspace;
  try {
    await configure(w); const m = await w.saveMemory({ title: '核对依据', topic: '核对依据', content: '只根据本场原文核对。', status: 'confirmed', authorConfirmed: true, tasks: ['obligation'], scope: { kind: 'work' }, source: { reference: '作者明确要求' } });
    const c = await card(w), r = await check(w, c, true); assert.equal(r.coverage.complete, true); assert.equal(r.results[0].verdict, 'satisfied'); assert.equal(r.results[0].resolved, false);
    assert.equal(sent.data.authorMemory[0].id, m.id); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false);
    const accepted = await w.acceptObligationEvidence({ reportId: r.id, expectedHash: r._hash }); assert.equal(accepted.results[0].resolved, true); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, true);
    assert.equal(w.events.length, 0); assert.equal(w.project.approvals.length, 0); assert.equal(await f.read(w.doc(c.documentId).path), chapterText);
  } finally { await f.close(); }
});
test('模型漏项、重复或未知ID不能假绿，完整性由程序而不是AI宣称决定', () => {
  const raw = [{ obligation_id: 'a', verdict: 'not_found' }, { obligation_id: 'a', verdict: 'satisfied', quote: '原句。' }, { obligation_id: 'invented', verdict: 'satisfied', quote: '原句。' }];
  const checked = validateObligationResponse(raw, ['a', 'b'], '原句。', 0, 3); assert.equal(checked.complete, false); assert.deepEqual(checked.missing, ['b']); assert.equal(checked.errors.length, 2);
});
test('伪造、拼接或范围外证据转待作者判断，不允许批量直接接受', async () => {
  const f = await fixture('ob-evidence', { fetcher: model(data => data.obligations.map(i => ({ obligation_id: i.obligation_id, verdict: 'satisfied', quote: '阿青到了北城。' }))) }), w = f.workspace;
  try {
    await configure(w); const c = await card(w), r = await check(w, c, true); assert.equal(r.results[0].verdict, 'needs_author'); assert.equal(r.results[0].evidence.length, 0); assert.ok(r.results[0].evidenceIssues.length);
    await assert.rejects(w.acceptObligationEvidence({ reportId: r.id, expectedHash: r._hash }), { code: 'VALIDATION' });
    await assert.rejects(w.reviewObligation({ reportId: r.id, expectedHash: r._hash, itemId: c.items[0].id, decision: 'satisfied', reason: '错引', evidenceQuote: '阿青到了北城。' }), { code: 'EVIDENCE' });
    const done = await w.reviewObligation({ reportId: r.id, expectedHash: r._hash, itemId: c.items[0].id, decision: 'satisfied', reason: '核对本场实际交付经过。', evidenceQuote: '阿青把《听潮诀》交给沈舟。' }); assert.equal(done.results[0].resolved, true);
  } finally { await f.close(); }
});
test('长稿逐项逐段覆盖，重试只请求未完整分段，多个分段结果均能持久化', async () => {
  let requests = 0;
  const f = await fixture('ob-coverage', { fetcher: model(data => { requests++; return requests === 2 ? [] : data.obligations.map(i => ({ obligation_id: i.obligation_id, verdict: 'not_found', reason: '本段未见。' })); }) }), w = f.workspace;
  try {
    await configure(w); const d = w.documents.find(d => d.chapter === 1); await w.saveDocument({ documentId: d.id, expectedHash: d.hash, text: '第一段甲。'.repeat(2100) });
    const c = await card(w), r = await check(w, c, true); assert.ok(r.parts.length >= 3); assert.equal(r.parts.filter(p => p.status === 'done').length, r.parts.length - 1); assert.equal(r.coverage.complete, false);
    const before = requests, completed = r.parts.filter(p => p.status === 'done').map(p => p.id), next = await check(w, c, true, r.id);
    assert.equal(requests, before + 1); assert.equal(next.coverage.complete, true); assert.ok(completed.every(id => next.parts.find(p => p.id === id).status === 'done')); assert.equal(next.usage.total_tokens, requests * 100);
  } finally { await f.close(); }
});
test('断网可人工逐项核对，AI覆盖不足明确保留；作者撤回后恢复待核对', async () => {
  const f = await fixture('ob-offline'), w = f.workspace;
  try {
    const c = await card(w), r = await check(w, c); assert.equal(r.coverage.complete, false); assert.equal(r.status, 'incomplete');
    const a = await w.reviewObligation({ reportId: r.id, expectedHash: r._hash, itemId: c.items[0].id, decision: 'satisfied', reason: '已人工通读本场。', evidenceQuote: '阿青把《听潮诀》交给沈舟。' });
    assert.equal(a.coverage.complete, false); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, true);
    const b = await w.reviewObligation({ reportId: a.id, expectedHash: a._hash, itemId: c.items[0].id, decision: 'pending', reason: '仍需核对是否交代转交原因。' });
    assert.equal(b.reviews.length, 2); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false);
  } finally { await f.close(); }
});
test('卡片变更或参考人物原档外改会使已有核对失效', async () => {
  const f = await fixture('ob-context'), w = f.workspace;
  try {
    const aq=w.project.characters.find(c=>c.name==='阿青'),source=w.doc(aq.primarySourceId);await w.approveBaseline({characterId:aq.id,fields:[{field:'性格',value:'谨慎，重承诺。',evidence:'谨慎，重承诺。'}],expectedSourceHash:source.hash});
    const c = await card(w, [item({ method: 'required_text', terms: ['阿青'] })]), r = await check(w, c); assert.equal(r.stale, false);
    await f.write('01-人物/人物分档/阿青.md', '# 阿青\n\n作者刚修改了身份说明。\n');
    assert.equal((await w.getObligationReport({ id: r.id })).stale, true);
    await w.refresh(); const c2 = await w.saveObligationCard({ ...c, title: '新的分场要求', expectedHash: c._hash, expectedRevision: c.revision, authorConfirmed: true });
    assert.equal(c2.revision, 2); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false);
  } finally { await f.close(); }
});
test('外改、删除或破坏正式义务卡不会绕过成稿核对；外部报告不能自称已通过', async () => {
  const f = await fixture('ob-external'), w = f.workspace;
  try {
    const c = await card(w, [item({ method: 'required_text', terms: ['不存在'] })]), r = await check(w, c), p = `_创作管理/场景义务/${c.id}.md`;
    await f.write(p, '损坏内容'); await w.refresh(); assert.equal(w.obligationCards[0].documentId, c.documentId); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false);
    let diff = await w.managedDiff({ path: p }); await w.acknowledgeManaged({ path: p, expectedHash: diff.hash, mode: 'restore' });
    await fs.unlink(path.join(f.root, p)); await w.refresh(); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false); await w.acknowledgeManaged({ path: p, expectedHash: null, mode: 'restore' });
    const rp = `_创作管理/义务核对/${r.id}.md`; await f.write(rp, (await f.read(rp)).replaceAll('unsatisfied', 'satisfied')); await w.refresh(); diff = await w.managedDiff({ path: rp });
    await assert.rejects(w.acknowledgeManaged({ path: rp, expectedHash: diff.hash, mode: 'adopt' }), { code: 'VALIDATION' }); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false);
  } finally { await f.close(); }
});
test('外部新增自称正式的义务卡仅作待核对，不自动施加或绕过作者要求', async () => {
  const f = await fixture('ob-forged'), w = f.workspace;
  try {
    const c = await card(w), forged = { ...c, id: 'obcard_forged' }; delete forged._hash;
    await f.write('_创作管理/场景义务/obcard_forged.md', recordMarkdown(forged)); await w.refresh(); const g = await w.obligationGate({ documentId: c.documentId }); assert.equal(g.cards.length, 1); assert.equal(g.drafts.length, 1); assert.equal(w.obligationCards.find(c => c.id === forged.id).unreviewedExternal, true);
  } finally { await f.close(); }
});
test('单场核对证据不越界，整章确认须覆盖所有已启用场景卡，改稿后重新定位', async () => {
  const f = await fixture('ob-scene'), w = f.workspace;
  try {
    const d = w.documents.find(d => d.chapter === 1), s1 = await w.addScene({ documentId: d.id, name: '相遇', quote: '七月廿三，阿青在渡口遇见沈舟。' }), s2 = await w.addScene({ documentId: d.id, name: '传书', quote: '阿青把《听潮诀》交给沈舟。沈舟开始试练第一层。' });
    const a = await card(w, [item({ method: 'required_text', terms: ['阿青'] })], { sceneId: s1.id }), b = await card(w, [item()], { title: '传书', sceneId: s2.id });
    const r = await check(w, a); assert.equal((await w.obligationGate({ documentId: d.id, sceneId: s1.id })).passed, true); assert.equal((await w.obligationGate({ documentId: d.id })).passed, false);
    const rb = await check(w, b); await assert.rejects(w.reviewObligation({ reportId: rb.id, expectedHash: rb._hash, itemId: b.items[0].id, decision: 'satisfied', reason: '错误跨场引用', evidenceQuote: '七月廿三，阿青在渡口遇见沈舟。' }), { code: 'EVIDENCE' });
    const spans = await w.obligationEvidence({ reportId: rb.id }); assert.ok(spans.spans.every(s => s.start >= s2.start && s.end <= s2.end)); assert.equal(r.start, s1.start);
    await w.saveDocument({ documentId: d.id, expectedHash: d.hash, text: d.text + '\n场景之外的新句。' }); await assert.rejects(check(w, a), { code: 'SCENE' });
  } finally { await f.close(); }
});
test('报告核对后原文被外部修改仍保留旧依据，不能作为新版确认凭据', async () => {
  let f; f = await fixture('ob-source-change', { fetcher: model(async data => { await f.write(f.workspace.documents.find(d => d.chapter === 1).path, chapterText + '\n外部修改。'); return data.obligations.map(i => ({ obligation_id: i.obligation_id, verdict: 'satisfied', quote: '阿青把《听潮诀》交给沈舟。' })); }) });
  try { await configure(f.workspace); const c = await card(f.workspace), r = await check(f.workspace, c, true); assert.equal(r.stale, true); assert.equal((await f.workspace.obligationGate({ documentId: c.documentId })).passed, false); }
  finally { await f.close(); }
});
test('报告版本冲突阻止覆盖后续作者裁定；删除SQLite仍从本地文件重建', async () => {
  const f = await fixture('ob-version'); let w = f.workspace;
  try {
    const c = await card(w), r = await check(w, c), args = { reportId: r.id, expectedHash: r._hash, itemId: c.items[0].id, decision: 'waive', reason: '本版省略，已作者裁定。' };
    await w.reviewObligation(args); await assert.rejects(w.reviewObligation(args), { code: 'CONFLICT' });
    await w.close(); await fs.unlink(path.join(f.root, '_创作管理/缓存/index.sqlite')); w = new Workspace(f.root); await w.init(); const current = await w.getObligationReport({ id: r.id }); assert.equal(current.results[0].review.reason, args.reason);
  } finally { await w.close(); }
});
test('本场上下文包不调用模型、不带整库；AI修订携带已确认义务，卡变更后不能应用旧建议', async () => {
  let body; const f = await fixture('ob-revision', { fetcher: async (_url, req) => { body = JSON.parse(JSON.parse(req.body).messages[1].content); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: [{ before: '阿青说：“明日去北城。”', after: '阿青说道：“明日去北城。”' }], notes: [] }) } }], usage: { total_tokens: 100 } }), { status: 200 }); } }), w = f.workspace;
  try {
    await configure(w); const c = await card(w), pack = await w.obligationContext({ cardId: c.id }); assert.ok(pack.text.includes(c.items[0].title)); assert.ok(pack.text.length <= 20000); assert.equal(body, undefined);
    const d = w.doc(c.documentId), gate = await w.checksFor({ documentId: d.id }), proposal = await w.generateRevision({ documentId: d.id, sourceHash: d.hash, checkId: gate.id }); assert.equal(body.sceneObligations[0].id, c.id);
    await w.saveObligationCard({ ...c, goal: '更新本场目标', expectedHash: c._hash, expectedRevision: c.revision, authorConfirmed: true });
    await assert.rejects(w.applyRevision({ id: proposal.id, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, edits: proposal.edits.map(e => ({ id: e.id, after: e.after })) }), { code: 'CONFLICT' });
  } finally { await f.close(); }
});
test('义务放宽不能绕过原门禁中的稿件损坏硬线；作品之间隔离', async () => {
  const f = await fixture('ob-original-gate'), other = await fixture('ob-isolation'), w = f.workspace;
  try {
    const c = await card(w, [item({ method: 'required_text', terms: ['阿青'] })]), d = w.doc(c.documentId); await w.saveDocument({ documentId: d.id, expectedHash: d.hash, text: chapterText + '\n阿青说："直引号。"\n' }); await check(w, c);
    const current = w.doc(d.id); await w.checksFor({ documentId: d.id }); await assert.rejects(w.confirmRevision({ documentId: d.id, sourceHash: current.hash }), { code: 'NEEDS_GATE' }); assert.equal(other.workspace.obligationCards.length, 0);
  } finally { await f.close(); await other.close(); }
});
test('预算不足不发送稿件，分组覆盖全清单，不把未检查部分算通过', async () => {
  let calls = 0; const f = await fixture('ob-budget', { fetcher: model(data => { calls++; return data.obligations.map(i => ({ obligation_id: i.obligation_id, verdict: 'not_found' })); }) }), w = f.workspace;
  try {
    await configure(w); const c = await card(w, Array.from({ length: 7 }, (_, i) => item({ title: `待交代事项${i + 1}` })));
    await w.updateSettings({ ai: { ...w.project.settings.ai,maxTokensPerJob: 1000 } }); const r = await check(w, c, true); assert.equal(calls, 0); assert.equal(r.status, 'incomplete'); assert.equal(r.coverage.expected, 7); assert.equal(r.coverage.checked, 0); assert.equal(r.errorCode, 'BUDGET');
    await w.updateSettings({ ai: { ...w.project.settings.ai,maxTokensPerJob: 120000 } }); const next = await check(w, c, true, r.id); assert.equal(calls, 2); assert.equal(next.coverage.checked, 7); assert.equal(next.error, null); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false);
  } finally { await f.close(); }
});
test('输出截断后拆小义务组，保留失败用量和逐项覆盖，避免残缺结果假绿', async () => {
  let calls = 0; const f = await fixture('ob-truncated', { fetcher: async (_url, req) => {
    calls++; if (calls === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{' } }], usage: { total_tokens: 50 } }), { status: 200 });
    const d = JSON.parse(JSON.parse(req.body).messages[1].content); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: d.obligations.map(i => ({ obligation_id: i.obligation_id, verdict: 'not_found' })) }) } }], usage: { total_tokens: 100 } }), { status: 200 });
  } }), w = f.workspace;
  try { await configure(w); const c = await card(w, [item(), item({ title: '交代认识经过' })]), r = await check(w, c, true); assert.equal(calls, 3); assert.equal(r.adaptiveSplits, 1); assert.equal(r.coverage.complete, true); assert.equal(r.coverage.checked, 2); assert.equal(r.usage.total_tokens, 250); assert.equal(w.project.aiAssistanceUsage.reduce((n, l) => n + l.usage.total_tokens, 0), 250); }
  finally { await f.close(); }
});
test('作者可取消核对，已保存机检仍在；未返回的语义项保持未完成', async () => {
  let requestStarted; const started = new Promise(r => { requestStarted = r; });
  const f = await fixture('ob-cancel', { fetcher: async (_url, req) => { requestStarted(); return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } }), w = f.workspace;
  try {
    await configure(w); const c = await card(w, [item(), item({ title: '姓名提及', method: 'required_text', terms: ['阿青'] })]); const running = check(w, c, true); await started;
    const id = w.obligationChecks[0].id; await w.cancelObligationCheck({ id }); const r = await running;
    assert.equal(r.status, 'cancelled'); assert.equal(r.coverage.complete, false); assert.equal(r.mechanical[0].verdict, 'satisfied'); assert.equal(w.controllers.size, 0); assert.equal((await w.obligationGate({ documentId: c.documentId })).passed, false);
  } finally { await f.close(); }
});
test('核对语义不能借邻场证据通过，前文变动也会使承接参考失效', async () => {
  const f = await fixture('ob-neighbor'), w = f.workspace;
  try {
    const d = w.documents.find(d => d.chapter === 2), c = await card(w, [item()], { documentId: d.id }); const p = await w.obligationContext({ cardId: c.id }); assert.ok(p.text.includes('明日去北城'));
    const r = await check(w, c); await assert.rejects(w.reviewObligation({ reportId: r.id, expectedHash: r._hash, itemId: c.items[0].id, decision: 'satisfied', reason: '引用前章', evidenceQuote: '阿青把《听潮诀》交给沈舟。' }), { code: 'EVIDENCE' });
    const first = w.documents.find(d => d.chapter === 1); await f.write(first.path, chapterText + '\n前文已修改。'); assert.equal((await w.getObligationReport({ id: r.id })).stale, true);
  } finally { await f.close(); }
});
test('全为提醒的义务卡不会在未核对时形成隐含硬线', async () => {
  const f=await fixture('ob-reminders'),w=f.workspace;
  try{const c=await card(w,[item({severity:'reminder'})]);const g=await w.obligationGate({documentId:c.documentId});assert.equal(g.passed,true);assert.equal(g.cards[0].required,false);assert.ok(g.cards[0].reason.includes('仅提醒'));}
  finally{await f.close();}
});
test('单卡记忆预览与实际任务一致，包括约定提及但正文遗漏的人物', async () => {
  const f=await fixture('ob-memory-scope',{fetcher:model()}),w=f.workspace;
  try{
    await configure(w);const lu=w.project.characters.find(c=>c.name==='陆迟');await w.saveMemory({title:'陆迟的声口',content:'提及陆迟时先核对身份，不虚构他的行动。',status:'confirmed',authorConfirmed:true,tasks:['obligation'],scope:{kind:'character',characterIds:[lu.id]},source:{reference:'作者明确要求'}});
    const c=await card(w,[item(),item({title:'提醒提及陆迟',method:'character_mention',characterIds:[lu.id],severity:'reminder'})]);const p=w.memoryContext({task:'obligation',documentId:c.documentId,cardId:c.id});assert.equal(p.selected.length,1);
    const r=await check(w,c,true),run=w.project.memoryRuns.find(x=>x.id===r.memoryRunId);assert.deepEqual(run.selected.map(m=>m.id),p.selected.map(m=>m.id));assert.equal(r.stale,false);
  }finally{await f.close();}
});
test('只追加个人进展不使已参考的基座凭空失效，基座本身改动仍需重查', async () => {
  const f=await fixture('ob-baseline-scope'),w=f.workspace;
  try{
    const aq=w.project.characters.find(c=>c.name==='阿青'),d=w.doc(aq.primarySourceId);await w.approveBaseline({characterId:aq.id,fields:[{field:'性格',value:'谨慎，重承诺。',evidence:'谨慎，重承诺。'}],expectedSourceHash:d.hash});
    const c=await card(w,[item({method:'required_text',terms:['阿青']})]),r=await check(w,c),current=w.doc(d.id);
    await w.saveDocument({documentId:d.id,expectedHash:current.hash,text:current.text+'\n## 新的个人进展\n\n本章确认后追加进展，基座没有改变。\n'});assert.equal((await w.getObligationReport({id:r.id})).stale,false);
  }finally{await f.close();}
});
test('人物合并后，原身份上的记忆跟随同一人物而不丢失',async()=>{
  const f=await fixture('ob-identity-memory'),w=f.workspace;
  try{
    const source=await w.addCharacter({name:'小青旧称'}),target=w.project.characters.find(c=>c.name==='阿青');await w.saveMemory({title:'人物声口',content:'保持这个人物一贯谨慎的声口。',status:'confirmed',authorConfirmed:true,tasks:['obligation'],scope:{kind:'character',characterIds:[source.id]},source:{reference:'作者已确认的旧人物称呼'}});
    await w.mergeCharacters({sourceId:source.id,targetId:target.id});const c=await card(w);assert.equal(w.memoryContext({task:'obligation',documentId:c.documentId,cardId:c.id}).selected.length,1);
  }finally{await f.close();}
});
