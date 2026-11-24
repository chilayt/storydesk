import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, stamp, uid } from './io.mjs';

export const textFileExtensions = ['md', 'markdown', 'txt'];
const maxTextBytes = 5_000_000;
const importFolder = '创作资料库/导入文本';
export const isImportedTextPath = relative => typeof relative === 'string' && relative.startsWith(importFolder + '/');

export async function readSelectedText(file, label = '文本文件') {
  const extension = path.extname(file);
  const title = path.basename(file, extension);
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !textFileExtensions.includes(extension.toLowerCase().slice(1))) {
      throw new AppError('VALIDATION', `「${title}」请选择 Markdown 或 TXT 文件`);
    }
    if (stat.size > maxTextBytes) throw new AppError('VALIDATION', `「${title}」超过 5 MB`);
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new AppError('CONFLICT', `「${title}」正在变化，请重新选择`);
    const encoding = buffer[0] === 255 && buffer[1] === 254 ? 'utf-16le'
      : buffer[0] === 254 && buffer[1] === 255 ? 'utf-16be' : 'utf-8';
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(0, size)); }
    catch { throw new AppError('ENCODING', `「${title}」编码无法识别，请先另存为 UTF-8`); }
    if (!text.trim() || text.includes('\0')) throw new AppError('VALIDATION', `「${title}」${label}为空或不是纯文本`);
    return { title, text };
  } finally { await handle.close(); }
}

function fileStem(title) {
  const stem = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ').trim()).slice(0, 60).join('')
    .replace(/^[.\s]+|[.\s]+$/gu, '') || '未命名资料';
  return /^(?:con|nul|prn|aux|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(stem) ? `资料-${stem}` : stem;
}

export async function importTextDocuments(workspace, files) {
  const next = structuredClone(workspace.project);
  const folder = await workspace.store.resolve(importFolder);
  const entries = await fs.readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const occupied = new Set(entries.map(name => name.toLowerCase()));
  for (const retired of Object.values(next.sourceHistory?.retired || {})) {
    const name = [retired.path, retired.archivePath];
    for (const candidate of name.filter(value => value?.startsWith(importFolder + '/'))) {
      occupied.add(path.posix.basename(candidate).toLowerCase());
    }
  }
  const changes = [], results = new Set();
  const importedAt = stamp();
  for (const { title, text } of files) {
    const stem = fileStem(title);
    let name = `${stem}.md`, suffix = 2;
    while (occupied.has(name.toLowerCase())) name = `${stem}（${suffix++}）.md`;
    occupied.add(name.toLowerCase());
    const relative = `${importFolder}/${name}`;
    next.documents[relative] = { id: uid('doc'), path: relative, kind: 'reference', importedAt, importOrder: changes.length };
    changes.push({ path: relative, expectedHash: null, text });
    results.add(relative);
  }
  if (!next.sources.some(source => source.path === importFolder && source.kind === 'reference' && !source.readOnly)) {
    next.sources.unshift({ path: importFolder, kind: 'reference', depth: 0 });
  }
  await workspace.commit('导入文本资料', changes, next);
  return workspace.documents.filter(doc => results.has(doc.path)).map(({ id, hash, title, path }) => ({
    id, hash, title: title.slice(0, 240), path,
  }));
}
