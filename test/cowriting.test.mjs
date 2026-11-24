import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, configure, confirmFirst, modelFetch, waitJob } from './helpers.mjs';
import { recallMemlayer, validateMemlayer } from '../core/memlayer-client.mjs';
import { GO_BASE } from '../core/model-connections.mjs';
import { importTextDocuments } from '../core/text-import.mjs';
import { resolveWritingRules, selectWritingRules } from '../core/writing-rules.mjs';

function completion({ text = null, tool, args, type = 'stop' }) {
  const message = { role: 'assistant', content: text };
  if (tool) {
    message.tool_calls = [{ id: 'call_' + tool, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }];
  }
  return Response.json({ id: 'local-completion', model: 'fixture-model', choices: [{ message, finish_reason: tool ? 'tool_calls' : type }],
    usage: { prompt_tokens: 260, completion_tokens: 70, total_tokens: 330 } });
}

const chapterTwo = workspace => workspace.documents.find(d => d.kind === 'chapter' && d.chapter === 2);
function authorPrompt(request) {
  const { content } = request.messages.findLast(row => row.role === 'user');
  return JSON.parse(typeof content === 'string' ? content : content.map(part => part.text).join(''));
}

test('new chat files persist in the right folders and branching or hiding messages preserves files and original history', async t => {
  const calls = [];
  const f = await fixture('agent-born-files', { fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    const { request: words } = authorPrompt(request);
    return completion({ tool: 'create_writing_file', args: { chapter: 25, kind: words.includes('纲') ? 'outline' : 'draft',
      title: '渡船', text: '两人在渡口相见。' } });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const documentId = 'outline_chapter_25';
  const task = await w.createCreativeTask({ kind: 'next', documentId, title: '渡口讨论' });
  const start = await w.getCowriting({ documentId, taskId: task.id });
  const args = { documentId, taskId: task.id };
  const planned = await w.sendCowriting({ ...args, sourceHash: start.sourceHash, message: '新建第二十五章纲' });
  assert.equal(planned.status, 'completed', planned.error);
  const design = planned.messages.at(-1).artifact;
  assert.match(design.path, /大纲\/第25章章纲\.md/u);
  assert.match(await f.read(design.path), /两人在渡口相见/u);
  const next = await w.getCowriting(args);
  const drafted = await w.sendCowriting({ ...args, sourceHash: next.sourceHash, message: '另存第二十五章草稿',
    images: [{ name: '渡口.jpg', mimeType: 'image/jpeg', data: '/9j/2Q==' }] });
  assert.equal(drafted.status, 'completed', drafted.error);
  assert.match(JSON.stringify(calls.at(-1).messages.at(-1)), /data:image\/jpeg;base64,/u);
  const draft = drafted.messages.at(-1).artifact;
  assert.match(draft.path, /草稿章节\/第25章/u);
  assert.equal(w.project.approvals.length, 0);
  const author = drafted.messages.find(row => row.text === '另存第二十五章草稿');
  const branch = await w.forkCowriting({ ...args, messageId: author.id, editedText: '请先补问一句' });
  const branched = await w.getCowriting({ documentId, taskId: branch.id });
  assert.equal(branched.messages.length, 2);
  assert.equal(branched.composer.text, '请先补问一句');
  await w.setCowritingMessageVisibility({ ...args, messageId: drafted.messages.at(-1).id, hidden: true });
  assert.ok((await w.getCowriting(args)).messages.at(-1).hiddenAt);
  assert.match(await f.read(draft.path), /两人在渡口相见/u);
  await w.setCowritingMessageVisibility({ ...args, messageId: drafted.messages.at(-1).id, hidden: false });
  assert.equal((await w.getCowriting(args)).messages.at(-1).hiddenAt, undefined);
});

test('discussion reads saved content while protecting the author’s recovery drafts', async t => {
  const calls = [];
  const f = await fixture('discussion-with-recovery', { fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    if (authorPrompt(request).request === '保存第三章章纲' && !request.messages.some(row => row.role === 'tool')) {
      return completion({ tool: 'create_writing_file', args: { chapter: 3, kind: 'outline', title: '渡口', text: '助手提出的章纲。' } });
    }
    return completion({ text: '可以继续讨论。' });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const doc = chapterTwo(w);
  const edit = '仅保存在恢复稿中的作者编辑。';
  await w.setWritingRecovery({ documentId: doc.id, baseHash: doc.hash, text: edit });
  const input = { documentId: doc.id, sourceHash: doc.hash, message: '讨论已保存的正文' };
  await assert.rejects(w.sendCowriting({ ...input, mode: 'draft' }), { code: 'UNSAVED_DRAFT' });
  const discussion = await w.sendCowriting(input);
  assert.equal(discussion.status, 'completed', discussion.error);
  assert.match(JSON.stringify(authorPrompt(calls[0])), /阿青到了北城/u);
  assert.doesNotMatch(JSON.stringify(calls[0]), new RegExp(edit, 'u'));
  assert.equal((await w.getCowriting({ documentId: doc.id })).recoveryDraft.text, edit);
  const documentId = 'outline_chapter_3';
  const outline = await w.getCowriting({ documentId });
  await w.setWritingRecovery({ documentId, baseHash: outline.sourceHash, text: edit });
  const result = await w.sendCowriting({ documentId, sourceHash: outline.sourceHash, message: '保存第三章章纲' });
  assert.equal(result.status, 'completed', result.error);
  assert.match(calls.at(-1).messages.find(row => row.role === 'tool').content, /有作者的恢复稿/u);
  const saved = await w.getCowriting({ documentId });
  assert.equal(saved.outlineText, '');
  assert.equal(saved.recoveryDraft.text, edit);
});

test('discussed stage plans are saved as plot arcs only after author acceptance', async t => {
  const prompts = [];
  const f = await fixture('stage-discussion', { fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    const prompt = authorPrompt(request);
    prompts.push(prompt);
    if (prompt.request === '核对已经保存的计划') return completion({ text: '已读到阶段计划。' });
    if (prompt.request.startsWith('参考阶段计划')) return completion({ tool: 'create_writing_file',
      args: { kind: 'outline', chapter: 26, title: '引出密信', text: '照阶段计划安排接头。' } });
    if (prompt.request === '查一下包含北城的阶段计划') return request.messages.some(row => row.role === 'tool')
      ? completion({ text: '查到渡口至北城阶段计划。' })
      : completion({ tool: 'find_stage_plan', args: { query: '北城' } });
    if (!request.messages.some(row => row.role === 'tool')) return completion({ tool: 'create_writing_file',
      args: { kind: 'outline', chapter: 25, title: '误分类', text: '不能保存成单章' } });
    assert.match(request.messages.at(-1).content, /prepare_stage_plan/u);
    return completion({ tool: 'prepare_stage_plan', args: {
      title: '渡口至北城', body: '引出密信，准备北城转折。', fromChapter: 25, toChapter: 27,
      nodes: [{ title: '检查水路', chapter: 25 }, { title: '收到密信', chapter: 27, note: '保留两个接头人备选。' }],
    } });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const documentId = 'outline_stage';
  const task = await w.createCreativeTask({ kind: 'stage', documentId, title: '渡口到北城' });
  const args = { documentId, taskId: task.id };
  const start = await w.getCowriting(args);
  const state = await w.sendCowriting({ ...args, sourceHash: start.sourceHash, message: '请把阶段剧情添加到计划' });
  assert.equal(state.status, 'completed', state.error);
  const reply = state.messages.at(-1);
  assert.equal(reply.stagePlan.details.toChapter, 27);
  assert.equal(w.records.length, 0);
  assert.equal(await w.store.read('_创作管理/大纲/第25章章纲.md'), null);
  const { recordId } = await w.applyCowritingStagePlan({ ...args, messageId: reply.id });
  assert.equal((await w.applyCowritingStagePlan({ ...args, messageId: reply.id })).recordId, recordId);
  assert.equal(w.records.length, 1);
  assert.equal(w.events.length, 0);
  const [plan] = w.summary().stagePlans;
  assert.equal(plan.id, recordId);
  assert.equal(plan.nodes[1].chapter, 27);
  assert.match(await f.read(plan.path), /引出密信/u);
  assert.equal((await w.getCowriting(args)).messages.at(-1).stagePlan.recordId, recordId);
  const reference = { kind: 'stage', id: recordId, title: plan.title, hash: plan.hash };
  await w.saveCowritingInput({ ...args, text: '核对已经保存的计划', references: [reference] });
  const reviewed = await w.sendCowriting({ ...args, sourceHash: start.sourceHash, message: '核对已经保存的计划', reference });
  assert.equal(reviewed.status, 'completed', reviewed.error);
  assert.match(prompts.at(-1).activeSource.discussionSource.excerpt, /收到密信/u);
  assert.match(prompts.at(-1).activeSource.discussionSource.status, /阶段剧情计划/u);

  const followingChapter = await w.getCowriting({ documentId: 'outline_chapter_26' });
  const drafted = await w.sendCowriting({ documentId: followingChapter.documentId, sourceHash: followingChapter.sourceHash,
    message: '参考阶段计划《渡口至北城》，新建第26章章纲。' });
  assert.equal(drafted.status, 'completed', drafted.error);
  assert.match(drafted.messages.at(-1).artifact.path, /第26章章纲/u);
  assert.equal(prompts.at(-1).activeSource.stagePlans[0].id, recordId);
  assert.equal(prompts.at(-1).activeSource.discussionSource, undefined);
  assert.equal(w.records.length, 1);

  const laterChapter = await w.getCowriting({ documentId: 'outline_chapter_30' });
  const lookedUp = await w.sendCowriting({ documentId: laterChapter.documentId, sourceHash: laterChapter.sourceHash,
    message: '查一下包含北城的阶段计划' });
  assert.equal(lookedUp.status, 'completed', lookedUp.error);
  assert.ok(lookedUp.manifest.sections.some(section => section.kind === 'stage' && section.path === plan.path && section.hash === plan.hash));
});

test('workspace draft edits are bound to the grant and exact source, while archive requires a separate confirmation', async t => {
  const requests = [];
  const f = await fixture('workspace-editor', { fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const { request: words, activeSource } = authorPrompt(request);
    const doc = activeSource.workspaceDocument;
    if (words === '打开草稿') {
      if (request.messages.at(-1).role === 'tool') return completion({ text: '已找到原文。' });
      return completion({ tool: 'open_workspace_file', args: { documentId: doc.documentId, show: true } });
    }
    if (words === '整理这份资料') return completion({ tool: 'prepare_workspace_archive', args: { documentIds: [doc.documentId] } });
    return completion({ tool: 'prepare_workspace_edit', args: {
      documentId: doc.documentId, sourceHash: doc.sourceHash, edits: [{ before: '船在北岸。', after: '船在西岸。' }],
    } });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const draft = await w.createChapterDraft({ chapter: 24, title: '渡船', importedText: '# 第24章 渡船\n\n船在北岸。\n' });
  const [imported] = await importTextDocuments(w, [{ title: '可整理资料', text: '供本次验收。' }]);
  const other = await w.createChapterDraft({ chapter: 24, title: '另一稿', importedText: '另一份草稿。' });
  const current = await w.getCowriting({ documentId: 'outline_chapter_24' });
  const args = { documentId: current.documentId, sourceHash: current.sourceHash, workspaceDocumentId: draft.id };
  const opened = await w.sendCowriting({ ...args, message: '打开草稿' });
  assert.equal(opened.status, 'completed', opened.error);
  assert.equal(opened.messages.at(-1).openedWorkspaceFile.documentId, draft.id);
  assert.equal(authorPrompt(requests[0]).activeSource.discussionSource, undefined);
  assert.equal(authorPrompt(requests[0]).activeSource.workspaceDocument.documentId, draft.id);
  assert.doesNotMatch(JSON.stringify(authorPrompt(requests[0]).activeSource.workspaceDocument), /船在北岸/u);
  assert.match(JSON.stringify(requests[1].messages.at(-1)), /船在北岸/u);

  const pending = await w.sendCowriting({ ...args, message: '按意见修改' });
  const reviewed = pending.messages.at(-1).workspaceAction;
  assert.equal(reviewed?.type, 'edit', pending.error);
  assert.match(await f.read(draft.path), /北岸/);
  const selected = '船在北岸。';
  const start = draft.text.indexOf(selected);
  await assert.rejects(w.applyWorkspaceDraftEdit({ ...reviewed, selection: { start, end: start + selected.length, text: selected },
    edits: [{ before: '渡船', after: '改错处' }] }), { code: 'EVIDENCE' });
  await assert.rejects(w.applyWorkspaceDraftEdit({ ...reviewed, edits: [{ before: '不存在。', after: '错处。' }] }), { code: 'EVIDENCE' });
  await assert.rejects(w.applyWorkspaceDraftEdit({ ...reviewed, edits: [{ before: '船', after: '舟' }] }), { code: 'EVIDENCE' });
  await assert.rejects(w.applyWorkspaceDraftEdit({ ...reviewed, sourceHash: other.hash }), { code: 'CONFLICT' });
  const direct = await w.sendCowriting({ ...args, message: '直接保存修改', draftWrite: { documentId: draft.id, sourceHash: draft.hash } });
  assert.equal(direct.status, 'completed', direct.error);
  assert.equal(direct.messages.at(-1).workspaceAction?.applied, true);
  assert.match(await f.read(draft.path), /西岸/);
  const edited = w.doc(draft.id);
  const markers = await w.getWorkspaceEditMarks({ documentId: draft.id, sourceHash: edited.hash });
  assert.equal(edited.text.slice(markers[0].from, markers[0].to), '船在西岸。');
  assert.equal(await f.read(other.path), '另一份草稿。');
  await assert.rejects(w.applyWorkspaceDraftEdit(reviewed), { code: 'CONFLICT' });
  const receipt = { documentId: args.documentId, taskId: null, messageId: pending.messages.at(-1).id };
  assert.equal((await w.getWorkspaceDraftEdit({ documentId: draft.id, sourceHash: edited.hash })).canUndo, true);
  await assert.rejects(w.applyCowritingDraftEdit(receipt), { code: 'CONFLICT' });
  await w.undoCowritingDraftEdit({ documentId: draft.id, sourceHash: edited.hash });
  assert.equal((await w.readDocument(draft.id)).hash, draft.hash);
  const directAfterUndo = await w.getCowriting({ documentId: args.documentId });
  assert.equal(directAfterUndo.messages.at(-1).workspaceAction.applied, false);
  const applied = await w.applyCowritingDraftEdit(receipt);
  assert.equal(applied.document.hash, edited.hash);
  await assert.rejects(w.applyCowritingDraftEdit(receipt), { code: 'CONFLICT' });
  const changed = await w.saveDocument({ documentId: draft.id, expectedHash: edited.hash, text: applied.document.text + '\n作者手写。' });
  await assert.rejects(w.undoCowritingDraftEdit({ documentId: draft.id, sourceHash: edited.hash }), { code: 'CONFLICT' });
  assert.equal((await w.readDocument(draft.id)).hash, changed.document.hash);
  assert.match(await f.read(draft.path), /作者手写/u);

  const archive = await w.sendCowriting({ ...args, workspaceDocumentId: imported.id, message: '整理这份资料' });
  const action = archive.messages.at(-1).workspaceAction;
  assert.equal(action?.type, 'archive', archive.error);
  assert.equal(await f.read(imported.path), '供本次验收。');
  await assert.rejects(w.archiveWorkspaceFiles({ files: [action.files[0], { documentId: chapterTwo(w).id }] }), { code: 'READ_ONLY' });
  await w.archiveWorkspaceFiles(action);
  assert.equal(await w.store.read(imported.path), null);
  assert.equal((await w.readDocument(imported.id)).historical, true);
  await w.restoreWorkspaceFile({ documentId: imported.id });
  assert.equal(w.doc(imported.id).path, imported.path);
  assert.equal(await f.read(imported.path), '供本次验收。');
});

test('a model can perform more than five reads, including repeats, before it answers naturally', async t => {
  const requests = [];
  const f = await fixture('cowriting-last-step', { fetcher: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    return requests.length <= 7 ? completion({ tool: 'find_characters', args: { names: ['沈舟'] } })
      : completion({ text: '已有资料足够回答。' });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const doc = chapterTwo(w);
  const result = await w.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '讨论虚构人物。' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 8);
  assert.ok(requests.every(body => body.tools?.length && !('max_tokens' in body) && !('max_completion_tokens' in body)));
  assert.equal(requests.at(-1).messages.filter(row => row.role === 'tool').length, 7);
  const answer = authorPrompt(requests.at(-1));
  assert.equal(answer.request, '讨论虚构人物。');
  assert.equal(result.messages.at(-1).text, '已有资料足够回答。');
});

test('the first request includes the full cited draft and normal tools so the model can choose how to respond', async t => {
  const requests = [];
  const f = await fixture('cowriting-read-draft-direct', { fetcher: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return completion({ text: '章末交灯动作清楚。' });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const path = '资料/虚构草稿.md';
  const text = '# 虚构草稿\n\n' + '城北书铺的掌柜正在整理旧信。\n'.repeat(620) + '\n章末，沈舟把灯交给船夫。';
  await f.write(path, text);
  await w.refresh();
  const selected = w.documents.find(d => d.path === path);
  const args = { documentId: 'outline_chapter_24', reference: { kind: 'document', id: selected.id, hash: selected.hash },
    message: '来看看这篇剧情' };
  const view = await w.getCowriting(args);
  const result = await w.sendCowriting({ ...args, sourceHash: view.sourceHash });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools?.length);
  assert.equal(requests[0].tool_choice, undefined);
  const user = authorPrompt(requests[0]);
  assert.equal(user.activeSource.discussionSource.excerpt, text);
  assert.equal(user.activeSource.discussionSource.nextOffset, null);
  assert.equal(result.manifest.sections.find(section => section.path === path).status, '作者引用 · 原档全文');
  assert.equal(await f.read(path), text);
});

const dsmlOutline = '<｜DSML｜ calls>\n<｜DSML｜ invoke name="find_outline">\n' +
  '<｜DSML｜ parameter name="query" string="true">第二章</｜DSML｜ parameter>\n' +
  '<｜DSML｜ parameter name="offset" string="false">0</｜DSML｜ parameter>\n' +
  '</｜DSML｜ invoke>\n</｜DSML｜ calls>';

function fixtureStream(textParts) {
  const parts = textParts.map(content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
  parts.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  return new Response(parts.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

test('split DeepSeek outline markup is translated into one local read and never appears in the transcript', async t => {
  const requests = [], events = [];
  const f = await fixture('cowriting-dsml', { notify: e => events.push(e), fetcher: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length === 1) return fixtureStream(dsmlOutline.match(/[\s\S]{1,3}/gu));
    return completion({ text: '我已核对本轮可读的大纲资料。' });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const doc = chapterTwo(w);
  const result = await w.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '查第二章大纲。' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 2);
  const toolCall = requests[1].messages.find(m => m.tool_calls).tool_calls[0];
  assert.equal(toolCall.function.name, 'find_outline');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { query: '第二章', offset: 0 });
  assert.ok(requests[1].messages.some(m => m.role === 'tool' && m.tool_call_id === toolCall.id));
  assert.doesNotMatch(JSON.stringify([events, result.messages, requests]), /DSML|parameter name/u);
  assert.ok(events.some(event => event.activity === '查作品大纲 · 第二章'));
  assert.ok(events.some(event => event.stage === '正在回复'));
  assert.doesNotMatch(JSON.stringify(events), /第 \d+ 步/u);
});

test('malformed or undeclared text tools fail once without displaying or attempting their arguments', async t => {
  let requests = 0;
  let raw = dsmlOutline.replace('</｜DSML｜ parameter>', '</｜DSML｜>');
  const f = await fixture('cowriting-dsml-invalid', { fetcher: async () => {
    requests++;
    return completion({ text: raw });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const doc = chapterTwo(w);
  const before = await f.read(doc.path);
  for (const text of [raw, dsmlOutline.replace('find_outline', 'submit_draft'), '<｜DS']) {
    raw = text;
    const result = await w.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '讨论虚构稿。' });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /无法使用的工具指令/u);
    assert.equal(result.messages.some(row => row.role === 'assistant'), false);
  }
  assert.equal(requests, 3);
  assert.equal(await f.read(doc.path), before);
});

test('legacy markup stays on disk, is removed from context, and a retry reuses the author message', async t => {
  let request;
  const f = await fixture('cowriting-legacy-tool', { fetcher: async (_url, init) => {
    request = JSON.parse(init.body);
    return completion({ text: '已接续原问题。' });
  } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  const doc = chapterTwo(w);
  const path = `_创作管理/共写/cowrite_${doc.id}.ending.json`;
  const author = { id: 'author-old', role: 'author', text: '第二章大纲怎么安排？', sourceHash: doc.hash, mode: 'discuss' };
  const bad = { id: 'legacy-reply', role: 'assistant', text: dsmlOutline, sourceHash: doc.hash, mode: 'discuss' };
  const original = JSON.stringify({ schema: 1, workId: w.project.id, documentId: doc.id, sceneId: null,
    taskId: null, status: 'completed', messages: [author, bad] });
  await f.write(path, original);
  const view = await w.getCowriting({ documentId: doc.id });
  assert.equal(await f.read(path), original);
  assert.equal(view.messages.at(-1).toolFailure, true);
  assert.doesNotMatch(JSON.stringify(view.messages), /DSML/u);
  assert.equal(view.composer.text, author.text);
  const response = await w.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: author.text, retryMessageId: author.id });
  assert.equal(response.status, 'completed', response.error);
  assert.equal(response.messages.filter(row => row.role === 'author').length, 1);
  assert.doesNotMatch(JSON.stringify(request), /DSML/u);
});

test('background job budgets are not applied to creative conversation and usage is reported as received', async t => {
  let requests = 0;
  const f = await fixture('cowriting-token-preflight', { fetcher: async () => { requests++; return completion({ text: '作品讨论已完成。' }); } });
  t.after(f.close);
  const w = f.workspace;
  await configure(w);
  await w.updateSettings({ ai: { ...w.project.settings.ai, maxTokensPerJob: 1000 } });
  const doc = chapterTwo(w);
  const result = await w.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '讨论虚构人物。' });
  assert.equal(result.status, 'completed');
  assert.equal(requests, 1);
  assert.deepEqual(w.project.aiAssistanceUsage.at(-1).usage, { total_tokens: 330, estimated: false });
});

test('the Go billing check still rejects a streamed completion before it becomes a saved reply', async t => {
  const sent = [];
  const progress = [];
  const f = await fixture('cowriting-stream-billing', { getKey: async () => 'fixture-go-key', notify: event => progress.push(event),
    fetcher: async (url, request) => {
      sent.push({ url, streaming: request.streamResponse });
      const frame = data => 'data: ' + JSON.stringify(data) + '\n\n';
      return new Response(frame({ choices: [{ index: 0, delta: { content: '只供模拟流预览。' }, finish_reason: 'stop' }] }) +
        frame({ choices: [], usage: { opencode: { billing_source: 'pay-as-you-go' } } }) + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  t.after(f.close);
  const w = f.workspace;
  await w.updateSettings({ writingModel: 'analysis', ai: { enabled: true, baseUrl: GO_BASE, model: 'glm-5.3',
    maxTokensPerJob: 120000, dailyTokenLimit: 300000, maxOutputTokens: 2000 } });
  const doc = chapterTwo(w);
  const before = await f.read(doc.path);
  const result = await w.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '讨论虚构章节。' });
  assert.deepEqual(sent, [{ url: GO_BASE + '/chat/completions', streaming: true }]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /服务返回了订阅以外的计费来源/u);
  assert.ok(progress.some(event => event.stage === '正在回复'));
  assert.equal(result.messages.some(message => message.role === 'assistant'), false);
  assert.equal(await f.read(doc.path), before);
});

test('the Agent reads both versioned rule files and repairs an in-scope machine finding before registering a candidate', async t => {
  const hardDraft = '沈舟说："我来送信。"';
  const corrected = '沈舟说：“我来送信。”';
  const requests = [];
  const f = await fixture('cowriting-rule-feedback', { fetcher: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    const feedback = body.messages.find(m => m.role === 'tool' && m.content.includes('repair_requested'));
    if (feedback) assert.match(feedback.content, /ASCII 直引号/u);
    return completion({ tool: 'submit_draft', args: { text: feedback ? corrected : hardDraft } });
  } });
  t.after(f.close);
  const work = f.workspace;
  const mainRule = '文风/写作规则.md', voiceRule = '文风/指代.md';
  await f.write(mainRule, '# 写作规则\n\n人物应按作品确认的称谓说话。');
  await f.write(voiceRule, '# 指代细则\n\n' + '背景。'.repeat(600) + '\n\n## 人称指代\n\n- 换人时写清动作的发出者。');
  await f.write('00-项目导航/稿件核对.json', JSON.stringify({ wording: [], ruleFiles: [mainRule, voiceRule] }));
  await configure(work);
  const doc = chapterTwo(work);
  const before = await f.read(doc.path);
  const result = await work.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '试写 1 句。', mode: 'draft' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[0]), /换人时写清动作的发出者/u);
  assert.deepEqual(result.manifest.sections.filter(s => s.kind === 'rule').map(s => s.path), [mainRule, voiceRule]);
  const proposal = await work.getRevision({ id: result.latestRevisionId });
  assert.equal(proposal.candidateCheck.repair, 'passed');
  assert.equal(proposal.candidateCheck.status, 'not_required');
  assert.match(proposal.edits[0].after, /沈舟说：“我来送信。”/u);
  assert.equal(await f.read(doc.path), before);
  await f.write(voiceRule, '# 指代细则\n\n已更新。');
  await assert.rejects(work.applyRevision({ id: proposal.id, proposalHash: proposal.proposalHash, sourceHash: doc.hash,
    edits: proposal.edits.map(({ id, after }) => ({ id, after })) }), { code: 'CONFLICT' });
});

test('writing rules are scoped to the chapter, select only matching terms, and keep editing examples separate', async t => {
  const f = await fixture('writing-rule-scope');
  t.after(f.close);
  const sources = [
    { label: '文风', use: 'core', group: 'style', text: '# 文风\n指代要清楚。' },
    { label: '特定章声口', use: 'chapter', group: 'style', chapters: [2], text: '# 声口\n沈舟在渡口自称某。' },
    { label: '分境', use: 'lookup', group: 'wording', text: '| 车行 | 车坊 | 指实体店铺 |\n| 别处 | 本稿无关 | 无关语境 |' },
    { label: '速查', use: 'lookup', group: 'wording', text: '| 车行 | 重复候选 | 简表 |\n| 起居室 | 内室 | 居处 |' },
    { label: '校订', use: 'examples', group: 'wording', text: '| 车行 | 车坊 | 上次校订的写法 |' },
    { label: '旧交接', use: 'reference', group: 'legacy', text: '# 旧任务\n旧流程不用自动读取。' },
  ].map((row, i) => ({ ...row, path: `文风/资料${i}.md` }));
  for (const source of sources) await f.write(source.path, source.text);
  await f.write('00-项目导航/稿件核对.json', JSON.stringify({
    wording: [], ruleSources: sources.map(({ text, ...source }) => source),
  }));
  const selection = await resolveWritingRules(f.workspace);
  const result = selectWritingRules(selection, 2, '他走过车行，进了起居室。');
  assert.deepEqual(result.sources.map(row => row.title), ['文风', '特定章声口', '分境', '速查', '校订']);
  assert.match(result.instructions, /仅供语境参考/u);
  assert.match(result.instructions, /车坊.*实体店铺/u);
  assert.match(result.instructions, /起居室.*内室/u);
  assert.doesNotMatch(result.instructions, /本稿无关|重复候选|旧流程/u);
  assert.ok(result.heads[sources[4].path]);
  assert.equal(result.heads[sources[5].path], undefined);
  const otherChapter = selectWritingRules(selection, 1, '他回到渡口。');
  assert.deepEqual(otherChapter.sources.map(row => row.title), ['文风']);
  assert.equal(otherChapter.heads[sources[1].path], undefined);
});

test('candidate repair stops after one retry and leaves problems outside the selected text for the author', async t => {
  const requests = [];
  const f = await fixture('cowriting-bounded-feedback', { fetcher: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    const retry = body.messages.some(m => m.role === 'tool' && m.content.includes('repair_requested'));
    return completion({ tool: 'submit_draft', args: { text: retry ? '更坏的"标点"，以及 &amp;。' : '新段存在"标点"。' } });
  } });
  t.after(f.close);
  const work = f.workspace;
  await configure(work);
  const doc = chapterTwo(work);
  const before = await f.read(doc.path);
  const input = { documentId: doc.id, sourceHash: doc.hash, message: '试写。', mode: 'draft' };
  const result = await work.sendCowriting(input);
  const proposal = await work.getRevision({ id: result.latestRevisionId });
  assert.equal(requests.length, 2);
  assert.equal(proposal.candidateCheck.repair, 'unresolved');
  assert.match(proposal.edits[0].after, /新段存在/u);
  assert.equal(await f.read(doc.path), before);
  requests.length = 0;
  work.fetcher = async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return completion({ tool: 'submit_draft', args: { text: '新段标点合规。' } });
  };
  const oldHard = before.replace('阿青', '"阿青"');
  const changed = await work.saveDocument({ documentId: doc.id, expectedHash: doc.hash, text: oldHard });
  const other = await work.sendCowriting({ ...input, sourceHash: changed.document.hash });
  assert.equal(requests.length, 1);
  const second = await work.getRevision({ id: other.latestRevisionId });
  assert.equal(second.candidateCheck.status, 'failed');
  assert.equal(second.candidateCheck.repair, undefined);
  assert.equal(await f.read(doc.path), oldHard);
});

test('Pi consults confirmed prior facts and registers a draft that uses the existing review, gate and apply path', async t => {
  const requests = [];
  const f = await fixture('cowriting-review', { fetcher: async (url, request) => {
    const body = JSON.parse(request.body);
    if (!body.tools) return modelFetch()(url, request);
    requests.push(body);
    const lookup = body.messages.find(m => m.role === 'tool');
    if (!lookup) return completion({ tool: 'find_characters', args: { names: ['沈舟'] } });
    assert.match(lookup.content, /开始试练第一层|开始修习/);
    assert.match(lookup.content, /船工/);
    assert.match(lookup.content, /阿青 → 沈舟：相识/);
    assert.doesNotMatch(lookup.content, /作者保留的身世/);
    return completion({ tool: 'submit_draft', args: { text: '沈舟收好书册，循着水声往北走。', reason: '作者指定接续' } });
  } });
  t.after(() => f.close());
  const workspace = f.workspace;
  const boatman = workspace.project.characters.find(c => c.name === '沈舟');
  const card = workspace.documents.find(d => d.id === boatman.primarySourceId);
  await workspace.approveBaseline({ characterId: boatman.id, expectedSourceHash: card.hash,
    fields: [{ field: '身份', value: '船工' }, { field: '身世', value: '作者保留的身世', certainty: 'reserved' }] });
  await configure(workspace);
  const first = await confirmFirst(workspace);
  await waitJob(workspace, first.job.id);
  const doc = chapterTwo(workspace);
  const original = await f.read(doc.path);
  const approvals = workspace.project.approvals.length;
  const result = await workspace.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '拍板：接写沈舟收好书册。', mode: 'draft' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 2);
  assert.equal(await f.read(doc.path), original);
  const view = await workspace.getCowriting({ documentId: doc.id });
  assert.equal(view.messages.length, 2);
  const proposal = await workspace.getRevision({ id: result.latestRevisionId });
  assert.equal(proposal.origin, 'cowriting');
  assert.equal(proposal.edits[0].start, original.length);
  const edits = [{ id: proposal.edits[0].id, after: '\n\n沈舟收好书册，循着水声往北行。\n' }];
  const report = await workspace.previewWritingRevision({ id: proposal.id, proposalHash: proposal.proposalHash, edits });
  assert.equal(report.status, 'not_required');
  assert.notEqual(report.sourceHash, doc.hash);
  assert.equal(await f.read(doc.path), original);
  await workspace.applyRevision({ id: proposal.id, proposalHash: proposal.proposalHash, sourceHash: doc.hash, edits });
  assert.equal(await f.read(doc.path), original + edits[0].after);
  assert.equal(workspace.project.approvals.length, approvals);
  assert.equal((await workspace.getRevision({ id: proposal.id })).status, 'applied');
});

test('Pi sends no draft tool during a discussion and a selected scene draft cannot rewrite the rest of the chapter', async t => {
  const quote = '七月廿四，阿青到了北城。';
  const replacement = '七月廿四，阿青踏入北城。';
  const f = await fixture('cowriting-scope', { fetcher: async (_url, request) => {
    const body = JSON.parse(request.body);
    if (!body.tools.some(tool => tool.function.name === 'submit_draft')) return completion({ text: '可以从进城写起。' });
    return completion({ tool: 'submit_draft', args: { text: replacement } });
  } });
  t.after(() => f.close());
  await configure(f.workspace);
  const doc = chapterTwo(f.workspace);
  const scene = await f.workspace.addScene({ documentId: doc.id, quote, name: '进城' });
  const base = { documentId: doc.id, sourceHash: doc.hash, sceneId: scene.id };
  const discussion = await f.workspace.sendCowriting({ ...base, message: '谈谈开场', mode: 'discuss' });
  assert.equal(discussion.status, 'completed', discussion.error);
  assert.equal(discussion.latestRevisionId, undefined);
  const drafted = await f.workspace.sendCowriting({ ...base, message: '采用进城开场，轻改措辞。', mode: 'draft' });
  assert.equal(drafted.status, 'completed', drafted.error);
  const proposal = await f.workspace.getRevision({ id: drafted.latestRevisionId });
  assert.equal(proposal.edits[0].before, quote);
  assert.equal(proposal.edits[0].start, scene.start);
  await f.write(doc.path, (await f.read(doc.path)) + '\n作者在外部补笔。\n');
  await assert.rejects(f.workspace.applyRevision({ id: proposal.id, proposalHash: proposal.proposalHash, sourceHash: doc.hash,
    edits: [{ id: proposal.edits[0].id, after: replacement }] }), e => e.code === 'CONFLICT');
  assert.match(await f.read(doc.path), /作者在外部补笔/);
});

test('a discussion can pin the opened character or file without switching chapters or producing a revision', async t => {
  const seen = [];
  const f = await fixture('cowriting-open-reference', { fetcher: async (_url, request) => {
    const payload = JSON.parse(request.body);
    assert.ok(!payload.tools.some(tool => tool.function.name === 'submit_draft'));
    seen.push(payload.messages);
    return completion({ text: '给出由作者核对的设定备选。' });
  } });
  t.after(f.close);
  await configure(f.workspace);
  const w = f.workspace, doc = chapterTwo(w), original = await f.read(doc.path);
  const person = w.project.characters.find(c => c.name === '沈舟');
  const reference = { kind: 'character', id: person.id, revision: person.revision };
  const result = await w.sendCowriting({ documentId: doc.id, sourceHash: doc.hash, message: '讨论这份档案怎么补充。', reference });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.latestRevisionId, undefined);
  assert.match(JSON.stringify(seen[0]), /discussionSource.*沈舟.*船工/u);
  assert.ok(result.manifest.sections.some(s => s.title === '沈舟' && s.reason.includes('本轮对话')));
  const setting = w.documents.find(d => d.kind === 'setting');
  const linked = { kind: 'document', id: setting.id, hash: setting.hash };
  const preview = await w.getWritingContext({ documentId: doc.id, reference: linked });
  assert.ok(preview.sections.some(s => s.path === setting.path && s.excerpt.includes('不改变容貌')));
  await f.write(setting.path, '作者修订了提示。');
  await assert.rejects(w.getWritingContext({ documentId: doc.id, reference: linked }), { code: 'CONFLICT' });
  assert.equal(await f.read(doc.path), original);
});

test('Memlayer recall sends the real query, keeps older relevant facts, drops unrelated ones and degrades per project', async () => {
  const settings = validateMemlayer({ enabled: true, baseUrl: 'http://127.0.0.1:8770', sharedProject: 'shared_author' });
  const older = { status: 'current', confirmed: true, perspective: 'self', id: 'f_old', text: '口播开头先展示商品实物，不要报价格。' };
  const result = await recallMemlayer(settings, 'work_example', undefined, async (url, options) => {
    assert.equal(url.pathname, '/v1/facts');
    // The real question must reach the engine; otherwise only the newest rows come back.
    assert.equal(url.searchParams.get('q'), '开头怎么写');
    assert.equal(url.searchParams.get('mode'), 'current');
    assert.equal(options.method, undefined);
    const project = url.searchParams.get('project');
    if (project === 'shared_author') throw new TypeError('offline');
    return Response.json({ ok: true, facts: [
      { ...older, project },
      { ...older, project: 'work_foreign', text: '越界' },
      { ...older, project, status: 'retracted', text: '已撤回' },
      { ...older, project, confirmed: false, text: '待批准' },
      { ...older, project, id: 'f_junk', text: '与本次问题无关的内容' },
    ] });
  }, '开头怎么写');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.items.map(x => x.text), [older.text]);
  assert.equal(result.available, 1);
  // A question without retrievable terms injects nothing at all.
  const quiet = await recallMemlayer(settings, 'work_example', undefined, async () => { throw new Error('must not call'); }, '');
  assert.equal(quiet.status, 'empty');
  assert.deepEqual(quiet.items, []);
  const paraphrase = await recallMemlayer(settings, 'work_example', undefined, async url => {
    assert.equal(url.searchParams.get('semantic_q'), '先亮出样品行吗');
    const project = url.searchParams.get('project');
    return Response.json({ ok: true, facts: project === 'work_example' ? [
      { ...older, project, match: 'local-semantic', subject: 'author-note', tags: ['human-approved'] },
      { ...older, project: 'work_foreign', match: 'local-semantic' },
      { ...older, project, status: 'retracted', match: 'local-semantic' },
      { ...older, project, id: 'f_unmarked', text: '与本轮问题无关的旧记录' },
    ] : [] });
  }, '先亮出样品行吗 商品稿', '先亮出样品行吗');
  assert.equal(paraphrase.items.length, 1);
  assert.equal(paraphrase.items[0].kind, 'author-preference');
  assert.equal(paraphrase.items[0].match, 'local-semantic');
  assert.throws(() => validateMemlayer({ enabled: true, baseUrl: 'https://remote.example' }));
  assert.throws(() => validateMemlayer({ enabled: true, sharedProject: 'work_foreign' }));
});
