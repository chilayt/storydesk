import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { fixture, output } from '../test/helpers.mjs';

const [python, bridge] = process.argv.slice(2);
if (Boolean(python) !== Boolean(bridge)) throw new Error('Supply both external runtime paths or neither to use the bundle.');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.env.NOVEL_PACKAGED_EXE;
const require = createRequire(import.meta.url);
const f = await fixture('memlayer-desktop');
const runtime = path.join(f.root, '_ui-runtime');
const requests = [], checks = [];
const model = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ id: 'memory-e2e', model: 'fixture-memory', choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: '记忆样例已收到。' } }],
  usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 } }));
});
const reservation = createServer();
let app;
try {
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  const workId = f.workspace.project.id;
  await f.workspace.updateSettings({ memlayer: { enabled: true, baseUrl }, ai: { enabled: true,
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture-memory', maxTokensPerJob: 120000, dailyTokenLimit: 300000 } });
  await f.close();
  await fs.mkdir(runtime, { recursive: true });
  if (python && bridge) await fs.writeFile(path.join(runtime, 'memlayer-runtime.json'), JSON.stringify({ python, bridge, port }));
  else await fs.writeFile(path.join(runtime, 'bundled-memory.json'), JSON.stringify({ port }));
  const env = { ...process.env, NOVEL_TEST_MODE: '1', NOVEL_DEFAULT_WORK: f.root, NOVEL_USER_DATA: runtime };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({
    executablePath: packaged || require('electron'), args: packaged ? [] : [project], env, timeout: 45000,
  });
  app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const call = (method, args) => page.evaluate(({ method, args, workId }) => window.storyDesk.call(method, args, workId), { method, args, workId });
  const openSharedMemory = async () => {
    await page.getByRole('navigation', { name: '作品导航' }).getByRole('button', { name: '写作扩展', exact: true }).click();
    await page.getByRole('button', { name: '规则与作者裁定', exact: true }).click();
    await page.getByRole('button', { name: '共享记忆', exact: true }).click();
    await page.getByRole('heading', { name: '共享记忆（跨会话）', exact: true }).waitFor();
  };
  const newConversation = async () => {
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('heading', { name: '新对话', exact: true }).waitFor();
  };
  const send = async text => {
    const count = requests.length;
    await page.getByLabel(/^(写作要求|讨论要求)$/u).fill(text);
    await page.getByRole('button', { name: '发送讨论', exact: true }).click();
    await page.getByText('记忆样例已收到。', { exact: true }).last().waitFor();
    assert.ok(requests.length > count);
    return JSON.stringify(requests.at(-1));
  };
  await page.getByRole('heading', { name: '写作对话', exact: true }).waitFor();
  const newStatus = await call('memlayerStatus');
  assert.equal(newStatus.status, 'empty');
  assert.equal((await (await fetch(baseUrl + '/health')).json()).semantic.enabled, false);
  checks.push('Windows 工作台按作品设置启动真实 Memlayer，能看到连接成功及空库状态');

  async function post(route, payload) {
    const response = await fetch(baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
    const data = await response.json();
    assert.equal(data.ok, true, JSON.stringify(data));
    return data.result;
  }
  async function add(project, text, id, approve) {
    const { candidate } = await post('/v1/candidates', { project, text, source_event_id: id, subject: '试用写作偏好' });
    if (approve) await post('/v1/candidates/approve', { candidate_id: candidate.id, expected_hash: candidate.content_hash,
      note: '此批准仅用于虚构验收' });
  }
  const approved = '遇到风灯时，先写光落在物件上的位置。';
  const waiting = '候选说明不能进入对话。';
  const unrelated = '另一部作品的记忆不可见。';
  await add(workId, approved, 'fixture_approved', true);
  await add(workId, waiting, 'fixture_waiting', false);
  await add('work_foreign', unrelated, 'fixture_other', true);
  assert.equal((await call('memlayerStatus')).available, 1);

  const actual = await send('讨论风灯场景，并给这份人物档案补充一个思路。');
  assert.ok(actual.includes(approved));
  assert.ok(!actual.includes(waiting) && !actual.includes(unrelated));
  checks.push('同作品的已确认记忆进入实际 Agent 请求，待审批和其他作品的内容按范围拦截');
  await app.close();
  app = await launch(); page = await app.firstWindow();
  await page.getByRole('heading', { name: '写作对话', exact: true }).waitFor();
  assert.equal((await call('memlayerStatus')).available, 1);
  checks.push('退出重开自动启动桥，已确认记忆仍可召回');

  await newConversation();
  const original = '讨论盐灯场面时，先写窗上的灯影。';
  const edit = '讨论盐灯场面时，先写光落在铜盘上的轮廓。';
  await send(original);
  const note = page.getByRole('button', { name: '存为共享记忆', exact: true }).last();
  await note.click();
  assert.equal(await page.getByLabel('候选原话', { exact: true }).inputValue(), original);
  await page.getByRole('button', { name: '提交候选', exact: true }).click();
  await page.getByText('已提交候选，需在记忆中心确认后才会被 AI 读取', { exact: true }).waitFor();
  const pendingPage = await call('memlayerMemory');
  assert.equal(pendingPage.candidates.length, 1);
  const source = pendingPage.candidates[0].source;
  assert.ok(source);
  assert.equal((await call('memlayerStatus')).available, 1);
  checks.push('从创作对话点击保存绑定作者原话，候选未经确认时不可召回');

  await openSharedMemory();
  const activeMemory = await call('memlayerStatus');
  await page.getByText('MemLayer ' + activeMemory.version, { exact: true }).waitFor();
  await app.evaluate(({ shell }) => {
    shell.openExternal = async url => { globalThis.memoryDocsUrl = url; };
  });
  await page.getByRole('button', { name: '了解 MemLayer', exact: true }).click();
  let docsUrl;
  for (let i = 0; !docsUrl && i < 30; i++) {
    docsUrl = await app.evaluate(() => globalThis.memoryDocsUrl);
    if (!docsUrl) await delay(25);
  }
  assert.equal(docsUrl, 'https://github.com/chilayt/memlayer/blob/main/README.zh-CN.md');
  checks.push('记忆中心显示实际运行版本，链接打开 MemLayer 中文介绍');
  const pendingCard = page.locator('.memory-card').filter({ hasText: original });
  await pendingCard.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('修改候选原话', { exact: true }).fill(edit);
  await page.getByRole('button', { name: '改后重新提交', exact: true }).click();
  const editedCard = page.locator('.memory-card').filter({ hasText: edit });
  await editedCard.getByRole('button', { name: '确认新增', exact: true }).click();
  await editedCard.getByRole('button', { name: '撤回', exact: true }).waitFor();
  checks.push('编辑并审批候选，确认后的记忆保留原消息编号');

  await delay(1100);
  for (let i = 0; i < 23; i++) await add(workId, '普通工作记录 ' + i, 'fixture-new-' + i, true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await editedCard.getByRole('button', { name: '撤回', exact: true }).waitFor();
  await page.getByLabel('查找已保存的记忆', { exact: true }).fill(source);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.getByRole('heading', { name: '已保存 (1)', exact: true }).waitFor();
  assert.equal(await editedCard.count(), 1);
  checks.push('落出前 20 条的记忆可翻页，也可按原消息编号查找');

  await page.getByRole('button', { name: '返回创作空间', exact: true }).click();
  await newConversation();
  const answerInput = await send('给盐灯场面出一个写法。');
  assert.ok(answerInput.includes(edit));
  assert.ok(answerInput.includes('confirmedAuthorPreferences') && answerInput.includes('可见正文的首字符'));
  if (!await page.getByRole('button', { name: '新建工作区标签', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  }
  await page.getByRole('button', { name: '新建工作区标签', exact: true }).click();
  await page.locator('.dock-card-grid button').filter({ has: page.getByText('本次依据', { exact: true }) }).click();
  const evidence = page.getByRole('region', { name: '本次依据详情', exact: true });
  await evidence.getByRole('button', { name: '上轮实际', exact: true }).click();
  const recalled = evidence.locator('details').filter({ has: page.getByText('本轮读取的已确认记忆', { exact: true }) })
    .filter({ hasText: source });
  await recalled.locator('summary').click();
  await recalled.getByText(edit, { exact: true }).waitFor();
  await recalled.getByText(`出处编号 · ${source}`, { exact: true }).waitFor();
  checks.push('本次依据的上轮实际记录能核对已召回的原话和来源编号');
  await recalled.getByRole('button', { name: '反馈这条记忆', exact: true }).click();
  await recalled.getByRole('combobox').selectOption('not_applied');
  await recalled.getByRole('textbox').fill('虚构回归，核对这项偏好。');
  await recalled.getByRole('button', { name: '保存记忆反馈', exact: true }).click();
  await recalled.getByRole('status').filter({ hasText: '已记录' }).waitFor();
  checks.push('在实际依据内为指定已读记忆提交反馈，经桌面 IPC 成功保存');
  await openSharedMemory();
  await page.getByLabel('查找已保存的记忆', { exact: true }).fill(source);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await editedCard.getByRole('button', { name: '撤回', exact: true }).click();
  await page.getByText('没有找到符合条件的记忆。', { exact: true }).waitFor();
  await app.close(); app = await launch(); page = await app.firstWindow();
  await page.getByRole('heading', { name: '写作对话', exact: true }).waitFor();
  await newConversation();
  assert.ok(!(await send('给盐灯场面出一个写法。')).includes(edit));
  checks.push('确认的原话进入新对话的实际模型请求，撤回后重启也不会进入请求');
  const info = await call('appInfo');
  const report = { version: info.version, packaged: !!packaged, passed: true, checks, realMemlayer: true, simulatedWritingModel: true };
  await fs.writeFile(path.join(output, info.version + '-Memlayer-桌面验收.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await app?.close();
  model.closeAllConnections();
  model.close();
}
