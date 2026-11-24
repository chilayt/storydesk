import { useEffect, useRef, useState } from 'react';
import type { AppContext } from './domain';
import { Icon } from './components';
import speechConfig from '../core/speech-config.json';

const duration = speechConfig.maxSeconds;
const sampleRate = 16000;

function wave(chunks: Float32Array[], rate: number) {
  const count = Math.min(chunks.reduce((sum, chunk) => sum + chunk.length, 0), duration * rate);
  const data = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= count) break;
    const visible = chunk.subarray(0, count - offset);
    data.set(visible, offset);
    offset += visible.length;
  }
  const length = Math.floor(count * sampleRate / rate), buffer = new Uint8Array(44 + length * 2);
  const view = new DataView(buffer.buffer);
  const tag = (at: number, value: string) => buffer.set(new TextEncoder().encode(value), at);
  tag(0, 'RIFF'); view.setUint32(4, buffer.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * rate / sampleRate);
    const end = Math.min(count, Math.max(start + 1, Math.floor((i + 1) * rate / sampleRate)));
    let sum = 0;
    for (let at = start; at < end; at++) sum += data[at];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

type Capture = {
  stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode;
  muted: GainNode; chunks: Float32Array[]; timer: ReturnType<typeof setTimeout>;
};

function release(record: Capture) {
  clearTimeout(record.timer);
  record.processor.onaudioprocess = null;
  record.source.disconnect(); record.processor.disconnect(); record.muted.disconnect();
  record.stream.getTracks().forEach(track => track.stop());
  void record.context.close().catch(() => {});
}

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'recognizing';

export function VoiceInput({ ctx, disabled, phase, onPhase, onText, sendRecording }: {
  ctx: AppContext; disabled: boolean; phase: VoicePhase; onPhase: (phase: VoicePhase) => void;
  onText: (text: string, send: boolean) => void;
  sendRecording: React.RefObject<(() => void) | null>;
}) {
  const [needsEngine, setNeedsEngine] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const capture = useRef<Capture | null>(null);
  const generation = useRef(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  useEffect(() => () => {
    generation.current++;
    sendRecording.current = null;
    if (capture.current) { release(capture.current); capture.current = null; }
    onPhase('idle');
  }, [onPhase, sendRecording]);

  async function finish(send = false) {
    const record = capture.current;
    if (!record) return;
    capture.current = null;
    sendRecording.current = null;
    const token = generation.current;
    const rate = record.context.sampleRate;
    release(record);
    onPhase('recognizing');
    try {
      const result = await ctx.call('transcribeSpeech', { audio: wave(record.chunks, rate) });
      if (generation.current === token) {
        const text = result.text?.trim();
        if (text) onTextRef.current(text, send);
        else ctx.notify('没有识别到语音，请再试一次。', true);
      }
    } catch (error) {
      if (generation.current === token) ctx.notify((error as Error).message, true);
    } finally {
      if (generation.current === token) onPhase('idle');
    }
  }
  async function start() {
    const token = ++generation.current;
    onPhase('requesting');
    setLevels(Array(9).fill(0));
    let stream: MediaStream | undefined, context: AudioContext | undefined;
    try {
      const status = await ctx.call('speechStatus');
      if (generation.current !== token) return;
      setNeedsEngine(!status.available);
      if (!status.available) throw new Error('请选择本机已有的 SenseVoice 识别目录');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (generation.current !== token) { stream.getTracks().forEach(track => track.stop()); return; }
      context = new AudioContext();
      await context.resume();
      if (generation.current !== token) {
        stream.getTracks().forEach(track => track.stop()); await context.close(); return;
      }
      const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1);
      const muted = context.createGain(), chunks: Float32Array[] = [];
      muted.gain.value = 0;
      processor.onaudioprocess = event => {
        const samples = event.inputBuffer.getChannelData(0);
        chunks.push(samples.slice());
        let power = 0;
        for (let i = 0; i < samples.length; i += 8) power += samples[i] * samples[i];
        const level = Math.min(1, Math.sqrt(power / Math.ceil(samples.length / 8)) * 5);
        setLevels(history => [...history.slice(1), level]);
      };
      source.connect(processor); processor.connect(muted); muted.connect(context.destination);
      capture.current = { stream, context, source, processor, muted, chunks, timer: setTimeout(() => void finish(), duration * 1000) };
      sendRecording.current = () => void finish(true);
      onPhase('recording');
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (context) await context.close().catch(() => {});
      if (generation.current === token) {
        const problem = error as Error;
        ctx.notify(problem.name === 'NotAllowedError' ? '麦克风权限未开启，请检查 Windows 的麦克风隐私设置' : problem.message, true);
        onPhase('idle');
      }
    }
  }
  const label = { idle: '语音输入', requesting: '正在打开麦克风', recording: '停止录音并转写', recognizing: '正在转写' }[phase];
  return <div className="writing-voice">
    {phase === 'recording' && <div className="voice-levels" role="img" aria-label="正在录音，实时音量">
      {levels.map((level, index) => <span key={index} style={{ height: 3 + 15 * level }}/>)}
    </div>}
    <button type="button" className={phase === 'recording' ? 'voice-stop' : ''}
      aria-label={label} title={label}
      disabled={phase === 'requesting' || phase === 'recognizing' || (disabled && phase === 'idle')}
      onClick={() => void (phase === 'recording' ? finish() : start())}>
      <Icon name={phase === 'recording' ? 'stop' : phase === 'idle' ? 'mic' : 'clock'} size={17}/>
    </button>
    {needsEngine && phase === 'idle' && !disabled && <button type="button" className="text-button" onClick={async () => {
      try { if (await ctx.call('pickSpeechRuntime')) setNeedsEngine(false); }
      catch (error) { ctx.notify((error as Error).message, true); }
    }}>选择识别目录</button>}
  </div>;
}