import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../core/workspace.mjs';
import { findWritingOutline } from '../core/cowriting-context.mjs';
import { decode, hash } from '../core/io.mjs';
import { stagePlans } from '../core/stage-plans.mjs';
import { manifestIsStale } from '../core/writing-manifest.mjs';
import { fixture } from './helpers.mjs';
import { importTextDocuments } from '../core/text-import.mjs';

test('imported text can become a distinct chapter draft and cleanup protects current versions', async t => {
  const f = await fixture('chapter-import-cleanup');
  const ws = f.workspace;
  t.after(f.close);
  const first = '# 第二十四章　入窟\n\n供比较的第一稿。\n';
  const second = '# 第二十四章　入窟\n\n作者考虑的新稿。\n';
  const [original, alternative] = await importTextDocuments(ws, [
    { title: '收到的草稿', text: first }, { title: '收到的草稿', text: second },
  ]);
  assert.equal(ws.doc(original.id).draftChapterHint, 24);
  assert.equal(ws.doc(original.id).chapter, null);
  assert.ok(ws.doc(alternative.id).importOrder > ws.doc(original.id).importOrder);
  assert.ok(ws.doc(original.id).importedAt);
  const copy = source => ws.createChapterDraft({ chapter: 24, title: '入窟', sourceDocumentId: source.id, expectedSourceHash: source.hash });
  const oldDraft = await copy(original);
  const keep = await copy(alternative);
  assert.equal((await copy(alternative)).id, keep.id);
  assert.match(keep.path, /入窟（2）\.md$/u);
  assert.equal(await f.read(keep.path), second);
  assert.ok(!ws.documents.some(doc => doc.kind === 'chapter' && doc.chapter === 24));
  const cleanup = hash => ws.hideOtherChapterDrafts({ keeperId: keep.id, keeperHash: keep.hash, drafts: [{ id: oldDraft.id, hash }] });
  await assert.rejects(cleanup('old revision'), { code: 'CONFLICT' });
  assert.ok(!ws.project.hiddenChapterMaterials?.includes(oldDraft.id));
  await cleanup(oldDraft.hash);
  assert.ok(ws.project.hiddenChapterMaterials.includes(oldDraft.id));
  assert.ok(!ws.project.hiddenChapterMaterials.includes(keep.id));
  assert.equal(await f.read(oldDraft.path), first);
  assert.equal(await f.read(original.path), first);
  await ws.setChapterMaterialVisibility({ documentId: oldDraft.id, hidden: false });
  assert.ok(!ws.project.hiddenChapterMaterials.includes(oldDraft.id));
});

test('publication binds the checked draft bytes to a formal chapter and keeps the draft identity and alternatives', async t => {
  const f = await fixture('chapter-publication');
  let ws = f.workspace;
  t.after(() => ws.close());
  const drafts = '05-剧本/_本地协作/';
  const old = drafts + '96_第二十三章_初稿_长安.md';
  const revised = drafts + '98_第二十三章_改后稿_长安.md';
  const design = drafts + '101_第二十四章_剧情设计_初稿.md';
  const canonical = '05-剧本/正文/第23章_长安.md';
  await f.write('05-剧本/正文/第22章_前事.md', '# 第22章　前事\n\n较早的正文文件。\n');
  await f.write(old, '# 第二十三章　长安\n\n供比较的初稿。\n');
  await f.write(revised, '# 第二十三章　长安\n\n此处是作者修改过的稿件。\n');
  await f.write(design, '# 第二十四章 · 剧情设计\n\n下一章的待确认安排。\n');
  await ws.refresh();
  const doc = ws.documents.find(d => d.path === revised);
  const alternative = ws.documents.find(d => d.path === old);
  assert.equal(ws.summary().nextChapter, 23);
  await assert.rejects(ws.confirmRevision({ documentId: doc.id, sourceHash: doc.hash, publishDraft: true }), { code: 'NEEDS_GATE' });
  assert.equal(await ws.store.read(canonical), null);
  await ws.checksFor({ documentId: doc.id });
  const publication = await ws.confirmRevision({ documentId: doc.id, sourceHash: doc.hash, publishDraft: true });
  assert.equal(ws.doc(doc.id).path, canonical);
  assert.equal(ws.doc(doc.id).kind, 'chapter');
  assert.equal(ws.chapterStatus(ws.doc(doc.id)), 'confirmed');
  assert.equal(ws.doc(alternative.id).kind, 'draft');
  assert.equal(await f.read(canonical), await f.read(revised));
  assert.equal(publication.job.reviewPlot, true);
  assert.equal(ws.summary().nextChapter, 24);
  const again = await ws.confirmRevision({ documentId: doc.id, sourceHash: doc.hash, publishDraft: true });
  assert.equal(again.approval.id, publication.approval.id);
  assert.equal(ws.project.jobs.length, 1);
  await ws.checksFor({ documentId: alternative.id });
  await assert.rejects(ws.confirmRevision({ documentId: alternative.id, sourceHash: alternative.hash, publishDraft: true }), { code: 'CONFLICT' });
  await ws.close();
  ws = new Workspace(f.root); await ws.init();
  assert.equal(ws.doc(doc.id).path, canonical);
  assert.equal(ws.summary().nextChapter, 24);
  const next = await ws.getWritingContext({ documentId: 'outline_chapter_24' });
  assert.ok(next.sections.some(s => s.kind === 'previous' && s.path === canonical && s.status.includes('已确认')));
  assert.ok(next.sections.some(s => s.kind === 'outline' && s.path === design && s.status.includes('待确认')));
  const earlier = await ws.getWritingContext({ documentId: 'outline_chapter_20' });
  assert.ok(!earlier.sections.some(s => s.path === canonical || s.path === design || s.path.includes('第22章')));
  assert.notEqual(earlier.signature, next.signature);
});

