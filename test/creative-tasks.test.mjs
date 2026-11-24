import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../core/workspace.mjs';
import { fixture, configure } from './helpers.mjs';

function answer({ tool, args, text = '已按要求准备。' }) {
  return Response.json({ choices: [{ message: { role: 'assistant', content: tool ? null : text,
    ...(tool ? { tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : {}) },
    finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { total_tokens: 100 } });
}
const chapterTwo = workspace => workspace.documents.find(d => d.kind === 'chapter' && d.chapter === 2);
const promptFor = body => { const content = body.messages.findLast(m => m.role === 'user').content;
  return JSON.parse(typeof content === 'string' ? content : content.map(p => p.text || '').join('')); };

test('creative tasks survive restart, retain author notes and remain isolated by work and target', async t => {
  const f = await fixture('creative-persist'), other = await fixture('creative-isolation');
  t.after(() => other.close());
  const first = await f.workspace.createCreativeTask({ kind: 'next', documentId: 'outline_chapter_3', goal: '先定冲突，暂不写正文。' });
  const saved = await f.workspace.saveCreativeTask({ id: first.id, expectedHash: first.taskHash, notes: '未定：章末是否交出书册？', title: '第三章构思' });
  await assert.rejects(f.workspace.saveCreativeTask({ id: first.id, expectedHash: first.taskHash, notes: '旧页面覆盖' }), e => e.code === 'CONFLICT');
  await assert.rejects(other.workspace.getCreativeTask({ id: first.id }), e => e.code === 'NOT_FOUND');
  await assert.rejects(f.workspace.getCowriting({ documentId: 'outline_chapter_4', taskId: first.id }), e => e.code === 'CONFLICT');
  await f.close();
  const reopened = new Workspace(f.root); await reopened.init(); t.after(() => reopened.close());
  const restored = await reopened.getCreativeTask({ id: first.id });
  assert.equal(restored.notes, saved.notes); assert.equal(restored.goal, first.goal);
  assert.equal((await reopened.listCreativeTasks())[0].title, '第三章构思');
  const archived = await reopened.saveCreativeTask({ id: restored.id, expectedHash: restored.taskHash, status: 'archived' });
  assert.equal((await reopened.getCowriting({ documentId: archived.documentId, taskId: archived.id })).messages.length, 0);
});

test('manifest shows actual excerpts and pinned sources, detects later edits and keeps different tasks out of each other', async t => {
  const requests = [];
  const f = await fixture('creative-context', { fetcher: async (_url, request) => {
    requests.push(JSON.parse(request.body)); return answer({ text: '这轮只讨论结构。' });
  } }); t.after(() => f.close()); await configure(f.workspace);
  const doc = chapterTwo(f.workspace), setting = f.workspace.documents.find(d => d.kind === 'setting');
  let task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id, sceneId: 'whole', goal: '检查开场' });
  task = await f.workspace.saveCreativeTask({ id: task.id, expectedHash: task.taskHash, referenceIds: [setting.id] });
  const input = { documentId: doc.id, sceneId: 'whole', taskId: task.id, message: '先讨论阿青的行动。' };
  const preview = await f.workspace.getWritingContext(input);
  assert.ok(preview.sections.some(s => s.path === setting.path && s.excerpt.includes('不改变容貌')));
  const result = await f.workspace.sendCowriting({ ...input, sourceHash: doc.hash, expectedContextSignature: preview.signature });
  assert.equal(result.status, 'completed', result.error);
  const prompt = promptFor(requests[0]);
  assert.equal(prompt.activeSource.task.goal, '检查开场');
  assert.match(prompt.activeSource.task.references[0].excerpt, /不改变容貌/);
  assert.equal((await f.workspace.getCowriting(input)).manifest.stale, false);
  await f.write(setting.path, '# 听潮诀\n\n作者刚刚修订原理。\n');
  assert.equal((await f.workspace.getCowriting(input)).manifest.stale, true);
  const second = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id, sceneId: 'whole', goal: '另一种安排' });
  assert.equal((await f.workspace.getCowriting({ documentId: doc.id, sceneId: 'whole', taskId: second.id })).messages.length, 0);
});

