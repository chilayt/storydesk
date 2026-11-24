import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { parseRecord, recordMarkdown, recordBody } from '../core/catalog.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

test('手改派生视图不会被归档覆盖，可选择人工维护', async t => {
  const f=await fixture('view-protect');t.after(f.close);const ws=f.workspace,c=ws.project.characters[0];
  await ws.updateField({entityId:c.id,field:'location',value:'北城',chapter:1});
  const p=`_创作管理/人物进展/${c.id}.md`;await f.write(p,'# 我的手工笔记\n\n必须保留。\n');
  await ws.refresh();assert.ok(ws.project.externalChanges[`managed:${p}`]);
  await assert.rejects(ws.updateField({entityId:c.id,field:'location',value:'南城',chapter:2}),e=>e.code==='CONFLICT');
  assert.equal(await f.read(p),'# 我的手工笔记\n\n必须保留。\n');
  const diff=await ws.managedDiff({path:p});await ws.acknowledgeManaged({path:p,expectedHash:diff.hash,mode:'protect'});
  await ws.updateField({entityId:c.id,field:'location',value:'南城',chapter:2});
  assert.equal(await f.read(p),'# 我的手工笔记\n\n必须保留。\n');assert.equal((await ws.getCharacter(c.id)).current.location.value,'南城');
});
test('外改事件保持原正式状态，作者采用后字段受保护，正文备注保留', async t => {
  const f=await fixture('event-external');t.after(f.close);const ws=f.workspace,c=ws.project.characters[0];
  await ws.updateField({entityId:c.id,field:'location',value:'北城',chapter:1});const event=ws.events[0],p=`_创作管理/事件/${event.id}.md`;
  const raw=await f.read(p),record=parseRecord(raw);record.facts[0].value='东城';await f.write(p,recordMarkdown(record,'作者手写备注，不能删。'));
  await ws.refresh();assert.equal((await ws.getCharacter(c.id)).current.location.value,'北城');
  const diff=await ws.managedDiff({path:p});await ws.acknowledgeManaged({path:p,expectedHash:diff.hash,mode:'adopt'});
  assert.equal((await ws.getCharacter(c.id)).current.location.value,'东城');assert.ok((await f.read(p)).includes('作者手写备注，不能删。'));
  assert.ok(ws.project.locks.some(l=>l.field==='location'));
});
test('外部事件声称已确认不能自行进入正式状态', async t => {
  const f=await fixture('external-approval');t.after(f.close);const ws=f.workspace,c=ws.project.characters[0];
  const record={id:'event_external',work_id:ws.project.id,approval_id:'approval_forged',title:'外部声称已确认',facts:[{id:'fact_external',entity_id:c.id,field:'location',value:'北城',layer:'occurred',status:'accepted',source_chapter:1,evidence:'外部声称作者同意'}]};
  const p='_创作管理/事件/event_external.md';await f.write(p,recordMarkdown(record,'未经过程序确认'));await ws.refresh();
  assert.equal((await ws.getCharacter(c.id)).current.location,undefined);assert.ok(ws.project.externalChanges[`managed:${p}`]);
});
test('源文件外部移除会标记来源失效，可原位恢复且ID不变',async t=>{
  const f=await fixture('source-missing');t.after(f.close);const ws=f.workspace,c=ws.project.characters[0],d=ws.documents.find(d=>d.chapter===1);
  await ws.confirmAppearance({entityId:c.id,documentId:d.id,sourceHash:d.hash,quote:'阿青在渡口遇见沈舟。',type:'mention'});
  await fs.unlink(path.join(f.root,d.path));await ws.refresh();assert.ok(ws.project.externalChanges[d.id].missing);assert.equal(ws.events[0].stale,true);
  await ws.restoreMissingDocument({documentId:d.id});assert.equal(ws.doc(d.id).path,d.path);assert.equal(ws.events[0].stale,false);
});
