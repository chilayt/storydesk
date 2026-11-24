import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import { UUID } from 'builder-util-runtime';

const [previous, current] = process.argv.slice(2);
if (!previous || !current) throw new Error('Pass the previous and current Windows installer paths.');
const run = promisify(execFile);
const appId = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).build.appId;
const installedKey = UUID.v5(appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
for (const hive of ['HKCU', 'HKLM']) {
  for (const flag of ['/reg:64', '/reg:32']) {
    const registered = await run('reg.exe', ['query', [hive,'Software','Microsoft','Windows','CurrentVersion','Uninstall',installedKey].join(String.fromCharCode(92)), flag])
      .then(() => true, error => { if (error.code === 1) return false; throw error; });
    if (registered) throw new Error('The open-source edition is already installed. Use an isolated Windows test account.');
  }
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storydesk-upgrade-'));
const profile = path.join(root, 'profile');
const work = path.join(root, '远灯录');
const installation = path.join(root, 'installation');
const exeName = '创作协作台开源版.exe';
const installedApp = path.join(installation, exeName);
const compare = async file => fs.readFile(path.join(work, file), 'utf8');
const runInstaller = installer => run(path.resolve(installer), ['/S', '/D=' + installation], {windowsHide:true, timeout:120000});
const env = {...process.env, NOVEL_USER_DATA:profile, NOVEL_DEFAULT_WORK:work};
for (const key of ['ELECTRON_RUN_AS_NODE','NOVEL_TEST_MODE','NOVEL_LOCAL_LAUNCHER','NOVEL_ASR_ROOT','NOVEL_PYTHON']) delete env[key];

const chapterPath = '_已解析/1-10/第01章_风灯.md';
const files = {
  'novel-kb/00-索引/README.md': '# 远灯录资料索引\n',
  'novel-kb/01-实体/人物/沈禾.md': '# 沈禾\n\n## 身份\n守灯人。\n',
  'novel-kb/03-剧情/第一章_章纲.md': '# 过桥计划\n\n拾回风灯。\n',
  [chapterPath]: '# 第一章 风灯\n\n沈禾守着桥头的风灯。\n',
};
for (const [file, text] of Object.entries(files)) {
  const target = path.join(work, file);
  await fs.mkdir(path.dirname(target), {recursive:true});
  await fs.writeFile(target, text);
}
const answer = '远灯录模拟回复。';
const preference = '写远灯录的风灯场景时，优先写声音，再写动作。';
const prompts = [];
const provider = createServer(async (request, response) => {
  const buffers = [];
  for await (const chunk of request) buffers.push(chunk);
  prompts.push(JSON.parse(Buffer.concat(buffers).toString('utf8')));
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({id:'upgrade-fixture', model:'fixture-model', choices:[{finish_reason:'stop',
    message:{role:'assistant', content:answer}}], usage:{prompt_tokens:100, completion_tokens:20, total_tokens:120}}));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const ai = {enabled:true, baseUrl:'http://127.0.0.1:' + provider.address().port + '/v1', model:'fixture-model'};
let app;
let page;
const call = (method, args = {}, workId) => page.evaluate(input => window.storyDesk.call(...input), [method,args,workId]);
async function open(expectedVersion, expectedMemoryVersion) {
  app = await electron.launch({executablePath:installedApp, env, timeout:30000});
  page = await app.firstWindow();
  await page.getByRole('button', {name:'当前作品 远灯录', exact:true}).waitFor({timeout:20000});
  const state = await call('summary');
  assert.equal((await call('appInfo')).version, expectedVersion);
  await call('memlayerStatus', {}, state.id);
  const healthUrl = state.settings.memlayer.baseUrl + '/health';
  assert.equal((await (await fetch(healthUrl)).json()).version, expectedMemoryVersion);
  return state;
}
async function close() { await app?.close(); app = null; }
async function removeInstallation() {
  const resolved = await fs.realpath(installation).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!resolved) return;
  assert.equal(path.relative(await fs.realpath(root), resolved), 'installation');
  const [uninstaller] = (await fs.readdir(resolved)).filter(name => /^Uninstall .+\.exe$/u.test(name));
  if (!uninstaller) return;
  await run(path.join(resolved, uninstaller), ['/S'], {windowsHide:true, timeout:120000});
  for (let i = 0; i < 100; i++) {
    if (!(await fs.stat(installedApp).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }))) return;
    await delay(100);
  }
  throw new Error('The uninstaller did not remove the installed binary.');
}
const checks = [];
try {
  await runInstaller(previous);
  const old = await open('2.0.14-beta.1', '0.2.3');
  assert.equal(old.documents.find(doc => doc.path === chapterPath)?.chapter, 1);
  assert.equal(old.documents.find(doc => doc.path === chapterPath)?.readOnly, true);
  assert.ok(old.characters.some(character => character.name === '沈禾'));
  assert.ok(old.documents.some(doc => doc.path === 'novel-kb/03-剧情/第一章_章纲.md' && doc.kind === 'plan'));
  checks.push('第二种目录结构自动入库，识别章节、人物和章纲。');
  const draft = await call('createChapterDraft', {chapter:2,title:'归桥',importedText:'# 第二章 归桥\n\n沈禾走过拱桥。\n'},old.id);
  const saved = await call('saveDocument', {documentId:draft.id,expectedHash:draft.hash,text:'# 第二章 归桥\n\n沈禾听见钟响，收起风灯。\n'},old.id);
  const previousText = await compare(saved.document.path);
  await call('updateSettings', {ai,writingModel:'analysis'}, old.id);
  const task = await call('createCreativeTask',
    {kind:'chapter',documentId:draft.id,title:'风灯共写',goal:'记录风灯场景的偏好'},old.id);
  const turn = {documentId:draft.id,sceneId:null,taskId:task.id};
  await call('sendCowriting', {...turn,sourceHash:saved.document.hash,message:preference,mode:'discuss'},old.id);
  const view = await call('getCowriting', turn, old.id);
  const sourceId = view.messages.find(message => message.role === 'author')?.id;
  assert.ok(sourceId);
  assert.ok(view.messages.some(message => message.text === answer));
  const claim = await call('memlayerPropose', {...turn,scope:'work',sourceId,text:preference},old.id);
  await call('memlayerReview', {scope:'work',decision:'approve',id:claim.id,hash:claim.hash},old.id);
  assert.equal((await call('memlayerStatus', {}, old.id)).available,1);
  await close();

  await runInstaller(current);
  const verifyPreserved = async () => {
    const state = await open('2.0.14-beta.2','0.2.4');
    assert.equal(state.id, old.id);
    assert.equal(state.documents.find(doc => doc.path === chapterPath)?.id, old.documents.find(doc => doc.path === chapterPath)?.id);
    assert.equal(state.documents.find(doc => doc.id === draft.id)?.hash, saved.document.hash);
    assert.equal(await compare(chapterPath), files[chapterPath]);
    assert.equal(await compare(saved.document.path), previousText);
    assert.equal((await call('getCowriting',turn,old.id)).messages[0]?.id,sourceId);
    assert.equal((await call('memlayerStatus', {},old.id)).available, 1);
    const memory = await call('memlayerMemory', {search:sourceId},old.id);
    assert.equal(memory.facts[0]?.text,preference);
    assert.equal(state.settings.ai.baseUrl,ai.baseUrl);
    const followup = await call('createCreativeTask', {kind:'chapter',documentId:draft.id,title:'Recall after update'},old.id);
    const count = prompts.length;
    await call('sendCowriting', {...turn,taskId:followup.id,sourceHash:saved.document.hash,
      message:'请给远灯录的风灯场景一个写作提示。',mode:'discuss'},old.id);
    assert.ok(prompts.length > count && JSON.stringify(prompts.at(-1)).includes(preference));
  };
  await verifyPreserved();
  checks.push('原位升级保留作品编号、草稿文本和版本、原对话、模型连接及已确认记忆。');
  await close();

  await removeInstallation();
  assert.equal(await compare(saved.document.path),previousText);
  assert.ok((await fs.stat(profile)).isDirectory());
  await runInstaller(current);
  await verifyPreserved();
  checks.push('卸载后重装，继续从保留的目录读取同一份草稿、对话和记忆。');
  console.log(JSON.stringify({passed:true, checks},null,2));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await close();
  try { await removeInstallation(); }
  finally {
    provider.closeAllConnections();
    provider.close();
  }
}
