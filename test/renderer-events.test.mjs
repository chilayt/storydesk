import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { publishRenderer } = createRequire(import.meta.url)('../electron/renderer-events.cjs');
test('延迟通知遇到已销毁窗口或渲染进程直接丢弃，不阻断退出', () => {
  assert.equal(publishRenderer(null, {}), false);
  assert.equal(publishRenderer({ isDestroyed: () => true, get webContents() { throw new Error('destroyed window must not be accessed'); } }, {}), false);
  assert.equal(publishRenderer({ isDestroyed: () => false, webContents: { isDestroyed: () => true, send() { throw new Error('destroyed renderer must not be accessed'); } } }, {}), false);
});
test('正常通知只发给有效渲染进程，关闭瞬间发送失败也可安全收尾', () => {
  const sent = [], win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } };
  assert.equal(publishRenderer(win, { type: 'changed' }), true); assert.deepEqual(sent, [['storydesk:event', { type: 'changed' }]]);
  win.webContents.send = () => { throw new Error('Object has been destroyed'); }; assert.equal(publishRenderer(win, {}), false);
});
