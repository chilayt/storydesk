import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../core/workspace.mjs';
import { SOURCE_ROUTE_FILE } from '../core/source-lifecycle.mjs';
import { confirmFirst, fixture } from './helpers.mjs';

const find = (workspace, relative) => workspace.documents.find(document => document.path === relative);
const remove = (fixture, relative) => fs.unlink(path.join(fixture.root, relative));
const plan = (fixture, entries) => fixture.write(SOURCE_ROUTE_FILE, JSON.stringify({ version: 1, entries }));

test('a declared move reconnects a changed file under its original ID and keeps the old approved version', async t => {
  const f = await fixture('source-move-declared');
  let ws = f.workspace;
  t.after(() => ws.close());
  const old = ws.documents.find(doc => doc.chapter === 1);
  const original = await f.read(old.path);
  await confirmFirst(ws);
  const approvals = structuredClone(ws.project.approvals);
  await remove(f, old.path);
  await ws.refresh();
  assert.equal(ws.project.externalChanges[old.id].missing, true);

  const target = '工作稿/改过章名的稿件.md';
  const revised = original + '\n补写了一句。\n';
  await f.write(target, revised);
  await plan(f, [{ action: 'move', from: old.path, to: target, reason: '整理时更换目录' }]);
  await ws.close();
  ws = new Workspace(f.root);
  await ws.init();
  assert.equal(ws.doc(old.id).path, target);
  assert.equal(ws.doc(old.id).chapter, 1);
  assert.equal(ws.chapterStatus(ws.doc(old.id)), 'revising');
  assert.equal(ws.project.externalChanges[old.id].path, target);
  assert.equal(ws.project.externalChanges[old.id].missing, undefined);
  assert.deepEqual(ws.project.approvals, approvals);
  const [move] = ws.project.sourceHistory.moves;
  assert.equal(move.from, old.path);
  assert.equal((await ws.readSourceHistory({ documentId: old.id, moveId: move.id })).text, original);
  assert.equal((await ws.readDocument(old.id)).text, revised);
  await ws.refresh();
  assert.equal(ws.project.sourceHistory.moves.length, 1);
  assert.equal(await f.read(target), revised);
});

test('a unique byte-identical rename restores a previously missing ID, while duplicate candidates stay unresolved', async t => {
  const f = await fixture('source-rename');
  const ws = f.workspace;
  t.after(f.close);
  const old = ws.documents.find(doc => doc.chapter === 1);
  const duplicated = ws.documents.find(doc => doc.chapter === 2);
  const one = await f.read(old.path), two = await f.read(duplicated.path);
  await confirmFirst(ws);
  await remove(f, old.path);
  await remove(f, duplicated.path);
  await ws.refresh();
  const live = '05-剧本/正文/新文件名.md', dup1 = '资料/重复一.md', dup2 = '资料/重复二.md';
  await f.write(live, one);
  await f.write(dup1, two);
  await f.write(dup2, two);
  await ws.refresh();
  assert.equal(ws.doc(old.id).path, live);
  assert.equal(ws.doc(old.id).chapter, 1);
  assert.equal(ws.chapterStatus(ws.doc(old.id)), 'confirmed');
  assert.equal(ws.project.externalChanges[old.id], undefined);
  assert.equal(ws.project.externalChanges[duplicated.id].missing, true);
  assert.notEqual(find(ws, dup1).id, find(ws, dup2).id);
  assert.notEqual(find(ws, dup1).id, duplicated.id);
  assert.notEqual(find(ws, dup2).id, duplicated.id);
});

