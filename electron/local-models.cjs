const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const execute = promisify(execFile);
const launcher = process.env.NOVEL_LOCAL_LAUNCHER || '';

async function invoke(action, key) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-File', launcher, '-Action', action];
  if (key) args.push('-Model', key);
  try {
    const result = await execute(powershell, args, { windowsHide: true, timeout: 65_000, maxBuffer: 256_000, encoding: 'utf8' });
    return JSON.parse(result.stdout);
  } catch (error) {
    let message;
    try { message = JSON.parse(error.stdout).error; } catch { /* Avoid displaying raw runtime output. */ }
    throw new Error(message || '本机模型启动器未响应，请检查启动器版本和路径');
  }
}

async function localModels() {
  if (process.env.NOVEL_TEST_MODE && !process.env.NOVEL_LOCAL_LAUNCHER) return { launcher, models: [] };
  try { await fs.access(launcher); } catch { return { launcher, models: [] }; }
  const result = await invoke('List');
  const models = Array.isArray(result.models) ? result.models.filter(p => /^[\w-]{1,60}$/.test(p.id) &&
    typeof p.model === 'string' && p.model.length > 0 && Number.isInteger(p.port) && p.port > 0 && p.port < 65536 && p.port !== 3425) : [];
  return { launcher, models: models.map(p => ({ ...p, baseUrl: `http://127.0.0.1:${p.port}/v1` })) };
}

async function runningModel(preset) {
  try {
    const response = await fetch(`${preset.baseUrl}/models`, { signal: AbortSignal.timeout(1100), redirect: 'error' });
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data.data) && data.data.some(item => item.id === preset.model);
  } catch { return false; }
}

async function localStatus() {
  const { models } = await localModels();
  if (!models.length) return { active: null, ready: [] };
  const [state, ...ready] = await Promise.all([invoke('Status'), ...models.map(runningModel)]);
  return { active: models.find(model => model.id === state.active)?.id || null,
    ready: models.filter((_, index) => ready[index]).map(model => model.id) };
}

async function localStart(key) {
  const { models } = await localModels();
  const preset = models.find(model => model.id === key && model.available);
  if (!preset) throw new Error('未登记的本机模型预设');
  const state = await invoke('Status');
  const active = models.find(model => model.id === state.active)?.id;
  if (active && active !== key) await localStop(active);
  if (await runningModel(preset)) return preset;
  if (active !== key) await invoke('Start', preset.id);
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await runningModel(preset)) return preset;
    if (attempt % 4 === 0 && (await invoke('Status')).active !== preset.id) {
      throw new Error('模型启动进程已退出，请查看桌面启动器的日志');
    }
    await delay(1000);
  }
  throw new Error('模型尚未就绪，请在桌面启动器查看状态');
}

async function localStop(key) {
  const { models } = await localModels();
  const preset = models.find(model => model.id === key);
  if (!preset) throw new Error('未登记的本机模型预设');
  const result = await invoke('Stop', preset.id);
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!await runningModel(preset)) return result;
    await delay(400);
  }
  throw new Error('启动器已提交停止，模型接口仍在响应，请检查本地模型服务状态。');
}

module.exports = { localModels, localStatus, localStart, localStop };