test('several comments are anchored by the program, manually editable, and cannot change unselected prose', async t => {
  const f = await fixture('creative-annotations', { fetcher: async (_url, request) => {
    const prompt = promptFor(JSON.parse(request.body));
    return answer({ tool: 'submit_annotations', args: { edits: prompt.activeSource.authorAnnotations.map((a, i) =>
      ({ annotationId: a.id, after: i ? '阿青走到了北城。' : '# 第二章　入城', reason: a.note })) } });
  } }); t.after(() => f.close()); await configure(f.workspace);
  const doc = chapterTwo(f.workspace), original = await f.read(doc.path);
  let task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id, sceneId: 'whole' });
  const quotes = ['# 第二章　北城', '阿青到了北城。'];
  task = await f.workspace.saveCreativeTask({ id: task.id, expectedHash: task.taskHash, annotations: quotes.map((quote, i) =>
    ({ id: 'local_' + i, sourceHash: doc.hash, quote, start: original.indexOf(quote), end: original.indexOf(quote) + quote.length, note: '保留意思，轻改措辞' })) });
  const result = await f.workspace.sendCowriting({ documentId: doc.id, taskId: task.id, sceneId: 'whole', sourceHash: doc.hash,
    mode: 'annotate', message: '只改选中的两处。', annotationIds: task.annotations.map(a => a.id) });
  assert.equal(result.status, 'completed', result.error); assert.equal(await f.read(doc.path), original);
  let proposal = await f.workspace.getRevision({ id: result.latestRevisionId });
  assert.equal(proposal.edits.length, 2);
  proposal = await f.workspace.saveRevisionDraft({ id: proposal.id, proposalHash: proposal.proposalHash,
    edits: proposal.edits.map((e, i) => ({ id: e.id, selected: true, after: i ? '阿青踏进了北城。' : e.after })) });
  await f.workspace.applyRevision({ id: proposal.id, proposalHash: proposal.proposalHash, sourceHash: doc.hash,
    edits: proposal.edits.map(e => ({ id: e.id, after: e.after })) });
  assert.equal(await f.read(doc.path), original.replace(quotes[0], '# 第二章　入城').replace(quotes[1], '阿青踏进了北城。'));
  assert.equal(f.workspace.project.approvals.length, 0);
  await assert.rejects(f.workspace.sendCowriting({ documentId: doc.id, taskId: task.id, sceneId: 'whole', sourceHash: f.workspace.doc(doc.id).hash,
    mode: 'annotate', message: '再次处理旧批注。', annotationIds: task.annotations.map(a => a.id) }), e => e.code === 'CONFLICT');
});

test('old or ambiguous comment ranges are rejected before the model is called', async t => {
  let called = 0;
  const f = await fixture('creative-stale-comment', { fetcher: async () => { called++; return answer({}); } });
  t.after(() => f.close()); await configure(f.workspace);
  const doc = chapterTwo(f.workspace), quote = '阿青到了北城。', start = doc.text.indexOf(quote);
  let task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id });
  task = await f.workspace.saveCreativeTask({ id: task.id, expectedHash: task.taskHash, annotations: [
    { id: 'local', sourceHash: doc.hash, start, end: start + quote.length, quote, note: '改措辞' },
  ] });
  await f.write(doc.path, doc.text.replace('北城。', '西城。'));
  const fresh = await f.workspace.readDocument(doc.id);
  await assert.rejects(f.workspace.sendCowriting({ documentId: doc.id, taskId: task.id, sourceHash: fresh.hash, mode: 'annotate',
    message: '按旧批注修改', annotationIds: [task.annotations[0].id] }), e => e.code === 'CONFLICT');
  assert.equal(called, 0); assert.match(await f.read(doc.path), /西城/);
});

test('trial drafts remain separate, author edits stay in the candidate, and changed task requirements block stale adoption', async t => {
  let sequence = 0;
  const f = await fixture('creative-trials', { fetcher: async () => answer({ tool: 'submit_draft', args: { text: `沈舟沿着北墙走去，试写${++sequence}。` } }) });
  t.after(() => f.close()); await configure(f.workspace);
  const doc = chapterTwo(f.workspace), original = await f.read(doc.path);
  let task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id, goal: '接写既定动作' });
  const args = { documentId: doc.id, taskId: task.id, sourceHash: doc.hash, message: '采用已定动作，另试一种声口。', mode: 'draft' };
  const a = await f.workspace.sendCowriting(args), b = await f.workspace.sendCowriting(args);
  assert.equal(a.status, 'completed', a.error); assert.equal(b.status, 'completed', b.error);
  assert.notEqual(a.latestRevisionId, b.latestRevisionId); assert.equal(await f.read(doc.path), original);
  const view = await f.workspace.getCowriting(args); assert.equal(view.revisions.length, 2);
  let first = await f.workspace.getRevision({ id: a.latestRevisionId });
  first = await f.workspace.saveRevisionDraft({ id: first.id, proposalHash: first.proposalHash,
    edits: first.edits.map(e => ({ id: e.id, after: '\n\n作者手动合成的候选。\n', selected: true })) });
  assert.match((await f.workspace.getRevision({ id: b.latestRevisionId })).edits[0].after, /试写2/);
  task = await f.workspace.saveCreativeTask({ id: task.id, expectedHash: task.taskHash, goal: '改用另一套已经拍板的安排' });
  const outdated = await f.workspace.getRevision({ id: first.id });
  assert.equal(outdated.stale, true); assert.match(outdated.staleReason, /任务约定/);
  await assert.rejects(f.workspace.applyRevision({ id: first.id, proposalHash: first.proposalHash, sourceHash: doc.hash,
    edits: first.edits.map(e => ({ id: e.id, after: e.after })) }), e => e.code === 'CONFLICT');
  assert.equal(await f.read(doc.path), original);
});

