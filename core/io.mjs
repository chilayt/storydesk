import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const uid = prefix => `${prefix}_${randomUUID()}`;
export const stamp = () => new Date().toISOString();
export class AppError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export async function bytesOrNull(file) {
  try { return await fs.readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function jsonOr(file, fallback) {
  const b = await bytesOrNull(file);
  if (!b) return fallback;
  try { return JSON.parse(b.toString('utf8')); } catch { throw new AppError('DAMAGED_DATA', `管理记录损坏：${path.basename(file)}`); }
}
export function decode(bytes) {
  const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AppError('ENCODING', '文件不是有效UTF-8；为避免损坏，暂不允许覆盖。'); }
  return { text: text.replace(/^\uFEFF/, ''), bom, newline: text.includes('\r\n') ? '\r\n' : '\n' };
}
export function encode(text, format = {}) {
  const normalized = format.newline ? text.replace(/\r?\n/g, format.newline) : text;
  return Buffer.from((format.bom ? '\uFEFF' : '') + normalized, 'utf8');
}
async function durableWrite(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(tmp, file); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
}
export async function atomicJson(file, value) { await durableWrite(file, Buffer.from(JSON.stringify(value, null, 2))); }

export class FileStore {
  constructor(root, management = '_创作管理') {
    this.root = path.resolve(root); this.management = management; this.lock = null;
    if (!/^[_\p{L}\p{N}-]{1,40}$/u.test(management)) throw new AppError('PATH', '管理目录名称无效');
  }
  async init() {
    this.root = await fs.realpath(this.root);
    const folder = await this.resolve(this.management);
    await fs.mkdir(folder, { recursive: true });
    const lockPath = await this.resolve(`${this.management}/workspace.lock`);
    const old = await jsonOr(lockPath, null);
    if (old) {
      let live = true;
      try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
      if (live) throw new AppError('WORKSPACE_BUSY', '此作品已在另一个程序中打开。');
      await fs.unlink(lockPath);
    }
    this.lock = await fs.open(lockPath, 'wx');
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, started: stamp() }));
    return this.recover();
  }
  async close() {
    if (this.lock) { await this.lock.close(); await fs.unlink(path.join(this.root, this.management, 'workspace.lock')).catch(() => {}); this.lock = null; }
  }
  async resolve(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new AppError('PATH', '路径必须位于所选作品内');
    const resolved = path.resolve(this.root, relative);
    const inside = p => { const rel = path.relative(this.root, p); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
    if (!inside(resolved)) throw new AppError('PATH', '禁止访问作品目录之外的文件');
    let parent = resolved;
    while (true) {
      try { const physical = await fs.realpath(parent); if (!inside(physical)) throw new AppError('PATH', '符号链接指向作品之外，已停止访问'); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; const next = path.dirname(parent); if (next === parent) throw e; parent = next; }
    }
    if (relative.split(/[\\/]/).some(p => ['.git', '.agents', '.codex', '.aws', 'node_modules'].includes(p))) throw new AppError('PATH', '此目录不属于作品资料');
    return resolved;
  }
  async read(relative) { return bytesOrNull(await this.resolve(relative)); }
  async batch(label, changes, { afterWrite } = {}) {
    const recovery = await this.recover(false);
    if (recovery.length) throw new AppError('RECOVERY_REQUIRED', '存在未完成的写入，请先处理恢复事项。', { recovery });
    const unique = new Set();
    const id = uid('commit'); const dir = await this.resolve(`${this.management}/历史/${id}`);
    const entries = [];
    for (const change of changes) {
      if (unique.has(change.path)) throw new AppError('DUPLICATE_PATH', '同一批次包含重复目标文件');
      unique.add(change.path);
      const target = await this.resolve(change.path); const before = await bytesOrNull(target);
      const actual = before ? hash(before) : null;
      if (actual !== change.expectedHash) throw new AppError('CONFLICT', '文件已被其他操作修改，未覆盖。', { path: change.path, expected: change.expectedHash, actual });
      const after = change.bytes === null ? null : Buffer.isBuffer(change.bytes) ? change.bytes : Buffer.from(change.text ?? change.bytes ?? '');
      if (actual === (after ? hash(after) : null)) continue;
      entries.push({ path: change.path, beforeHash: actual, afterHash: after ? hash(after) : null, before, after });
    }
    if (!entries.length) return { id: null, status: 'unchanged', files: [] };
    await fs.mkdir(dir, { recursive: true });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.before) {
        await durableWrite(path.join(dir, `${i}.before`), e.before);
        if (!e.path.replaceAll('\\', '/').startsWith(`${this.management}/`)) {
          await durableWrite(await this.resolve(`_archive/_备份_创作管理_${day}/${id}/${e.path}`), e.before);
        }
      }
      if (e.after) await durableWrite(path.join(dir, `${i}.after`), e.after);
    }
    const manifest = { id, label, created_at: stamp(), status: 'prepared', files: entries.map(({ path: p, beforeHash, afterHash }) => ({ path: p, beforeHash, afterHash, applied: false })) };
    await atomicJson(path.join(dir, 'commit.json'), manifest);
    try {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]; const target = await this.resolve(e.path); const now = await bytesOrNull(target);
        if ((now ? hash(now) : null) !== e.beforeHash) throw new AppError('CONFLICT', '写入期间检测到外部修改；原文已保留。', { path: e.path });
        if (e.after) await durableWrite(target, e.after); else await fs.unlink(target);
        manifest.files[i].applied = true; manifest.status = 'writing';
        await atomicJson(path.join(dir, 'commit.json'), manifest);
        if (afterWrite) await afterWrite(i);
      }
      manifest.status = 'committed'; manifest.completed_at = stamp();
      await atomicJson(path.join(dir, 'commit.json'), manifest);
    } catch (e) {
      manifest.status = 'recovery_needed'; manifest.error = e.message;
      await atomicJson(path.join(dir, 'commit.json'), manifest);
      throw new AppError('RECOVERY_REQUIRED', '批次尚未完成，已保留全部快照。请到更新中心恢复。', { batchId: id, reason: e.message });
    }
    return manifest;
  }
  async history() {
    const dir = await this.resolve(`${this.management}/历史`);
    let items; try { items = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const records = [];
    for (const item of items) if (item.isDirectory() && item.name.startsWith('commit_')) {
      const record = await jsonOr(await this.resolve(`${this.management}/历史/${item.name}/commit.json`), null);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async recover(apply = true) {
    const pending = (await this.history()).filter(r => ['prepared', 'writing', 'recovery_needed'].includes(r.status));
    const conflicts = [];
    for (const record of pending) {
      const actual = [];
      for (const e of record.files) { const b = await this.read(e.path); actual.push(b ? hash(b) : null); }
      const divergent = record.files.some((e, i) => ![e.beforeHash, e.afterHash].includes(actual[i]));
      if (divergent || !apply) { conflicts.push({ ...record, divergent }); continue; }
      for (let i = 0; i < record.files.length; i++) {
        const e = record.files[i]; if (actual[i] === e.afterHash) continue;
        const target = await this.resolve(e.path);
        if (e.afterHash === null) await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        else { const snapshot = await fs.readFile(await this.resolve(`${this.management}/历史/${record.id}/${i}.after`)); if (hash(snapshot) !== e.afterHash) throw new AppError('DAMAGED_SNAPSHOT', '待恢复快照损坏，已停止写入'); await durableWrite(target, snapshot); }
        e.applied = true;
      }
      record.status = 'committed'; record.recovered_at = stamp();
      await atomicJson(await this.resolve(`${this.management}/历史/${record.id}/commit.json`), record);
    }
    return conflicts;
  }
  async restore(id) {
    const record = (await this.history()).find(r => r.id === id);
    if (!record || record.status !== 'committed') throw new AppError('RESTORE', '只能撤销已完成的批次');
    const changes = [];
    for (let i = 0; i < record.files.length; i++) {
      const e = record.files[i];
      const before = e.beforeHash ? await fs.readFile(await this.resolve(`${this.management}/历史/${id}/${i}.before`)) : null;
      if (before && hash(before) !== e.beforeHash) throw new AppError('DAMAGED_SNAPSHOT', '恢复快照损坏，未覆盖文件');
      changes.push({ path: e.path, expectedHash: e.afterHash, bytes: before });
    }
    return this.batch(`撤销：${record.label}`, changes);
  }
  async abandonRecovery(id) {
    const record = (await this.history()).find(r => r.id === id && ['prepared', 'writing', 'recovery_needed'].includes(r.status));
    if (!record) throw new AppError('RESTORE', '没有找到未完成批次');
    for (let i = 0; i < record.files.length; i++) {
      const e = record.files[i], current = await this.read(e.path), actual = current ? hash(current) : null;
      if (actual !== e.afterHash || actual === e.beforeHash) continue;
      const target = await this.resolve(e.path);
      if (e.beforeHash) await durableWrite(target, await fs.readFile(await this.resolve(`${this.management}/历史/${id}/${i}.before`)));
      else await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    record.status = 'abandoned_external_retained'; record.resolved_at = stamp();
    await atomicJson(await this.resolve(`${this.management}/历史/${id}/commit.json`), record);
    return record;
  }
}
