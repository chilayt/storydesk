import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError, stamp, hash } from './io.mjs';
import { prepareCarry } from './carry.mjs';

export const GATE_POLICY_VERSION = 2;

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
export async function findPython(configured) {
  const candidates = [configured, process.env.NOVEL_PYTHON, process.env.STORYDESK_BUNDLED_PYTHON].filter(Boolean);
  for (const p of candidates) if (await exists(p)) return p;
  return null;
}
export function integrity(text) {
  const problems = [];
  if (text.includes('"')) problems.push('存在ASCII直引号');
  if (/&#(?:x[0-9a-f]+|\d+);|&(?:quot|amp|lt|gt|apos);/i.test(text)) problems.push('存在HTML实体残留');
  if ((text.match(/“/g) || []).length !== (text.match(/”/g) || []).length) problems.push('中文引号左右不配对');
  let opened = false;
  for (const c of text) { if (c === '“') { if (opened) { problems.push('中文引号开闭顺序异常'); break; } opened = true; } if (c === '”') { if (!opened) { problems.push('中文引号开闭顺序异常'); break; } opened = false; } }
  return [...new Set(problems)];
}
export async function runGate(store, document, config, { continuation = false, pair = '', card = '', legacy = false, signal } = {}) {
  signal?.throwIfAborted();
  const local = integrity(document.text);
  const record = { id: `check_${Date.now()}`, gatePolicyVersion: GATE_POLICY_VERSION, documentId: document.id, sourceHash: document.hash, checked_at: stamp(), status: 'incomplete', code: null, output: '', parameters: { continuation, pair, card, legacy } };
  if (local.length) return { ...record, status: 'failed', code: 1, output: `数据完整性未通过：\n${local.join('\n')}` };
  if (!config.enabled) return { ...record, status: 'not_required', code: 0, output: '本作品未配置文风门禁，基础数据完整性检查已通过。' };
  const script = await store.resolve(config.script || '_tools/gate.py');
  if (!await exists(script)) return { ...record, output: '缺少门禁脚本，检查未完成。' };
  const python = await findPython(config.python);
  if (!python) return { ...record, output: '没有发现可用Python解释器。请在作品设置选择解释器；检查未完成。' };
  const target = await store.resolve(document.path);
  const bytes = await fs.readFile(target);
  if (hash(bytes) !== document.hash) throw new AppError('CONFLICT', '稿件已改变，请重新运行门禁');
  const args = [script, 'post', target];
  const scriptText = (await fs.readFile(script)).toString('utf8');
  const tools = scriptText.match(/^TOOLS\s*=\s*r?['"]([^'"]+)['"]/m)?.[1];
  record.dependencies = [];
  if (tools) {
    const dependencies = [path.join(tools, 'style_check.py'), path.join(tools, 'tang_gate.py'), path.join(path.dirname(tools), '_语料', 'tang_wordlist.json')];
    for (const file of dependencies) {
      if (!await exists(file)) return { ...record, output: `缺少门禁依赖：${file}\n检查未完成，不能确认成稿。` };
      record.dependencies.push({ path: file, hash: hash(await fs.readFile(file)) });
    }
  }
  if (legacy) args.push('--legacy');
  record.carry = await prepareCarry(store, document, { continuation, pair, card });
  if (record.carry.status === 'ready') args.push('--pair', record.carry.selectedTitle, '--card', record.carry.cardPath);
  record.scriptHash = hash(await fs.readFile(script));
  signal?.throwIfAborted();
  const output = await new Promise(resolve => {
    let stdout = '', stderr = ''; let done = false;
    const child = spawn(python, args, { cwd: store.root, windowsHide: true, signal, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ code: null, output: '门禁执行超时，检查未完成。\n' + stdout + stderr }); }, 120000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { if (stdout.length < 2000000) stdout += d; }); child.stderr.on('data', d => { if (stderr.length < 200000) stderr += d; });
    child.on('error', () => finish({ code: null, output: '无法启动门禁解释器，检查未完成。' }));
    child.on('close', code => finish({ code, output: stdout + stderr }));
  });
  signal?.throwIfAborted();
  const marker = output.output.split('\n').filter(l => l.startsWith('STORYDESK_GATE_JSON:')).at(-1);
  let structured; try { if (marker) structured = JSON.parse(marker.slice('STORYDESK_GATE_JSON:'.length)); } catch {}
  const coreOutput = output.output.split('【C】')[0].split('\n').filter(l => !l.startsWith('STORYDESK_GATE_JSON:')).join('\n');
  if (record.carry.status === 'ready') record.carry = { ...record.carry, ...(structured?.carry || { status: 'unverified', message: '外部检查器未返回可核实的承接参考状态；不视为已完成对照。' }), blocking: false };
  let status;
  if (structured?.version >= 2) {
    const valid = structured.style_complete === true && Number.isInteger(structured.hard_fail) && structured.hard_fail >= 0 && (structured.hard_fail > 0 || !/^\s*✗/m.test(coreOutput));
    status = valid && output.code === 0 && structured.hard_fail === 0 ? 'passed' : valid && output.code === 1 && structured.hard_fail > 0 ? 'failed' : 'incomplete';
  } else {
    const recognizable = /硬线(?:全过|全部通过)/.test(coreOutput);
    const incomplete = /未完成|执行失败|缺稿|文件不存在|Traceback|ModuleNotFoundError/.test(coreOutput) || output.code === 0 && !recognizable;
    status = output.code === 0 && !incomplete ? 'passed' : output.code === 1 && !incomplete ? 'failed' : 'incomplete';
  }
  const extra = record.carry.requested && record.carry.status !== 'passed' ? `\n【承接参考提醒 · 不阻断确认】${record.carry.message}${record.carry.scopeWarning || ''}\n` : '';
  return { ...record, ...output, output: output.output + extra, coreOutput, status, hardFail: structured?.hard_fail ?? null };
}
