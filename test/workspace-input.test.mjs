import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../core/workspace.mjs';
import { fixture } from './helpers.mjs';

test('unsent writing input survives reopening without creating a manuscript or confirmation', async t => {
  const f = await fixture('workspace-input');
  const input = { documentId: 'outline_chapter_3', text: '还没发送：本章先讨论人物动机。' };
  await f.workspace.saveCowritingInput(input);
  const first = await f.workspace.getCowriting(input); assert.equal(first.composer.text, input.text);
  await f.close();
  const reopened = new Workspace(f.root); await reopened.init(); t.after(() => reopened.close());
  const restored = await reopened.getCowriting(input);
  assert.equal(restored.composer.text, input.text); assert.equal(restored.messages.length, 0);
  assert.equal(restored.outlineText, ''); assert.equal(reopened.project.approvals.length, 0);
  await reopened.saveCowritingInput({ ...input, text: '' });
  assert.equal((await reopened.getCowriting(input)).composer.text, '');
});

test('input is scoped to work, task and scene instead of leaking into another conversation', async t => {
  const f = await fixture('workspace-task-input'), g = await fixture('workspace-other-input');
  t.after(() => f.close()); t.after(() => g.close());
  const doc = f.workspace.documents.find(d => d.kind === 'chapter' && d.chapter === 2);
  const task = await f.workspace.createCreativeTask({ kind: 'chapter', documentId: doc.id });
  const taskInput = { documentId: doc.id, taskId: task.id, text: '这份要求只留在本任务。' };
  await f.workspace.saveCowritingInput(taskInput);
  assert.equal((await f.workspace.getCowriting(taskInput)).composer.text, taskInput.text);
  assert.equal((await f.workspace.getCowriting({ documentId: doc.id })).composer.text, '');
  assert.equal((await f.workspace.getCowriting({ documentId: doc.id, sceneId: 'whole' })).composer.text, '');
  await assert.rejects(g.workspace.saveCowritingInput(taskInput), e => ['NOT_FOUND', 'VALIDATION'].includes(e.code));
});

test('damaged or foreign recovery input is kept for diagnosis and never silently overwritten', async t => {
  const f = await fixture('workspace-input-damaged'); t.after(() => f.close());
  const path = '_创作管理/共写输入/cowrite_outline_chapter_3.ending.json';
  const foreign = JSON.stringify({ schema: 1, workId: 'work_foreign', documentId: 'outline_chapter_3', sceneId: null, taskId: null, text: '别的作品' });
  await f.write(path, foreign);
  await assert.rejects(f.workspace.getCowriting({ documentId: 'outline_chapter_3' }), e => e.code === 'DAMAGED_DATA');
  await assert.rejects(f.workspace.saveCowritingInput({ documentId: 'outline_chapter_3', text: '覆盖' }), e => e.code === 'DAMAGED_DATA');
  assert.equal(await f.read(path), foreign);
  await assert.rejects(f.workspace.saveCowritingInput({ documentId: '../../escape', text: '越界' }), e => e.code === 'VALIDATION');
});
