import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { fixture, output } from '../test/helpers.mjs';

const require = createRequire(import.meta.url);
const themes = JSON.parse(await fs.readFile(new URL('../core/window-appearance.json', import.meta.url)));
const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(channel => parseInt(channel, 16)).join(', ') + ')';
function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}
function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
const f = await fixture('desktop-themes');
const draft = await f.workspace.createChapterDraft({
  chapter: 5, title: '潮痕', importedText: '# 第五章 潮痕\n\n渡船泊在江边。\n',
});
const memoryRequests = [];
const memory = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  memoryRequests.push({ method: req.method, path: url.pathname, project: url.searchParams.get('project') });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, facts: [] }));
});
await new Promise(resolve => memory.listen(0, '127.0.0.1', resolve));
await f.workspace.updateSettings({ memlayer: { enabled: true, baseUrl: `http://127.0.0.1:${memory.address().port}` } });
await f.close();
const packaged = process.env.NOVEL_PACKAGED_EXE;
const env = { ...process.env, NOVEL_TEST_MODE: '1', NOVEL_DEFAULT_WORK: f.root, NOVEL_USER_DATA: path.join(f.root, 'runtime') };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: packaged || require('electron'), args: packaged ? [] : [process.cwd()], env, timeout: 45000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const chooser = page.getByLabel('外观主题', { exact: true });
  const button = title => page.getByRole('button', { name: title, exact: true });
  const pane = page.locator('#workspace-tool-content');
  const open = async title => {
    await button('新建工作区标签').click();
    await page.locator('.dock-card-grid button').filter({ has: page.getByText(title, { exact: true }) }).click();
  };
  const matchStyle = async (node, property, expected) => {
    assert.equal(await node.evaluate((el, prop) => getComputedStyle(el)[prop], property), rgb(expected), property);
  };
  await button('打开工作区').click();
  await page.locator('.dock-card-grid button').filter({ hasText: '正文与草稿' }).click();
  await pane.getByRole('button', { name: '草稿', exact: true }).click();
  const pickDraft = () => pane.getByRole('button', { name: /第五章 潮痕/ }).click();
  const paletteColors = new Set();
  for (const [theme, palette] of Object.entries(themes)) {
    await chooser.selectOption(theme);
    // Typography colors must work on the editor, file cards, selections, and quiet UI surfaces.
    for (const surface of ['paper', 'ground', 'nav', 'chat', 'bubble', 'composer', 'file', 'selection']) {
      assert.ok(contrast(palette.ink, palette[surface]) > 4.5, `${theme} text on ${surface}`);
      assert.ok(contrast(palette.muted, palette[surface]) >= 4.5, `${theme} muted text on ${surface}`);
    }
    assert.ok(contrast(palette['primary-ink'], palette.accent) >= 4.5);
    assert.ok(contrast(palette.accent, palette['accent-soft']) >= 4.5);
    assert.ok(contrast(palette.focus, palette.paper) >= 3);
    paletteColors.add(palette['accent-soft']);
    await matchStyle(pane.getByRole('button', { name: '草稿', exact: true }), 'backgroundColor', palette['accent-soft']);
    const caption = page.locator('.window-caption');
    if (await caption.count()) await matchStyle(caption, 'backgroundColor', palette.caption);
    if (await page.evaluate(() => CSS.supports('appearance', 'base-select'))) {
      await matchStyle(chooser.locator('option:checked'), 'backgroundColor', palette['accent-soft']);
    }
    await pickDraft();
    const editor = pane.locator('.cm-editor');
    await matchStyle(editor, 'backgroundColor', palette.paper);
    await matchStyle(editor, 'color', palette.ink);
    const primary = pane.getByRole('button', { name: '稿件核对', exact: true });
    await matchStyle(primary, 'backgroundColor', palette.accent);
    await matchStyle(primary, 'color', palette['primary-ink']);
    await pane.getByRole('button', { name: '阅读设置', exact: true }).click();
    const popover = pane.locator('.reader-popover:popover-open');
    await matchStyle(popover, 'backgroundColor', palette.paper);
    await matchStyle(popover.getByLabel('阅读配色'), 'color', palette.ink);
    if (theme === 'charcoal') {
      await popover.getByLabel('阅读配色').selectOption('paper');
      await matchStyle(editor, 'backgroundColor', themes.paper.paper);
      await matchStyle(primary, 'backgroundColor', palette.accent);
      await popover.getByLabel('阅读配色').selectOption('follow');
    }
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(output, `2.0.10-主题-${theme}.png`), animations: 'disabled' });
    await page.getByLabel('工作区标签').getByRole('button', { name: '正文与草稿', exact: true }).click();
  }
  assert.equal(paletteColors.size, 4);

  await page.locator('.search-trigger').click();
  await matchStyle(page.getByRole('dialog', { name: '搜索作品资料' }), 'backgroundColor', themes.charcoal.paper);
  await page.keyboard.press('Escape');
  for (const [title, selector] of [
    ['资料库', '.library-categories'], ['人物档案', '.people-pane'], ['世界观设定', '.workspace-tool'],
    ['地点与地图', '.workspace-tool'], ['剧情总览', '.workspace-tool'], ['稿件核对', '.manuscript-review'],
    ['全书核对', '.workspace-tool'], ['更新与核对', '.content-page'], ['写作扩展', '.dock-extensions'],
  ]) {
    await open(title);
    await pane.locator(selector).first().waitFor();
    assert.equal(await pane.evaluate(el => getComputedStyle(el).getPropertyValue('--studio-accent').trim()), themes.charcoal.accent);
  }

  await button('作品设置').click();
  await page.getByRole('checkbox', { name: '从 MemLayer 召回已确认记忆' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '从 MemLayer 召回已确认记忆' }).isChecked(), true);
  await page.getByText('已连接 · 当前范围有 0 条已确认记忆', { exact: true }).waitFor();
  const summary = await page.evaluate(() => window.storyDesk.call('summary'));
  assert.ok(summary.documents.some(doc => doc.id === draft.id));
  assert.ok(memoryRequests.length && memoryRequests.every(req =>
    req.method === 'GET' && req.path === '/v1/facts' && req.project === summary.id));
  console.log('通过：四种主题的选中、正文、主按钮、弹窗、标题栏和文字对比度；九类工作区入口、作品设置及 MemLayer 空库状态。');
} finally {
  await app?.close();
  await new Promise(resolve => memory.close(resolve));
}
