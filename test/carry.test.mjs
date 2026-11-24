import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCarryLabel, selectCarrySection, carryTarget } from '../core/carry.mjs';

const card = title => `# 参考计划\n\n## ${title}\n\n| 人 | 来料 | 上场末状态 | 判定 |\n|---|---|---|---|\n| 沈舟 | 回看 | 曾在渡口 | 必出 |\n`;
const oldTitle = '承接 · 场1 → 场2（第七章下半·渡口）';
const title = '承接 · 第一章 → 第二章（原计划）';

test('章号与场号分开：第二章不套用第七章场2；中文章号可对应', () => {
  assert.equal(selectCarrySection(card(oldTitle), '场1 → 场2', { chapter: 2 }).status, 'scope_mismatch');
  assert.equal(selectCarrySection(card(oldTitle), '第1章 → 第2章', { chapter: 2 }).status, 'not_matched');
  assert.equal(selectCarrySection(card(oldTitle), '场1 → 场2', { chapter: 7 }).status, 'scope_unknown');
  assert.equal(selectCarrySection(card(title), '第01章 -> 第02章', { chapter: 2 }).selectedTitle, title);
  assert.equal(normalizeCarryLabel('第七章 → 第一百零二章'), '第7章→第102章');
});

test('调整章序按箭头目的章处理；跨章完整标题可主动参考且保留警示', () => {
  const reversed = '承接 · 第七章 → 第二章（顺序调整）';
  assert.equal(carryTarget(reversed), 2);
  assert.equal(selectCarrySection(card(reversed), '第7章 → 第2章', { chapter: 2 }).status, 'ready');
  const explicit = selectCarrySection(card(oldTitle), oldTitle, { chapter: 2 });
  assert.equal(explicit.status, 'ready');
  assert.match(explicit.scopeWarning, /跨章参考/);
  assert.match(explicit.scopeWarning, /整份稿件/);
});