test('new AI writing targets start as a draft file and become eligible for publication only after saving and checking', async t => {
  const f = await fixture('draft-creation');
  const ws = f.workspace;
  t.after(f.close);
  const doc = await ws.createChapterDraft({ chapter: 3, title: '渡船' });
  assert.match(doc.path, /\/草稿章节\/第03章_渡船[.]md$/);
  assert.equal(doc.kind, 'draft');
  await ws.checksFor({ documentId: doc.id });
  await assert.rejects(ws.confirmRevision({ documentId: doc.id, sourceHash: doc.hash, publishDraft: true }), { code: 'VALIDATION' });
  const text = '# 第03章　渡船\n\n阿青走近渡口。\n';
  const edited = await ws.saveDocument({ documentId: doc.id, expectedHash: doc.hash, text });
  assert.equal(edited.document.kind, 'draft');
  assert.equal(await f.read(doc.path), text);
  assert.equal(await ws.store.read('05-剧本/正文/第03章_渡船.md'), null);
  await assert.rejects(ws.confirmRevision({ documentId: doc.id, sourceHash: edited.document.hash, publishDraft: true }), { code: 'NEEDS_GATE' });
  await ws.checksFor({ documentId: doc.id });
  await ws.confirmRevision({ documentId: doc.id, sourceHash: edited.document.hash, publishDraft: true });
  const batch = (await ws.store.history()).find(item => item.label === '发布草稿为正文');
  await ws.undoBatch(batch.id);
  assert.equal(ws.doc(doc.id).kind, 'draft');
  assert.equal(await f.read(doc.path), text);
  assert.equal(await ws.store.read('05-剧本/正文/第03章_渡船.md'), null);
});

test('stage progress uses approved events before the target chapter and can apply a confirmed change to the local plan', async t => {
  const f = await fixture('chapter-stage-progress');
  const ws = f.workspace;
  t.after(f.close);
  const doc = ws.documents.find(d => d.chapter === 1);
  await ws.confirmAppearance({ entityId: ws.project.characters[0].id, documentId: doc.id, sourceHash: doc.hash,
    quote: '阿青在渡口遇见沈舟。', type: 'mention' });
  const actual = ws.events[0];
  const milestones = [
    { id: 'complete', title: actual.title, chapter: 1 },
    { id: 'later', title: '后续进城', chapter: 3 },
    { id: 'moved', title: '计划第二章相遇', chapter: 2, eventId: actual.id },
    { id: 'conflict', title: '旧安排', chapter: 2, decision: 'conflict', note: '由作者记录冲突' }
  ];
  const plan = await ws.saveRecord({ kind: 'plot_arc', title: '渡口阶段', body: '相遇与进城', status: 'active',
    details: { fromChapter: 1, toChapter: 4, milestones } });
  assert.deepEqual(stagePlans(ws, 2)[0].nodes.map(node => node.state), ['completed', 'pending', 'changed', 'conflict']);
  assert.ok(!stagePlans(ws, 1)[0].nodes.some(node => node.event));
  assert.equal(stagePlans(ws, 5).length, 0);
  const manifest = await ws.getWritingContext({ documentId: 'outline_chapter_2' });
  assert.ok(manifest.sections.some(s => s.kind === 'stage' && s.path.includes(plan.id) && s.excerpt.includes('安排有变动')));
  await ws.saveRecord({ ...plan, expectedRevision: plan.revision, details: { ...plan.details,
    milestones: milestones.map(node => node.id === 'moved' ? { ...node, title: actual.title, chapter: 1, decision: 'adopted' } : node)
  } });
  assert.equal(stagePlans(ws, 2)[0].nodes[2].state, 'completed');
  assert.match(await f.read('_创作管理/资料/' + plan.id + '.md'), /"decision": "adopted"/);
});