test('retirement keeps the original evidence without a missing warning or active source entry', async t => {
  const f = await fixture('source-retire');
  const ws = f.workspace;
  t.after(f.close);
  const old = ws.documents.find(doc => doc.chapter === 1);
  const archivePath = '90-历史归档/旧稿.md';
  const unknownPath = '04-空间/尚无去向.html';
  const oldMapPath = '04-空间/旧图.html';
  const original = await f.read(old.path);
  await f.write(unknownPath, '<p>尚无去向</p>');
  await f.write(oldMapPath, '<p>测试旧图</p>');
  await ws.refresh();
  const unknown = find(ws, unknownPath), oldMap = find(ws, oldMapPath);
  await ws.confirmAppearance({
    entityId: ws.project.characters[0].id, documentId: old.id, sourceHash: old.hash,
    quote: '阿青在渡口遇见沈舟。', type: 'mention'
  });
  await remove(f, unknownPath);
  await remove(f, oldMapPath);
  await fs.mkdir(path.join(f.root, '90-历史归档'));
  await fs.rename(path.join(f.root, old.path), path.join(f.root, archivePath));
  await plan(f, [
    { action: 'retire', from: old.path, archivePath, reason: '旧稿归档' },
    { action: 'retire', from: oldMapPath, reason: '地图已经换版', evidencePath: '00-项目导航/来源去向.json' }
  ]);
  await ws.refresh();
  assert.equal(ws.project.externalChanges[unknown.id].missing, true);
  assert.equal(ws.project.externalChanges[old.id], undefined);
  assert.equal(ws.project.externalChanges[oldMap.id], undefined);
  assert.ok(!find(ws, old.path) && !find(ws, archivePath));
  assert.equal(ws.events[0].sourceRetired, true);
  assert.equal(ws.events[0].stale_reason, '来源已退役，可查原确认版本');
  assert.equal(ws.visibleFacts(null, { currentOnly: true }).length, 0);
  assert.equal(ws.visibleFacts().length, 1);
  const historical = await ws.readDocument(old.id);
  assert.equal(historical.readOnly, true);
  assert.equal(historical.text, original);
  assert.equal(await ws.registeredSourcePath(old.id), path.join(f.root, archivePath));
  const mapHistory = await ws.readSourceHistory({ documentId: oldMap.id });
  assert.equal(mapHistory.path, oldMapPath);
  assert.equal(mapHistory.snapshotAvailable, false);
  assert.equal(mapHistory.evidencePath, '00-项目导航/来源去向.json');
  await ws.refresh();
  assert.equal(Object.keys(ws.project.sourceHistory.retired).length, 2);
});

test('manual source review refuses occupied or outside paths and can undo a new registration', async t => {
  const f = await fixture('source-manual-review');
  const ws = f.workspace;
  t.after(f.close);
  const old = ws.documents.find(doc => doc.chapter === 1);
  const other = ws.documents.find(doc => doc.chapter === 2);
  const original = await f.read(old.path);
  const target = '搬迁未接入/新位置.md';
  await f.write(target, original);
  await remove(f, old.path);
  await ws.refresh();
  for (const [to, code] of [[other.path, 'CONFLICT'], ['../外部.md', 'PATH'], ['资料/不存在.md', 'NOT_FOUND']]) {
    await assert.rejects(ws.resolveMissingSource({ documentId: old.id, action: 'move', to }), error => error.code === code);
  }
  assert.equal(ws.project.externalChanges[old.id].missing, true);
  const moved = await ws.resolveMissingSource({ documentId: old.id, action: 'move', to: target });
  assert.equal(ws.doc(old.id).path, target);
  assert.equal(ws.project.externalChanges[old.id], undefined);
  await ws.undoBatch(moved.id);
  assert.equal(ws.project.externalChanges[old.id].missing, true);
  assert.equal(await f.read(target), original);
  const retired = await ws.resolveMissingSource({ documentId: old.id, action: 'retire', reason: '作者暂存旧稿' });
  assert.equal(ws.project.externalChanges[old.id], undefined);
  assert.equal((await ws.readDocument(old.id)).text, original);
  await ws.undoBatch(retired.id);
  assert.equal(ws.project.externalChanges[old.id].missing, true);
});
