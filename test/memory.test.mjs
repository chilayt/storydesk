import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../core/workspace.mjs';
import { selectMemories } from '../core/memory.mjs';
import { buildPrompt, validateExtraction } from '../core/analysis.mjs';
import { recordMarkdown } from '../core/catalog.mjs';
import { fixture, configure, confirmFirst, waitJob, chapterText } from './helpers.mjs';

const input = (extra = {}) => ({ title: '轻修订', topic: '修订尺度', content: '默认只轻度润色，不改变人物动机。', kind: 'preference', status: 'confirmed', origin: 'manual', authorConfirmed: true, tasks: ['revision'], scope: { kind: 'work' }, source: { reference: '作者明确要求', quote: '不要改变人物动机' }, ...extra });
const reviseFetch = capture => async (_url, req) => {
  const data = JSON.parse(req.body); capture?.(data);
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: [{ before: '七月廿三，阿青在渡口遇见沈舟。', after: '七月廿三，阿青来到渡口，迎面遇见沈舟。', reason: '保持相遇经过。' }], notes: [] }) } }], usage: { total_tokens: 100 } }), { status: 200 });
};
async function revision(w) { const d = w.documents.find(d => d.chapter === 1); const c = await w.checksFor({ documentId: d.id }); return w.generateRevision({ documentId: d.id, sourceHash: d.hash, checkId: c.id }); }

