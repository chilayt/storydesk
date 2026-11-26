import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { fixture, output } from '../test/helpers.mjs';

const packaged = process.env.NOVEL_PACKAGED_EXE;
assert.ok(packaged, 'Set NOVEL_PACKAGED_EXE to the packaged desktop executable');
const oldWork = await fixture('book-design-existing');
await oldWork.workspace.updateSettings({ name: '虚构·旧渡口' });
await oldWork.close();
const run = await fs.mkdtemp(path.join(output, 'book-design-desktop-'));
const userData = path.join(run, 'runtime');
const bookName = '虚构·停产之后';
const book = path.join(run, bookName);
const env = { ...process.env, NOVEL_TEST_MODE: '1', NOVEL_DEFAULT_WORK: oldWork.root, NOVEL_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: packaged, env, timeout: 45000 });
const initial = '我想写现代工业小说，沈岸接手停产的机床厂。';
const followup = '沈岸想请老工友回来。第一卷查停产原因，第一章写他回厂。设定是送电申请必须隔夜。';
const fakeResponses = [{
  answer: '眼下可以先定住沈岸接手停产机床厂的起点。沈岸眼下最想办成的一件事是什么？',
  items: [{ kind: 'work', title: '全书大纲', quote: '沈岸接手停产的机床厂', text: '## 核心构想\n\n沈岸接手停产的机床厂。\n\n## 待定事项\n\n复工前最想办成的事。' }],
  decisions: [{ topic: 'premise', title: '接手机床厂', text: '沈岸接手停产的机床厂。', quote: '沈岸接手停产的机床厂' }],
}, {
  answer: '主角、第一卷的方向和首章起点都可以先记录。第一章结束时，沈岸希望带走一个承诺还是一个线索？',
  items: [
    { kind: 'character', title: '沈岸', quote: '沈岸想请老工友回来', text: '## 基础信息\n\n- 姓名：沈岸\n- 眼下目标：请老工友回来。' },
    { kind: 'setting', title: '送电规则', quote: '送电申请必须隔夜', text: '厂区的送电申请必须隔夜。' },
    { kind: 'volume', title: '卷一', number: 1, quote: '第一卷查停产原因', text: '## 卷内目标\n\n查出机床厂停产的原因。\n\n对应章序待定。' },
    { kind: 'chapter', title: '回厂', number: 1, quote: '第一章写他回厂', text: '## 开场\n\n沈岸回到停产的机床厂。' },
  ],
}];