test('an author selects one bound chapter design, preserving draft edits and neighboring chapter context', async t => {
  const f = await fixture('chapter-outline-approval');
  let ws = f.workspace;
  t.after(() => ws.close());
  const imported = '05-剧本/_本地协作/101_第二十四章_剧情设计_初稿.md';
  const designText = '# 第二十四章 · 工作稿\n\n' + '开场安排。'.repeat(300) + '\n\n结尾独特标记。\n';
  await f.write(imported, designText);
  await ws.refresh();
  const previous = await ws.getCowriting({ documentId: 'outline_chapter_20' });
  const chapter20 = await ws.saveWritingOutline({ documentId: 'outline_chapter_20', expectedHash: previous.sourceHash, text: '前章独有安排。' });
  assert.equal(chapter20.chapterMaterial.chapter, 20);
  const empty = await ws.getCowriting({ documentId: 'outline_chapter_24' });
  const chapter24 = await ws.saveWritingOutline({ documentId: 'outline_chapter_24', expectedHash: empty.sourceHash, text: '待定的另一方案。' });
  const design = ws.documents.find(d => d.path === imported);
  const oldContext = await ws.getWritingContext({ documentId: 'outline_chapter_24' });
  const unrelated = await ws.getWritingContext({ documentId: 'outline_chapter_20' });
  assert.ok(oldContext.sections.some(section => section.path === imported && section.status.includes('待确认')));
  assert.ok(!oldContext.sections.some(section => section.path === chapter20.path));

  const approval = await ws.confirmChapterOutline({ documentId: design.id, expectedHash: design.hash });
  assert.equal(approval.chapter, 24);
  assert.equal(ws.project.jobs.length, 0);
  assert.equal(ws.events.length, 0);
  assert.equal(await f.read(imported), designText);
  assert.equal((await ws.confirmChapterOutline({ documentId: design.id, expectedHash: design.hash })).id, approval.id);
  assert.equal(await manifestIsStale(ws, oldContext), true);
  assert.equal(await manifestIsStale(ws, unrelated), false);
  const current = await ws.getWritingContext({ documentId: 'outline_chapter_24' });
  assert.ok(current.sections.some(section => section.path === imported && section.status === '作者已定章纲 · 计划'));
  assert.ok(current.sections.some(section => section.path === chapter24.path && section.status.includes('待确认')));
  assert.equal(ws.summary().documents.find(d => d.id === design.id).status, 'confirmed');

  const readPinned = async (file, expected) => {
    const bytes = await ws.store.read(file);
    assert.equal(hash(bytes), expected);
    return decode(bytes).text;
  };
  const [start] = await findWritingOutline(ws, '工作稿', readPinned, 24);
  const [end] = await findWritingOutline(ws, '工作稿', readPinned, 24, start.nextOffset);
  assert.match(end.excerpt, /结尾独特标记/);
  assert.equal(end.nextOffset, null);
  assert.deepEqual(await findWritingOutline(ws, '第20章章纲', readPinned, 24), []);
  assert.deepEqual(await findWritingOutline(ws, '工作稿', readPinned, 20), []);

  await f.write(imported, designText + '改稿待作者裁定。\n');
  await ws.refresh();
  await assert.rejects(ws.confirmChapterOutline({ documentId: design.id, expectedHash: design.hash }), { code: 'CONFLICT' });
  const edited = await ws.getWritingContext({ documentId: 'outline_chapter_24' });
  assert.ok(edited.sections.some(section => section.path === imported && section.status.includes('待重新定案')));
  await ws.setWritingRecovery({ documentId: 'outline_chapter_24', text: '另一轮未保存修改。', baseHash: chapter24.hash });
  await assert.rejects(ws.confirmChapterOutline({ documentId: chapter24.id, expectedHash: chapter24.hash }), { code: 'UNSAVED_DRAFT' });
  await ws.clearDraft('outline_chapter_24');
  const replacement = await ws.confirmChapterOutline({ documentId: chapter24.id, expectedHash: chapter24.hash });
  assert.equal(ws.project.approvals.find(row => row.id === approval.id).status, 'superseded');
  assert.equal((await ws.approvedSource({ approvalId: approval.id })).text, designText);
  assert.ok((await ws.getWritingContext({ documentId: 'outline_chapter_24' })).sections.some(section =>
    section.path === chapter24.path && section.status === '作者已定章纲 · 计划'));
  assert.ok(!(await ws.getWritingContext({ documentId: 'outline_chapter_24' })).sections.some(section => section.path === imported));

  await ws.close();
  ws = new Workspace(f.root);
  await ws.init();
  assert.equal(ws.summary().chapterOutlines.find(row => row.chapter === 24).approvalId, replacement.id);
});
