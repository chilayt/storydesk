'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { maxSeconds } = require('../core/speech-config.json');

const runtime = 'sherpa-onnx-v2.0.1-win-x64-shared-MD-Release-no-tts';
const modelFolder = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const maxBytes = 44 + maxSeconds * 16000 * 2;

async function resolveSpeechRuntime(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
  for (const home of [path.join(root, 'runtime', 'asr'), root]) {
    const executable = path.join(home, runtime, 'bin', 'sherpa-onnx-offline.exe');
    const model = path.join(home, modelFolder, 'model.int8.onnx');
    const tokens = path.join(home, modelFolder, 'tokens.txt');
    const files = await Promise.all([executable, model, tokens].map(file => fs.stat(file).catch(() => null)));
    if (files.every(file => file?.isFile()) && files[1].size > 200000000 && files[2].size > 100000) {
      return { home, executable, model, tokens };
    }
  }
  return null;
}

async function findSpeechRuntime(selectedRoot) {
  for (const root of [selectedRoot, process.env.NOVEL_ASR_ROOT]) {
    const engine = await resolveSpeechRuntime(root);
    if (engine) return engine;
  }
  return null;
}

function requireWave(audio) {
  const bytes = audio instanceof Uint8Array ? Buffer.from(audio) : null;
  if (!bytes || bytes.length < 3244 || bytes.length > maxBytes ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt16LE(20) !== 1 ||
      bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000 ||
      bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data' ||
      bytes.readUInt32LE(40) !== bytes.length - 44) {
    throw new Error('录音时长或格式无效，请重新录音');
  }
  return bytes;
}

function runSenseVoice(engine, audio, seconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine.executable, [
      '--tokens=' + path.relative(engine.home, engine.tokens),
      '--sense-voice-model=' + path.relative(engine.home, engine.model),
      '--sense-voice-language=zh', '--sense-voice-use-itn=true', '--num-threads=2', '--debug=false', audio
    ], { cwd: engine.home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stopReason = '';
    const timer = setTimeout(() => { stopReason = '本机识别超时，请分段重试'; child.kill(); }, Math.max(45, seconds * 1.5) * 1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => {
      if (output.length + value.length > 65536) { stopReason = '本机识别返回异常'; child.kill(); }
      else output += value;
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动本机 SenseVoice')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (stopReason || code !== 0) { reject(new Error(stopReason || '本机识别失败，请重试')); return; }
      let result;
      try { result = JSON.parse(output.trim()); }
      catch { reject(new Error('无法读取本机识别结果')); return; }
      const text = String(result.text || '').replace(/<\|[^>]*\|>/g, '').trim();
      if (!text || /^[\p{P}\p{Z}\s]+$/u.test(text) || result.event && !/^(?:<\|)?Speech(?:\|>)?$/i.test(result.event)) {
        reject(new Error('没有识别到清楚的话语，请再录一次'));
        return;
      }
      resolve({ text: text.slice(0, 2500), engine: 'SenseVoice' });
    });
  });
}

async function transcribeSpeech(audio, engine) {
  if (!engine) throw new Error('未找到本机 SenseVoice。可选择已有的语音运行目录');
  const bytes = requireWave(audio);
  const temp = os.tmpdir();
  let file = path.join(temp, 'storydesk-voice-' + randomUUID() + '.wav');
  let relative = path.relative(engine.home, file);
  // The native recognizer expects ASCII arguments on Windows.
  if (/[^\x20-\x7e]/.test(relative)) {
    const directory = path.join(engine.home, 'requests');
    await fs.mkdir(directory, { recursive: true });
    file = path.join(directory, 'storydesk-voice-' + randomUUID() + '.wav');
    relative = path.relative(engine.home, file);
  }
  await fs.writeFile(file, bytes, { flag: 'wx' });
  try { return await runSenseVoice(engine, relative, (bytes.length - 44) / 32000); }
  finally { await fs.unlink(file).catch(() => {}); }
}

module.exports = { resolveSpeechRuntime, findSpeechRuntime, transcribeSpeech };
