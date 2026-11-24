import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../core/workspace.mjs';
import { configure, fixture } from './helpers.mjs';

const folder = '05-剧本/_本地协作/';
const materials = [
  ['90_第三章_全量材料.md', 'reference', 'reference', null, '全量材料'],
  ['91_第三章_初稿_渡口.md', 'draft', 'draft', 3, '初稿'],
  ['92_第三章_违规清单.md', 'reference', 'review', null, '违规清单'],
  ['93_第三章_改后稿_渡口.md', 'draft', 'draft', 3, '改后稿'],
  ['94_第三章_改后稿复核清单.md', 'reference', 'review', null, '改后稿复核'],
  ['95_第四章_剧情设计_初稿.md', 'plan', 'design', null, '剧情设计'],
  ['96_第五章_题材尚未标注.md', 'reference', 'reference', null, '章节参考'],
];

test('chapter planning adopts the matching design excerpt and suspends hidden references across entry points', async t => {
  let received;
  const f = await fixture('design-to-planning', { fetcher: async (_url, request) => {
    const content = JSON.parse(request.body).messages.findLast(row => row.role === 'user').content;
    received = JSON.parse(typeof content === 'string' ? content : content.map(part => part.text).join(''));
    return Response.json({ choices: [{ message: { content: '建议按东岸的安排展开。' }, finish_reason: 'stop' }] });
  } });
  t.after(f.close);
  const workspace = f.workspace;
  await configure(workspace);
  const file = folder + '95_第四章_剧情设计_初稿.md';
  const rules = folder + '92_第四章_全量材料.md';
  await f.write(file, '# 东岸安排\n\n本章在东岸相见。');
  await f.write(rules, '# 定点测试资料\n\n先前的工作包。');
  await workspace.refresh();
  const materials = workspace.documents.find(d => d.path === rules);
  const design = workspace.documents.find(d => d.path === file);
  const documentId = 'outline_chapter_4';
  let task = await workspace.createCreativeTask({ kind: 'next', documentId });
  task = await workspace.saveCreativeTask({ id: task.id, expectedHash: task.taskHash, referenceIds: [materials.id] });
  const input = { documentId, taskId: task.id, message: '讨论本章路线。' };
  const get = () => workspace.getWritingContext(input);
  assert.ok((await get()).sections.some(row => row.path === file && /东岸相见/u.test(row.excerpt)));
  assert.ok((await get()).sections.some(row => row.path === rules));
  await workspace.setChapterMaterialVisibility({ documentId: materials.id, hidden: true });
  assert.ok(!(await get()).sections.some(row => row.path === rules));
  const source = await workspace.getCowriting({ documentId, taskId: task.id });
  const run = await workspace.sendCowriting({ ...input, sourceHash: source.sourceHash,
    reference: { kind: 'document', id: design.id, hash: design.hash } });
  assert.equal(run.status, 'completed', run.error);
  assert.equal(received.activeSource.discussionSource.path, file);
  assert.deepEqual(received.activeSource.task.references, []);
  assert.equal(await f.read(rules), '# 定点测试资料\n\n先前的工作包。');
});

test('reopens old collaboration indexes with corrected roles, stable document IDs and distinct chapter drafts', async t => {
  const f = await fixture('chapter-materials-upgrade');
  const projectFile = '_创作管理/project.json';
  let workspace = f.workspace;
  t.after(() => workspace.close());
  for (const [name] of materials) await f.write(folder + name, '# 架空验收材料\n\n作用域样例。\n');
  await f.write(folder + '01_文风卡.md', '# 文风卡\n\n作者维护的写作约定。\n');
  await f.write(folder + '88_第三章_写作规则_初稿示例.md', '# 本章写作规则\n\n仅用作规则举例。\n');
  await workspace.refresh();
  const before = new Map(workspace.documents.map(d => [d.path, d]));
  await workspace.close();

  const registered = JSON.parse(await f.read(projectFile));
  for (const [name] of materials) {
    const doc = registered.documents[folder + name];
    doc.kind = name.includes('初稿') ? 'draft' : 'rule';
    doc.chapter = doc.kind === 'draft' ? (name.includes('第四章') ? 4 : 3) : null;
    delete doc.chapterMaterial;
  }
  await f.write(projectFile, JSON.stringify(registered, null, 2));
  workspace = new Workspace(f.root);
  await workspace.init();
  for (const [name, kind, role, chapter, label] of materials) {
    const source = folder + name;
    const doc = workspace.documents.find(d => d.path === source);
    assert.equal(doc.kind, kind);
    assert.equal(doc.chapter, chapter);
    assert.equal(doc.chapterMaterial.role, role);
    assert.equal(doc.chapterMaterial.label, label);
    assert.equal(doc.id, before.get(source).id);
    assert.equal(doc.hash, before.get(source).hash);
  }
  assert.equal(workspace.documents.find(d => d.path === folder + '01_文风卡.md').kind, 'rule');
  assert.equal(workspace.documents.find(d => d.path === folder + '88_第三章_写作规则_初稿示例.md').kind, 'rule');
  const design = workspace.documents.find(d => d.kind === 'plan' && d.chapterMaterial?.chapter === 4);
  await assert.rejects(workspace.confirmRevision({ documentId: design.id, sourceHash: design.hash, kind: 'prose' }),
    { code: 'VALIDATION' });
  assert.deepEqual(workspace.project.approvals, registered.approvals);

});

test('existing active manuscript confirmations take precedence over a revised filing convention', async t => {
  const f = await fixture('chapter-materials-confirmed');
  const projectFile = '_创作管理/project.json';
  const file = folder + '120_第三章_剧情设计_初稿.md';
  let workspace = f.workspace;
  t.after(() => workspace.close());
  await f.write(file, '# 第三章渡口\n\n阿青在岸边等来人。\n');
  await workspace.refresh();
  const doc = workspace.documents.find(d => d.path === file);
  await workspace.close();
  const project = JSON.parse(await f.read(projectFile));
  project.documents[file].kind = 'draft';
  project.documents[file].chapter = 3;
  delete project.documents[file].chapterMaterial;
  project.approvals.push({ id: 'approval_legacy_prose', documentId: doc.id, kind: 'prose', status: 'active',
    sourceHash: doc.hash, sceneId: null, author: '作者', confirmed_at: '2026-11-12T00:00:00.000Z' });
  await f.write(projectFile, JSON.stringify(project, null, 2));

  workspace = new Workspace(f.root);
  await workspace.init();
  const current = workspace.doc(doc.id);
  assert.equal(current.kind, 'draft');
  assert.equal(current.chapter, 3);
  assert.equal(current.hash, doc.hash);
  assert.equal(workspace.summary().documents.find(row => row.id === doc.id).status, 'confirmed');
  assert.deepEqual(workspace.project.approvals, project.approvals);
});
