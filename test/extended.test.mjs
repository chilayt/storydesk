import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, modelFetch, configure, confirmFirst, waitJob, chapterText } from './helpers.mjs';
import { validateExtraction } from '../core/analysis.mjs';
import { Workspace } from '../core/workspace.mjs';
import { hash } from '../core/io.mjs';

test('设定性质、适用范围和作者确认写入原档，重启可恢复', async t => {
  const f=await fixture('setting-meta');let ws=f.workspace;t.after(()=>ws.close());
  const d=ws.documents.find(d=>d.kind==='setting');
  await ws.updateSettingMeta({documentId:d.id,expectedHash:d.hash,category:'武学体系',nature:'fiction',scope:'架空世界·本支线',summary:'作者明确采用的能力边界',confirmed:true});
  assert.ok((await f.read(d.path)).includes('不改变容貌'));
  assert.ok((await f.read(d.path)).includes('架空裁定'));
  const approved=ws.project.approvals.find(a=>a.documentId===d.id);assert.equal(approved.sourceHash,ws.doc(d.id).hash);
  await ws.close();ws=new Workspace(f.root);await ws.init();assert.equal(ws.project.settingMeta[d.id].nature,'fiction');
});
test('确认同一身份后，别名不复活为新人，源引用和事件重连', async t => {
  const f=await fixture('merge');t.after(f.close);const ws=f.workspace;
  const source=ws.project.characters.find(c=>c.name==='陆迟'), target=ws.project.characters.find(c=>c.name==='阿青');
  await ws.updateField({entityId:source.id,field:'identity',value:'行商',chapter:1});
  await ws.mergeCharacters({sourceId:source.id,targetId:target.id});
  await ws.refresh();assert.equal(ws.summary().characters.length,2);assert.ok(ws.character(target.id).aliases.includes('陆迟'));
  assert.ok(ws.events.some(e=>e.facts.some(f=>f.entity_id===target.id&&f.value==='行商')));
  assert.equal(ws.summary().characters.filter(c=>c.name==='陆迟').length,0);
});
test('出场、提及与回忆分开；同章提及不能变成正面出场', async t => {
  const f=await fixture('appearance');t.after(f.close);const ws=f.workspace;
  const c=ws.project.characters.find(c=>c.name==='阿青'),d=ws.documents.find(d=>d.chapter===1);
  await ws.confirmAppearance({entityId:c.id,documentId:d.id,sourceHash:d.hash,quote:'阿青在渡口遇见沈舟。',type:'memory'});
  assert.equal((await ws.getCharacter(c.id,1)).firstAppearance,null);
  assert.equal((await ws.getCharacter(c.id)).firstAppearance.source_chapter,2); // Current-text index finds the later chapter independently.
  await ws.confirmAppearance({entityId:c.id,documentId:d.id,sourceHash:d.hash,quote:'阿青在渡口遇见沈舟。',type:'onscreen'});
  assert.equal((await ws.getCharacter(c.id)).firstAppearance.source_chapter,1);
});
test('场景确认只接受其范围内证据', async t => {
  const f=await fixture('scene', {fetcher:modelFetch(({aq})=>[{title:'错误跨场引用',facts:[{entity_id:aq.id,field:'location',value:'北城',layer:'occurred',certainty:'explicit',evidence:'阿青说：“明日去北城。”'}]}])});t.after(f.close);const ws=f.workspace;
  await configure(ws);const d=ws.documents.find(d=>d.chapter===1);const scene=await ws.addScene({documentId:d.id,name:'渡口相遇',quote:'七月廿三，阿青在渡口遇见沈舟。'});
  await ws.checksFor({documentId:d.id});const {job}=await ws.confirmRevision({documentId:d.id,sourceHash:d.hash,sceneId:scene.id});
  const result=await waitJob(ws,job.id);assert.equal(result.status,'partial');assert.equal(ws.visibleFacts().length,0);assert.ok(ws.project.proposals[0].fact.review_reasons.some(r=>r.includes('范围')));
});
test('分析期间正文修改会停止自动归档，保留编辑结果', async t => {
  let release;const gate=new Promise(r=>{release=r;});let requested=false;
  const f=await fixture('source-race',{fetcher:async(...args)=>{requested=true;await gate;return modelFetch()(...args);}});t.after(f.close);const ws=f.workspace;
  await configure(ws);const {job}=await confirmFirst(ws);while(!requested)await new Promise(r=>setTimeout(r,10));
  const d=ws.documents.find(d=>d.chapter===1);await ws.exclusive(()=>ws.saveDocument({documentId:d.id,expectedHash:d.hash,text:chapterText+'\n新的人工修订。\n'}));release();
  const result=await waitJob(ws,job.id);assert.equal(result.status,'superseded');assert.equal(result.versionState,'historical');assert.equal(ws.events.length,0);assert.ok((await f.read(d.path)).includes('新的人工修订'));
});
test('第三版本恢复可保留外部内容，撤回其余未完成写入', async t => {
  const f=await fixture('abandon');t.after(f.close);const s=f.workspace.store;
  await f.write('资料/甲.md','旧甲');await f.write('资料/乙.md','旧乙');
  await assert.rejects(s.batch('中断批次',[{path:'资料/甲.md',expectedHash:hash('旧甲'),text:'新甲'},{path:'资料/乙.md',expectedHash:hash('旧乙'),text:'新乙'}],{afterWrite:i=>{if(i===0)throw new Error('故障');}}));
  await f.write('资料/甲.md','外部版本');const [r]=await s.recover(false);await s.abandonRecovery(r.id);
  assert.equal(await f.read('资料/甲.md'),'外部版本');assert.equal(await f.read('资料/乙.md'),'旧乙');assert.equal((await s.recover(false)).length,0);
});
test('结构化伏笔与势力成员可写入本地记录', async t => {
  const f=await fixture('records');t.after(f.close);const ws=f.workspace;const c=ws.project.characters[0];
  const hook=await ws.saveRecord({kind:'hook',title:'一封信',body:'留待回收',status:'introduced',participants:[c.id],details:{introducedChapter:1,targetRange:'第三至五章',paidOffChapter:null,relatedEventIds:[]}});
  assert.equal(ws.records.find(r=>r.id===hook.id).details.introducedChapter,1);
  const org=await ws.saveRecord({kind:'organization',title:'船社',body:'本地行社',status:'active',participants:[c.id],details:{members:[{characterId:c.id,role:'社员',fromChapter:1,toChapter:null}]}});
  assert.equal(ws.records.find(r=>r.id===org.id).details.members[0].role,'社员');
});
test('同名身份、相反值与否定句不能只凭模型explicit通过',()=>{
  const snapshot={document:{id:'d',hash:'h',chapter:1},text:'阿青并没有到南城。',characters:[{id:'a',name:'阿青',aliases:[],status:'registered'},{id:'b',name:'阿青',aliases:[],status:'registered'}],locks:[]};
  const [e]=validateExtraction([{title:'到达',facts:[{entity_id:'a',field:'location',value:'北城',layer:'occurred',certainty:'explicit',evidence:snapshot.text}]}],snapshot);
  assert.equal(e.facts[0].status,'pending');assert.ok(e.facts[0].review_reasons.some(r=>r.includes('同名')));assert.ok(e.facts[0].review_reasons.some(r=>r.includes('字段值')));
});
