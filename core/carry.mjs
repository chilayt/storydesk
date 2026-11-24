import fs from 'node:fs/promises';
import { decode, hash } from './io.mjs';
import { chapterNumber } from './catalog.mjs';

const digits = '[0-9一二三四五六七八九十百零〇两]+';
const chapter = new RegExp(`第?\\s*(${digits})\\s*章`, 'g');
const chapterPair = new RegExp(`第?\\s*(${digits})\\s*章\\s*(?:→|->|⇒)\\s*第?\\s*(${digits})\\s*章`);
const number = s => chapterNumber(`第${s}章`);
export function normalizeCarryLabel(value) {
  return String(value).replace(chapter, (_, n) => `第${number(n)}章`)
    .replace(new RegExp(`场\\s*(${digits})`, 'g'), (_, n) => `场${number(n)}`)
    .replace(/->|⇒/g, '→').replace(/\s+/g, '');
}
export function carryTarget(title) {
  const pair = title.match(chapterPair);
  if (pair) return number(pair[2]); // Destination, not the largest chapter number.
  const chapters = [...new Set([...title.matchAll(chapter)].map(m => number(m[1])).filter(Number.isInteger))];
  return chapters.length === 1 ? chapters[0] : null;
}
export function selectCarrySection(text, pair, document) {
  const requested = normalizeCarryLabel(pair);
  if (!requested) return { status: 'not_selected', message: '本次未选择承接计划；不影响文风检查与成稿确认。' };
  const candidates = [...text.matchAll(/^\s*#{1,6}\s+(.+?)\s*$/gm)].map(m => m[1]).filter(t => t.includes('承接') && normalizeCarryLabel(t).includes(requested));
  if (!candidates.length) return { status: 'not_matched', message: '没有找到与本次章节／场次对应的参考小节；不会套用其他章节的计划，不影响确认。' };
  if (candidates.length !== 1) return { status: 'ambiguous', message: '参考文字匹配到多个小节，本次未运行承接对照；可填写完整小节标题以明确选择，不影响确认。' };
  const title = candidates[0], targetChapter = carryTarget(title);
  const explicit = requested === normalizeCarryLabel(title);
  const isScene = new RegExp(`场\\s*${digits}\\s*(?:→|->|⇒)\\s*场`).test(title);
  const base = { selectedTitle: title, targetChapter, scope: isScene ? 'scene' : 'chapter', explicit };
  if ((!targetChapter || !document.chapter) && !explicit) return { ...base, status: 'scope_unknown', message: '这张卡没有可核对的所属章节，本次不自动套用；仅作待核对提醒。' };
  if (targetChapter && document.chapter && targetChapter !== document.chapter && !explicit) return { ...base, status: 'scope_mismatch', message: `参考卡属于第${targetChapter}章，当前稿件是第${document.chapter}章；本次未对照这张卡，不影响确认。` };
  if (isScene && !explicit) return { ...base, status: 'scope_unknown', message: '这张卡描述章内场次，不能把场号直接当章号套用。若要主动参考，请填写完整小节标题；不影响确认。' };
  const notes = [];
  if (targetChapter && document.chapter && targetChapter !== document.chapter) notes.push(`你指定的卡片标题仍写第${targetChapter}章，当前为第${document.chapter}章，仅作跨章参考。`);
  if (isScene) notes.push('这是场内计划，当前姓名对照覆盖整份稿件；不据此认定具体场景的正面出场。');
  return { ...base, status: 'ready', scopeWarning: notes.join(''), message: '承接计划只作参考，人物增删、章节顺序和情节变化均由作者裁定。' };
}
export async function prepareCarry(store, document, { continuation = false, pair = '', card = '' } = {}) {
  const base = { requested: !!continuation, card: String(card || ''), blocking: false };
  if (!continuation) return { ...base, status: 'not_requested', message: '本次未选承接计划对照，不影响成稿确认。' };
  if (!String(card).trim()) return { ...base, status: 'not_selected', message: '尚未选择参考卡，不影响文风检查与成稿确认。' };
  if (typeof pair !== 'string' || pair.length > 600 || /[\r\n\0]/.test(pair)) return { ...base, status: 'invalid', message: '参考小节名称无效，本次未运行承接对照；不影响文风检查。' };
  try {
    const cardPath = await store.resolve(card), bytes = await fs.readFile(cardPath);
    if (bytes.length > 2_000_000) return { ...base, status: 'unavailable', message: '参考卡超过解析上限，本次未运行承接对照；不影响确认。' };
    return { ...base, ...selectCarrySection(decode(bytes).text, pair, document), cardPath, cardHash: hash(bytes) };
  } catch {
    return { ...base, status: 'unavailable', message: '参考卡不存在、不可读或不在当前作品内；承接参考未完成，不影响文风检查与成稿确认。' };
  }
}
