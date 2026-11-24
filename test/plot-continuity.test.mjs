import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../core/workspace.mjs';
import { fixture, configure, waitJob } from './helpers.mjs';

const chapterText = '# 第二章　归城\n\n阿青到了北城。\n\n阿青信任沈舟，两人结伴。\n\n沈舟交给阿青半边青铜印。\n';
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const activeSource = messages => {
  const content = messages.at(-1).content;
  return JSON.parse(typeof content === 'string' ? content : content.find(block => block.type === 'text').text).activeSource;
};

test('章节资料经作者核对后本地生效，下一章采用新状态、关系、事件、伏笔和适用的已定卷纲', async t => {
  const conversations = [];
  let aiDraft, reply = '旧会话的城名是青河，尚待核对。';
  const fetcher = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.stream) {
      conversations.push(body.messages);
      return response({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { total_tokens: 50 } });
    }
    return response({ choices: [{ message: { content: JSON.stringify(aiDraft) }, finish_reason: 'stop' }], usage: { total_tokens: 250 } });
  };
  const f = await fixture('plot-continuity', { fetcher });
  let w = f.workspace;
  t.after(() => w.close());
  await configure(w);
  const a = w.project.characters.find(c => c.name === '阿青');
  const b = w.project.characters.find(c => c.name === '沈舟');
  await w.updateField({ entityId: a.id, field: 'location', value: '青河', chapter: 1 });
  const hook = await w.saveRecord({ kind: 'hook', title: '青铜印来历', status: 'planned', body: '作者保留的备注' });
  await f.write('05-剧本/正文/第02章_北城.md', chapterText);
  await w.refresh();
  const chapter = w.documents.find(d => d.chapter === 2 && d.kind === 'chapter');
  const draftOutline = await w.getCowriting({ documentId: 'outline_volume_1' });
  const volume = await w.saveWritingOutline({ documentId: draftOutline.documentId, expectedHash: draftOutline.sourceHash, text: '第三章，阿青引荐沈舟去查漕运账簿。' });
  aiDraft = { events: [{
    title: '入城候选标题', summary: '阿青进了北城，与沈舟结伴。', layer: 'occurred', evidence_span_id: 'p2',
    facts: [
      { entity_id: a.id, field: 'location', value: '北城', layer: 'occurred', certainty: 'explicit', evidence_span_id: 'p2' },
      { entity_id: a.id, field: 'relationship', value: { otherId: b.id, type: '同行', attitude: '信任' }, layer: 'occurred', certainty: 'explicit', evidence_span_id: 'p3' },
    ],
    hooks: [{ hook_id: hook.id, title: hook.title, status: 'introduced', summary: '沈舟交出半边青铜印。', evidence_span_id: 'p4' }],
  }] };
  await w.checksFor({ documentId: chapter.id });
  const { job } = await w.confirmRevision({ documentId: chapter.id, sourceHash: chapter.hash, reviewPlot: true });
  const staged = await waitJob(w, job.id);
  assert.equal(staged.status, 'partial');
  assert.equal(staged.pending, 4);
  const [event, hookReview] = w.project.chapterReviews;
  assert.equal(await w.store.read(`_创作管理/事件/${event.eventId}.md`), null);
  assert.equal((await w.getCharacter(a.id)).current.location.value, '青河');
  assert.equal(w.relationships().length, 0);
  assert.equal(w.records.find(r => r.id === hook.id).status, 'planned');
  const first = await w.getCowriting({ documentId: 'outline_chapter_3' });
  const before = await w.sendCowriting({ documentId: first.documentId, sourceHash: first.sourceHash, message: '讨论阿青下一章的入城情节。' });
  assert.equal(before.status, 'completed', before.error);
  const initial = activeSource(conversations[0]);
  assert.doesNotMatch(JSON.stringify(initial.continuity), /入城候选标题|半边青铜印/);
  assert.equal(initial.previousEnding.status, '正文已确认，资料变化待核对');
  assert.doesNotMatch(JSON.stringify(initial.outlines), /漕运账簿/);
  const acceptEvent = { id: event.id, expectedRevision: event.revision, accept: true, title: '北城结伴',
    summary: '阿青抵达北城并与沈舟结伴。', layer: 'occurred' };
  await assert.rejects(w.decideChapterReview({ ...acceptEvent, evidenceQuote: '雨夜登船。' }), { code: 'EVIDENCE' });
  await assert.rejects(w.decideChapterReview({ id: hookReview.id, expectedRevision: 0, accept: true }), { code: 'VALIDATION' });
  await w.decideChapterReview(acceptEvent);
  assert.match(await f.read(`_创作管理/事件/${event.eventId}.md`), /北城结伴/);
  assert.equal((await w.getCharacter(a.id)).current.location.value, '青河');
  for (const p of w.project.proposals.filter(p => p.jobId === job.id)) {
    await w.resolveProposal({ proposalId: p.id, resolution: 'accept', expectedRevision: p.revision });
  }
  await assert.rejects(w.decideChapterReview({ id: hookReview.id, expectedRevision: 0, accept: true, title: hook.title,
    summary: hookReview.summary, hookId: hook.id, hookRevision: hook.revision + 1, hookStatus: 'introduced' }), { code: 'CONFLICT' });
  await w.decideChapterReview({ id: hookReview.id, expectedRevision: 0, accept: true, title: hook.title,
    summary: '半边青铜印由沈舟交给阿青。', hookId: hook.id, hookRevision: hook.revision, hookStatus: 'introduced' });
  await w.confirmVolumeOutline({ documentId: volume.id, expectedHash: volume.hash, fromChapter: 1, toChapter: 4 });
  assert.equal((await w.getCharacter(a.id)).current.location.value, '北城');
  assert.equal(w.relationships()[0].attitude, '信任');
  assert.equal(w.project.jobs.find(row => row.id === job.id).status, 'completed');
  assert.match(await f.read(`_创作管理/资料/${hook.id}.md`), /作者保留的备注[\s\S]+半边青铜印由沈舟交给阿青/);
  assert.match(await f.read('_创作管理/事件索引.md'), /北城结伴/);
  assert.match(await f.read('_创作管理/关系/关系索引.md'), /信任/);

  await w.close();
  w = new Workspace(f.root, { fetcher });
  await w.init();
  reply = '阿青已进北城，与沈舟同行，可先循卷纲查漕运账簿。';
  const after = await w.sendCowriting({ documentId: first.documentId, sourceHash: first.sourceHash, message: '核对阿青现状、与沈舟的关系、伏笔和卷纲。' });
  assert.equal(after.status, 'completed', after.error);
  const messages = conversations[1], input = activeSource(messages);
  assert.equal(input.continuity.characters.find(c => c.name === '阿青').priorFacts.find(f => f.field === 'location').value, '北城');
  assert.ok(input.continuity.characters.some(c => c.priorFacts.some(f => f.field === 'relationship' && f.value.includes('信任'))));
  assert.ok(input.continuity.events.some(e => e.title === '北城结伴'));
  assert.equal(input.continuity.hooks.find(h => h.title === hook.title).status, 'introduced');
  assert.match(input.outlines.find(o => o.status === '作者已定卷纲').excerpt, /漕运账簿/);
  assert.ok(!messages.some(m => m.role === 'assistant' && String(m.content).includes('旧会话')));

  const revised = w.documents.find(d => d.id === chapter.id);
  await w.saveDocument({ documentId: revised.id, expectedHash: revised.hash, text: '# 第二章　改稿\n\n阿青留在山道。\n' });
  const stale = await w.sendCowriting({ documentId: first.documentId, sourceHash: first.sourceHash, message: '核对阿青和伏笔。' });
  assert.equal(stale.status, 'completed', stale.error);
  const latest = activeSource(conversations[2]);
  assert.ok(!latest.continuity.events.some(e => e.title === '北城结伴'));
  assert.ok(!latest.continuity.hooks.some(h => h.title === hook.title));
});