test('outline recovery is local and survives restart without being confused with a saved plan', async t => {
  const f = await fixture('creative-outline-recovery');
  const view = await f.workspace.getCowriting({ documentId: 'outline_chapter_3' });
  await f.workspace.setWritingRecovery({ documentId: view.documentId, text: '尚未保存的章纲', baseHash: view.sourceHash });
  await f.close();
  const reopened = new Workspace(f.root); await reopened.init(); t.after(() => reopened.close());
  const restored = await reopened.getCowriting({ documentId: view.documentId });
  assert.equal(restored.outlineText, ''); assert.equal(restored.hasDraft, true); assert.equal(restored.recoveryDraft.text, '尚未保存的章纲');
  await reopened.saveWritingOutline({ documentId: view.documentId, expectedHash: restored.sourceHash, text: restored.recoveryDraft.text });
  const saved = await reopened.getCowriting({ documentId: view.documentId });
  assert.equal(saved.hasDraft, false); assert.match(saved.outlineText, /尚未保存的章纲/);
  assert.equal(reopened.project.approvals.length, 0);
});

test('a model cannot move a comment to another passage by inventing an annotation id', async t => {
  const f = await fixture('creative-forged-anchor', { fetcher: async (_url, request) => {
    const toolResult = JSON.parse(request.body).messages.find(row => row.role === 'tool');
    if (toolResult) {
      assert.match(toolResult.content, /未选择的批注/u);
      return answer({ text: '' });
    }
    return answer({ tool: 'submit_annotations',
      args: { edits: [{ annotationId: 'annotation_not_selected', after: '模型试图改写其他情节。' }] } });
  } });
  t.after(() => f.close()); await configure(f.workspace);
  const doc = chapterTwo(f.workspace), original = doc.text, quote = '阿青到了北城。', start = original.indexOf(quote);
  let task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id });
  task = await f.workspace.saveCreativeTask({ id: task.id, expectedHash: task.taskHash, annotations: [
    { id: 'client', quote, start, end: start + quote.length, sourceHash: doc.hash, note: '只轻改这一句' },
  ] });
  const result = await f.workspace.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, taskId: task.id, mode: 'annotate',
    message: '仅处理勾选批注', annotationIds: [task.annotations[0].id] });
  assert.equal(result.status, 'failed'); assert.equal(result.latestRevisionId, undefined);
  assert.equal(f.workspace.project.revisionTasks?.length || 0, 0); assert.equal(await f.read(doc.path), original);
});

test('a changed context preview is rejected without spending a model request', async t => {
  let calls = 0;
  const f = await fixture('creative-preview-race', { fetcher: async () => { calls++; return answer({}); } });
  t.after(() => f.close()); await configure(f.workspace);
  const doc = chapterTwo(f.workspace);
  let task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id, goal: '旧目标' });
  const input = { documentId: doc.id, sourceHash: doc.hash, taskId: task.id, message: '按目标讨论。' };
  const preview = await f.workspace.getWritingContext(input);
  task = await f.workspace.saveCreativeTask({ id: task.id, expectedHash: task.taskHash, goal: '新目标' });
  const result = await f.workspace.sendCowriting({ ...input, expectedContextSignature: preview.signature });
  assert.equal(result.status, 'failed'); assert.match(result.error, /本次依据已有更新/); assert.equal(calls, 0);
});

test('discussion and prose keep separate conversational histories inside the same task', async t => {
  const bodies = [];
  const f = await fixture('creative-channels', { fetcher: async (_url, request) => {
    const body = JSON.parse(request.body); bodies.push(body);
    return body.tools.some(tool => tool.function.name === 'submit_draft')
      ? answer({ tool: 'submit_draft', args: { text: '沈舟循着水声走去。' } }) : answer({ text: 'ONLY_DESIGN_RESPONSE' });
  } }); t.after(() => f.close()); await configure(f.workspace);
  const doc = chapterTwo(f.workspace), task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id, goal: '讨论与写作分开' });
  const base = { documentId: doc.id, sourceHash: doc.hash, taskId: task.id };
  await f.workspace.sendCowriting({ ...base, mode: 'discuss', message: 'ONLY_DESIGN_REQUEST' });
  const drafted = await f.workspace.sendCowriting({ ...base, mode: 'draft', message: '作者采用的安排：沈舟离开。' });
  assert.equal(drafted.status, 'completed', drafted.error);
  assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /ONLY_DESIGN_REQUEST|ONLY_DESIGN_RESPONSE/);
  assert.equal((await f.workspace.getCowriting(base)).messages.length, 4);
});