test('记忆真实落盘、版本保护与重启恢复；SQLite索引不是记忆权威', async () => {
  const f = await fixture('memory-durable'); let w = f.workspace;
  try {
    const m = await w.saveMemory(input()); assert.equal(m.revision, 1); assert.ok((await f.read(`_创作管理/记忆/${m.id}.md`)).includes('默认只轻度润色'));
    const n = await w.saveMemory({ ...m, content: '只润色语句；动机变化需单独讨论。', expectedHash: m._hash, expectedRevision: m.revision, authorConfirmed: true });
    assert.equal(n.revision, 2); await assert.rejects(w.saveMemory({ ...m, expectedHash: m._hash, expectedRevision: 1, authorConfirmed: true }), { code: 'CONFLICT' });
    await w.close(); await fs.unlink(path.join(f.root, '_创作管理/缓存/index.sqlite')); w = new Workspace(f.root); await w.init();
    assert.equal(w.memories[0].content, n.content); assert.equal(w.memories[0].revision, 2);
  } finally { await w.close(); }
});
test('候选、停用、过期、错作品与任务范围不符均不会发送给模型', async () => {
  const f = await fixture('memory-filter'), w = f.workspace;
  try {
    await assert.rejects(w.saveMemory(input({ authorConfirmed: false })), { code: 'VALIDATION' });
    await w.saveMemory(input({ status: 'candidate', origin: 'inferred' }));
    await w.saveMemory(input({ status: 'disabled', title: '旧偏好', topic: '旧偏好' }));
    await w.saveMemory(input({ title: '过期', topic: '过期', expiresAt: '2020-01-01T00:00:00.000Z' }));
    const active = await w.saveMemory(input({ title: '归档核对', topic: '归档核对', tasks: ['extraction'] }));
    const d = w.documents.find(d => d.chapter === 1), ctx = { task: 'revision', documentId: d.id, characterIds: [], chapter: 1 };
    const pack = selectMemories([...w.memories, { ...active, id: 'memory_foreign', work_id: 'other' }], w.project, ctx);
    assert.equal(pack.selected.length, 0); for (const reason of ['待作者核对', '已停用', '已到期', '不适用于此类任务', '不属于当前作品']) assert.ok(pack.excluded.some(m => m.reason === reason));
  } finally { await f.close(); }
});
test('人物、文档、章序和场景按具体范围筛选，场景修改后不沿用旧约定', async () => {
  const f = await fixture('memory-scope'), w = f.workspace;
  try {
    const d = w.documents.find(d => d.chapter === 1), other = w.documents.find(d => d.chapter === 2), aq = w.project.characters.find(c => c.name === '阿青'), lu = w.project.characters.find(c => c.name === '陆迟');
    const scene = await w.addScene({ documentId: d.id, name: '相遇', quote: '七月廿三，阿青在渡口遇见沈舟。' });
    await w.saveMemory(input({ title: '人物声口', topic: '声口', scope: { kind: 'character', characterIds: [aq.id], fromChapter: 1, toChapter: 1 } }));
    await w.saveMemory(input({ title: '未在场人物', topic: '旁人', scope: { kind: 'character', characterIds: [lu.id] } }));
    await w.saveMemory(input({ title: '场景临时', topic: '场景节奏', tasks: ['extraction'], scope: { kind: 'scene', documentId: d.id, sceneId: scene.id } }));
    assert.equal(w.memoryContext({ task: 'revision', documentId: d.id }).selected.length, 1);
    assert.equal(w.memoryContext({ task: 'revision', documentId: other.id }).selected.length, 0);
    assert.equal(w.memoryContext({ task: 'extraction', documentId: d.id, sceneId: scene.id }).selected.length, 1);
    await w.saveDocument({ documentId: d.id, expectedHash: d.hash, text: d.text + '\n新文字。\n' });
    assert.throws(() => w.memoryContext({ task: 'extraction', documentId: d.id, sceneId: scene.id }), { code: 'CONFLICT' });
  } finally { await f.close(); }
});
test('一次性约定仅请求尝试消耗，预览和未发出的任务不消耗', async () => {
  const f = await fixture('memory-once'), w = f.workspace;
  try {
    const m = await w.saveMemory(input({ lifetime: 'once' })), d = w.documents.find(d => d.chapter === 1), args = { taskId: 'synthetic', task: 'revision', documentId: d.id, sourceHash: d.hash };
    assert.equal(w.memoryContext(args).selected[0].id, m.id); assert.equal(w.memoryContext(args).selected.length, 1);
    const run = await w.beginMemoryRun(args); assert.equal(w.memoryContext(args).selected.length, 1);
    await w.noteMemoryRequest({ runId: run.id, start: 0, end: d.text.length });
    assert.equal(w.memoryContext(args).selected.length, 0); await w.assertMemoryRunCurrent(run.id);
    assert.ok(w.project.memoryRuns[0].requests[0].attempted_at);
  } finally { await f.close(); }
});
test('同主题相反规则须明确替代，旧条目和历史保留；章节范围可区分', async () => {
  const f = await fixture('memory-conflict'), w = f.workspace;
  try {
    const a = await w.saveMemory(input()); await assert.rejects(w.saveMemory(input({ content: '重新设计所有人物动机。' })), { code: 'MEMORY_CONFLICT' });
    const b = await w.saveMemory(input({ content: '仅本章可调整动机，但先列建议等待确认。', replacesId: a.id, replacesHash: a._hash }));
    assert.equal(w.memories.find(m => m.id === a.id).status, 'superseded'); assert.equal(b.supersedesId, a.id);
    await assert.rejects(w.setMemoryStatus({ id: a.id, expectedHash: a._hash, expectedRevision: 1, status: 'confirmed' }), { code: 'VALIDATION' });
    await w.saveMemory(input({ topic: '章节独立', scope: { kind: 'work', fromChapter: 1, toChapter: 2 } }));
    await w.saveMemory(input({ topic: '章节独立', content: '后期改用紧凑节奏。', scope: { kind: 'work', fromChapter: 3 } }));
  } finally { await f.close(); }
});
test('外改记忆暂停使用，版本冲突不能覆盖；作者核对采用后才重新可用', async () => {
  const f = await fixture('memory-external'), w = f.workspace;
  try {
    const m = await w.saveMemory(input()), p = `_创作管理/记忆/${m.id}.md`, d = w.documents.find(d => d.chapter === 1);
    await f.write(p, (await f.read(p)).replaceAll('默认只轻度润色，不改变人物动机。', '作者新的明确要求。'));
    await w.refresh(); assert.equal(w.memoryContext({ task: 'revision', documentId: d.id }).selected.length, 0);
    await assert.rejects(w.saveMemory({ ...m, expectedHash: m._hash, expectedRevision: 1, authorConfirmed: true }), { code: 'CONFLICT' });
    const diff = await w.managedDiff({ path: p }); await w.acknowledgeManaged({ path: p, expectedHash: diff.hash, mode: 'adopt' });
    assert.equal(w.memoryContext({ task: 'revision', documentId: d.id }).selected[0].content, '作者新的明确要求。');
  } finally { await f.close(); }
});
test('外部新增声称已确认的记忆不能自行启用；删除文件可从登记快照恢复', async () => {
  const f = await fixture('memory-forged'), w = f.workspace;
  try {
    const m = await w.saveMemory(input()), d = w.documents.find(d => d.chapter === 1);
    const forged = { ...m, id: 'memory_forged', topic: '伪造作者', title: '伪造作者', content: '根据置信度无证据写入。' }; delete forged._hash;
    await f.write('_创作管理/记忆/memory_forged.md', recordMarkdown(forged)); await w.refresh();
    assert.ok(w.memories.find(m => m.id === forged.id).unreviewedExternal); assert.equal(w.memoryContext({ task: 'revision', documentId: d.id }).selected.length, 1);
    const p = `_创作管理/记忆/${m.id}.md`; await fs.unlink(path.join(f.root, p)); await w.refresh();
    assert.equal(w.memoryContext({ task: 'revision', documentId: d.id }).selected.length, 0);
    await w.acknowledgeManaged({ path: p, expectedHash: null, mode: 'restore' }); assert.equal(w.memoryContext({ task: 'revision', documentId: d.id }).selected.length, 1);
  } finally { await f.close(); }
});
test('记忆输入预算显式列出遗漏项，不截断规则正文，整批输入不超过2万字符', async () => {
  const f = await fixture('memory-budget'), w = f.workspace;
  try {
    for (let i = 0; i < 5; i++) await w.saveMemory(input({ title: `偏好${i}`, topic: `偏好${i}`, content: '甲'.repeat(1500) }));
    const d = w.documents.find(d => d.chapter === 1), pack = w.memoryContext({ task: 'revision', documentId: d.id });
    assert.ok(pack.selected.length < 5); assert.ok(pack.chars <= 3600); assert.ok(pack.excluded.some(m => m.reason.includes('预算')));
    assert.ok(pack.selected.every(m => m.content.length === 1500));
    const messages = buildPrompt(d.text, w.project.characters, [], 'prose', pack.selected); assert.ok(messages.reduce((n, m) => n + m.content.length, 0) <= 20000);
  } finally { await f.close(); }
});
test('AI修订实际发送已确认记忆、保存当时版本，规则变更会阻止旧建议写入', async () => {
  const sent = [], f = await fixture('memory-revision', { fetcher: reviseFetch(x => sent.push(x)) }), w = f.workspace;
  try {
    await configure(w); const m = await w.saveMemory(input()); await w.saveMemory(input({ title: '不要发送', topic: '候选', status: 'candidate' }));
    const p = await revision(w), body = JSON.parse(sent[0].messages[1].content); assert.equal(body.authorMemory.length, 1); assert.equal(body.authorMemory[0].id, m.id);
    const run = w.project.memoryRuns.find(r => r.id === p.memoryRunId); assert.equal(run.status, 'completed'); assert.equal(run.selected[0].revision, 1); assert.equal(run.requests.length, 1); assert.equal(await f.read(w.documents.find(d => d.chapter === 1).path), chapterText);
    await w.setMemoryStatus({ id: m.id, expectedHash: m._hash, expectedRevision: 1, status: 'disabled' });
    await assert.rejects(w.applyRevision({ id: p.id, proposalHash: p.proposalHash, sourceHash: p.sourceHash, edits: p.edits.map(e => ({ id: e.id, after: e.after })) }), { code: 'CONFLICT' });
    assert.equal(run.selected[0].content, m.content);
  } finally { await f.close(); }
});
test('剧情归档读取归档范围记忆；记忆不能让伪造证据自动入档', async () => {
  let body;
  const f = await fixture('memory-extraction', { fetcher: async (_url, req) => {
    body = JSON.parse(JSON.parse(req.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ events: [{ title: '无依据', facts: [{ entity_id: body.characters[0].id, field: 'location', value: '帝都', layer: 'occurred', certainty: 'explicit', evidence: '阿青已经登上帝位。' }] }] }) } }], usage: { total_tokens: 100 } }), { status: 200 });
  } }), w = f.workspace;
  try {
    await configure(w); const m = await w.saveMemory(input({ tasks: ['extraction'], content: '优先核对地点变化；缺少原文不能补写。' }));
    const created = await confirmFirst(w), j = await waitJob(w, created.job.id); assert.equal(body.authorMemory[0].id, m.id); assert.equal(j.applied, 0); assert.equal(j.pending, 1);
    assert.equal(w.project.memoryRuns.find(r => r.taskId === j.id).status, 'partial');
  } finally { await f.close(); }
});
test('手动改写保留AI原建议，纠错案例默认候选，不自动形成全作品规则', async () => {
  const f = await fixture('memory-correction', { fetcher: reviseFetch() }), w = f.workspace;
  try {
    await configure(w); const p = await revision(w), e = p.edits[0], authorText = '七月廿三，阿青走到渡口，与沈舟打了个照面。';
    const saved = await w.saveRevisionDraft({ id: p.id, proposalHash: p.proposalHash, edits: [{ id: e.id, after: authorText, selected: true }] });
    assert.equal(saved.edits[0].suggested_after, e.after); assert.equal(saved.edits[0].after, authorText);
    const m = await w.saveMemory(input({ kind: 'correction', status: 'candidate', origin: 'revision', scope: { kind: 'document', documentId: p.documentId }, example: { before: e.before, suggested: e.after, after: authorText } }));
    assert.equal(m.status, 'candidate'); assert.equal(w.memoryContext({ task: 'revision', documentId: p.documentId }).selected.length, 0);
  } finally { await f.close(); }
});
test('撤销记忆变更不覆盖后续人工修改；不同作品不共享记忆', async () => {
  const f = await fixture('memory-undo'), other = await fixture('memory-other'), w = f.workspace;
  try {
    const m = await w.saveMemory(input()), first = (await w.store.history()).find(h => h.label === '作者新增记忆与规则');
    assert.equal(other.workspace.memories.length, 0);
    await w.saveMemory({ ...m, content: '作者后来的改法。', expectedHash: m._hash, expectedRevision: 1, authorConfirmed: true });
    await assert.rejects(w.undoBatch(first.id), { code: 'CONFLICT' });
    assert.equal(w.memories[0].content, '作者后来的改法。');
  } finally { await f.close(); await other.close(); }
});
test('一次性约定释放预算不会误判旧建议失效；新适用规则加入则需重做', async () => {
  const f = await fixture('memory-once-budget'), w = f.workspace;
  try {
    await w.saveMemory(input({ title: '一次性', topic: '一次性', kind: 'principle', lifetime: 'once', content: '甲'.repeat(1500) }));
    for (let i = 0; i < 3; i++) await w.saveMemory(input({ title: `偏好${i}`, topic: `偏好${i}`, content: '乙'.repeat(1400) }));
    const d = w.documents.find(d => d.chapter === 1), run = await w.beginMemoryRun({ taskId: 'test', task: 'revision', documentId: d.id, sourceHash: d.hash });
    await w.noteMemoryRequest({ runId: run.id, start: 0, end: d.text.length }); await w.assertMemoryRunCurrent(run.id);
    await w.saveMemory(input({ title: '新增重要原则', topic: '新增重要原则', kind: 'principle', content: '新任务约定改变了修订依据。' }));
    await assert.rejects(w.assertMemoryRunCurrent(run.id), { code: 'CONFLICT' });
  } finally { await f.close(); }
});
test('请求服务失败保留真实尝试和一次性消耗，未配置服务不冒充已发送', async () => {
  const f = await fixture('memory-network', { fetcher: async () => new Response('{}', { status: 401 }) }), w = f.workspace;
  try {
    await configure(w); const m = await w.saveMemory(input({ lifetime: 'once' }));
    await assert.rejects(revision(w), { code: 'AI_HTTP' });
    assert.equal(w.project.memoryRuns[0].requests.length, 1); assert.equal(w.project.memoryRuns[0].status, 'failed');
    assert.equal(w.summary().memories.find(r => r.id === m.id).consumedBy, w.project.memoryRuns[0].id);
    const { requestStructured } = await import('../core/analysis.mjs'); let calls = 0;
    await assert.rejects(requestStructured({ model: '', baseUrl: '' }, '', [], { beforeRequest: () => { calls++; } }), { code: 'AI_CONFIG' });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});