try {
  await app.evaluate(({ dialog, net }, { directory, scripted }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    const originalFetch = net.fetch.bind(net);
    globalThis.bookRequests = [];
    let turn = 0;
    net.fetch = async (url, options) => {
      if (new URL(url).origin !== 'http://127.0.0.1:9955') return originalFetch(url, options);
      const call = JSON.parse(options.body);
      globalThis.bookRequests.push(call);
      const hasToolResult = call.messages.some(row => row.role === 'tool');
      const row = scripted[turn];
      const done = hasToolResult || !row;
      const message = done ? { role: 'assistant', content: row?.answer || '已读本作品的当前上下文。' } :
        { role: 'assistant', content: null, tool_calls: [{
          id: 'book-fixture-' + turn, type: 'function', function: {
            name: 'prepare_book_design', arguments: JSON.stringify({ items: row.items }),
          },
        }, ...(row.decisions ? [{
          id: 'book-decision-' + turn, type: 'function', function: {
            name: 'prepare_book_decisions', arguments: JSON.stringify({ items: row.decisions }),
          },
        }] : [])] };
      if (done) turn++;
      return Response.json({ id: 'book-design-fixture', model: 'fixture-model', choices: [{
        index: 0, message, finish_reason: done ? 'stop' : 'tool_calls',
      }], usage: { total_tokens: 180 } });
    };
  }, { directory: run, scripted: fakeResponses });

  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(17000);
  const button = name => page.getByRole('button', { name, exact: true });
  const invoke = (method, args = {}) => page.evaluate(({ method, args }) => window.storyDesk.call(method, args), { method, args });
  const workButton = name => button('当前作品 ' + name);
  const configure = async () => {
    await invoke('updateSettings', { ai: { enabled: true, baseUrl: 'http://127.0.0.1:9955/v1', model: 'fixture-model' }, writingModel: 'analysis' });
  };
  async function switchWork(name) {
    await page.getByRole('button', { name: /^当前作品 /u }).click();
    await page.getByRole('dialog', { name: '作品库' }).getByRole('button', { name: new RegExp(name, 'u') }).click();
    await workButton(name).waitFor();
  }
  async function send(text, answer) {
    const input = page.locator('#cowriting-message');
    await input.fill(text);
    await button('发送讨论').click();
    await page.getByText(answer, { exact: true }).waitFor();
  }
  async function saveDesign(name, extra) {
    const row = page.locator('.book-design-row').filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole('button', { name: '核对并保存', exact: true }).click();
    const dialog = page.getByRole('dialog', { name, exact: true });
    if (extra) {
      const input = dialog.getByLabel('设计正文');
      await input.fill(await input.inputValue() + '\n\n' + extra);
    }
    await dialog.getByRole('button', { name: '保存到本作品', exact: true }).click();
    await row.getByRole('button', { name: '打开资料', exact: true }).waitFor();
  }

  await workButton('虚构·旧渡口').click();
  await button('创建空作品').click();
  await page.getByLabel('作品名称', { exact: true }).fill(bookName);
  await button('选择位置并创建').click();
  await workButton(bookName).waitFor();
  await page.getByRole('heading', { name: '从一个点子开始', exact: true }).waitFor();
  await configure();
  await send(initial, fakeResponses[0].answer);
  await assert.rejects(fs.stat(path.join(book, '_创作管理/大纲/全书大纲.md')), { code: 'ENOENT' });
  await saveDesign('全书大纲', '厂门夜间断电。');
  await page.getByText('新书设计进度', { exact: true }).click();
  const progress = page.getByLabel('新书设计进度', { exact: true }).last();
  assert.equal(await progress.getByRole('button', { name: '调整构思', exact: true }).count(), 0);
  await button('核对构思').click();
  const decisionDialog = page.getByRole('dialog', { name: '核对新书构思' });
  assert.equal(await decisionDialog.getByLabel('构思状态').inputValue(), 'exploring');
  await decisionDialog.getByLabel('构思状态').selectOption('tentative');
  await decisionDialog.getByRole('button', { name: '保存构思' }).click();
  await progress.getByText('核心构想 · 暂定', { exact: true }).waitFor();
  await progress.getByRole('button', { name: '调整构思', exact: true }).click();
  await decisionDialog.getByLabel('构思状态').selectOption('confirmed');
  await decisionDialog.getByRole('button', { name: '保存构思' }).click();
  await progress.getByText('核心构想 · 已确认', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(run, '新书设计进度.png') });
  await page.getByText('新书设计进度', { exact: true }).click();
  await send(followup, fakeResponses[1].answer);
  await page.screenshot({ path: path.join(run, '构思新书.png') });
  for (const name of ['沈岸', '送电规则', '第1卷大纲', '第1章章纲']) await saveDesign(name);

  const outline = '_创作管理/大纲/全书大纲.md';
  const files = [outline, '_创作管理/大纲/第1卷大纲.md', '_创作管理/大纲/第1章章纲.md', '人物/沈岸.md', '设定/送电规则.md'];
  const work = await invoke('summary');
  for (const file of files) {
    assert.ok((await fs.stat(path.join(book, file))).isFile(), file);
    assert.ok(work.documents.some(doc => doc.path === file), file);
  }
  assert.ok(work.characters.some(character => character.name === '沈岸' && character.primarySourceId));
  assert.match(await fs.readFile(path.join(book, outline), 'utf8'), /厂门夜间断电/u);
  assert.ok((await fs.stat(path.join(book, '草稿章节'))).isDirectory());
  const chapter = await invoke('getWritingContext', { documentId: 'outline_chapter_1' });
  assert.ok(chapter.sections.some(row => row.title === '全书大纲'));
  const volume = work.documents.find(doc => doc.path === files[1]);
  assert.ok(!chapter.sections.some(row => row.title === volume.title));
  await invoke('confirmVolumeOutline', { documentId: volume.id, expectedHash: volume.hash, fromChapter: 1, toChapter: 3 });
  assert.ok((await invoke('getWritingContext', { documentId: 'outline_chapter_1' })).sections.some(row => row.title === volume.title));
  assert.equal(work.stats.confirmed, 0);

  await switchWork('虚构·旧渡口');
  assert.ok(!(await invoke('summary')).characters.some(character => character.name === '沈岸'));
  await configure();
  await send('讨论这本书原有的渡口故事。', '已读本作品的当前上下文。');
  await switchWork(bookName);
  await page.getByText(fakeResponses[1].answer, { exact: true }).waitFor();
  assert.equal(await button('打开资料').count(), 5);
  await button('构思第一章').click();
  await page.getByRole('heading', { name: '这一章，要往哪里推进？', exact: true }).waitFor();

  const calls = await app.evaluate(() => globalThis.bookRequests);
  assert.equal(calls.length, 5);
  assert.match(JSON.stringify(calls[0]), /每轮只问一个/u);
  assert.match(JSON.stringify(calls[2]), /沈岸接手停产的机床厂/u);
  assert.match(JSON.stringify(calls[2]), /厂门夜间断电/u);
  assert.doesNotMatch(JSON.stringify(calls[4]), /沈岸|停产之后|送电规则|prepare_book_design/u);
  assert.deepEqual(errors, []);
  const report = {
    version: await invoke('appInfo').then(info => info.version), passed: true,
    model: '模拟模型', savedFiles: files, validated: ['一条构想开启引导', '文件保存不自动定案', '构思待探索、暂定、确认的独立状态', '编辑后保存',
      '人物、设定和剧情资料入库', '首章接续已保存全书大纲与作者确认适用范围的卷纲', '切书隔离并恢复原对话'],
  };
  await fs.writeFile(path.join(output, report.version + '-新书构思验收.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await app.close(); }
