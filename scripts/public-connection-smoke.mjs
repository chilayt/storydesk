
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';

const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'storydesk-public-'));
const hostProfile = path.join(parent, 'profile');
const env = { ...process.env, NOVEL_USER_DATA: hostProfile };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NOVEL_TEST_MODE', 'NOVEL_DEFAULT_WORK', 'NOVEL_LOCAL_LAUNCHER', 'NOVEL_ASR_ROOT', 'NOVEL_PYTHON']) delete env[key];
const exe = process.env.NOVEL_PACKAGED_EXE || path.resolve('release-public/win-unpacked/创作协作台开源版.exe');
const A = 'https://a.invalid/v1', B = 'http://127.0.0.1:49283/v1';
const demoKey = 'fixture-key-for-a';
const checks = [];
const open = () => electron.launch({ executablePath: exe, env, timeout: 30000 });
let app = await open();

async function attachMock(current) {
  await current.evaluate(({ dialog, net }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    const fetchOriginal = net.fetch.bind(net);
    globalThis.fixtureRequests = [];
    net.fetch = async (url, init) => {
      if (!['https://a.invalid/v1/chat/completions', 'http://127.0.0.1:49283/v1/chat/completions'].includes(url)) return fetchOriginal(url, init);
      const body = JSON.parse(init.body);
      globalThis.fixtureRequests.push({ url, token: init.headers.Authorization || '', model: body.model });
      return new Response(JSON.stringify({ id: 'fixture-1', model: body.model, choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: '已收到写作请求。' } }],
        usage: { prompt_tokens: 60, completion_tokens: 15, total_tokens: 75 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, parent);
}

try {
  await attachMock(app);
  let page = await app.firstWindow();
  page.setDefaultTimeout(13000);
  const button = name => page.getByRole('button', { name, exact: true });
  const label = name => page.getByLabel(name, { exact: true });
  const call = (method, args = {}, workId) => page.evaluate(input => window.storyDesk.call(...input), [method, args, workId]);
  const requests = () => app.evaluate(() => globalThis.fixtureRequests);
  await page.getByRole('heading', { name: '开始你的创作', exact: true }).waitFor();
  assert.equal((await call('listWorks')).length, 0);
  await button('试玩示例').click();
  await button('当前作品 北岸电台（示例）').waitFor().catch(async error => { console.error(await page.locator('body').innerText()); throw error; });
  let state = await call('summary');
  const workId = state.id;
  assert.equal(state.settings.ai.enabled, false);
  assert.equal(state.settings.memlayer.enabled, true);
  assert.ok(state.documents.some(d => d.kind === 'chapter' && d.chapter === 1));
  assert.ok(state.characters.some(c => c.name === '林岚'));
  const bridgeBase = state.settings.memlayer.baseUrl;
  let health;
  for (let attempts=0; attempts<35 && !health; attempts++) {
    try { health = await (await fetch(bridgeBase + '/health')).json(); } catch { await delay(150); }
  }
  assert.equal(health?.ok, true);
  assert.equal(health.version, '0.2.4');
  assert.equal(health.semantic.enabled, false);
  assert.equal((await call('memlayerStatus', {}, workId)).status, 'empty');
  checks.push('干净配置启动虚构示例，读到正文和人物；内置 MemLayer 0.2.4 自启，使用独立本地库。');

  const showSettings = () => button('作品设置').click();
  const returnToStudio = () => button('返回创作空间').click();
  await showSettings();
  await label('服务地址').fill(A);
  await label('模型名').fill('fixture-a');
  await label('API 密钥').fill(demoKey);
  await page.getByRole('checkbox', { name: '启用模型连接', exact: true }).check();
  assert.equal(await page.getByLabel('连接类型', { exact: true }).count(), 0);
  assert.equal(await button('保存并测试连接').isEnabled(), true);
  await button('保存设置').click();
  await button('清除密钥').waitFor();
  assert.equal((await call('keyStatus', {baseUrl: A}, workId)).authorized, true);
  await returnToStudio();
  const send = async (prompt) => {
    await page.getByLabel(/^(写作要求|讨论要求)$/u).fill(prompt);
    await button('发送讨论').click();
    await page.getByText('已收到写作请求。', { exact: true }).last().waitFor();
  };
  await send('讨论这个虚构电台的第一章。');
  assert.deepEqual((await requests()).at(-1), { url: A + '/chat/completions', token: 'Bearer ' + demoKey, model: 'fixture-a' });

  await showSettings();
  await label('服务地址').fill(B);
  await label('模型名').fill('fixture-b');
  await button('保存设置').click();
  let localStatus;
  for (let i = 0; i < 60; i++) {
    localStatus = await call('keyStatus', {baseUrl:B}, workId);
    if (localStatus.authorized) break;
    await delay(100);
  }
  assert.deepEqual(localStatus, {configured:false, authorized:true});
  assert.deepEqual(await call('keyStatus', {baseUrl:A}, workId), {configured:false, authorized:false});
  await returnToStudio();
  await button('新对话').click();
  await page.getByRole('heading', { level: 1, name: '新对话', exact: true }).waitFor();
  await send('请讨论同一电台的第二场。');
  assert.deepEqual((await requests()).at(-1), {url:B+'/chat/completions',token:'',model:'fixture-b'});
  checks.push('同一个设置入口完成 HTTPS 云端与本机兼容模型的实际 Agent 请求；切换地址时旧密钥没有随请求发送。');

  const projectFile = path.join(state.root, '_创作管理/project.json');
  assert.ok(!(await fs.readFile(projectFile,'utf8')).includes(demoKey));
  await app.close();
  const stored = JSON.parse(await fs.readFile(projectFile,'utf8'));
  stored.settings.ai = { ...stored.settings.ai, enabled: true, baseUrl: A, model:'fixture-a' };
  await fs.writeFile(projectFile, JSON.stringify(stored,null,2));
  app = await open(); await attachMock(app); page = await app.firstWindow(); page.setDefaultTimeout(12000);
  await button('当前作品 北岸电台（示例）').waitFor().catch(async error => { console.error(await page.locator('body').innerText()); throw error; });
  assert.equal((await call('memlayerStatus', {}, workId)).status, 'empty');
  await assert.rejects(call('testModel', {connection:true}, workId));
  assert.equal((await requests()).length, 0);
  assert.equal((await call('keyStatus', {baseUrl:A}, workId)).authorized, false);
  checks.push('重启后记忆正常，外部修改作品文件无法替代本机连接授权；密钥未写入作品。');
  console.log(JSON.stringify({ passed:true, checks },null,2));
} catch (error) {
  console.error(await (await app.firstWindow()).locator('body').innerText());
  throw error;
} finally {
  await app?.close();
}
