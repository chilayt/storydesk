import { AppError } from './io.mjs';
import { checkGoBilling } from './model-connections.mjs';
import { redactProviderMessage } from './provider-errors.mjs';
import { parseWritingTextCalls, waitingTagLength, writingToolIndex } from './cowriting-tool-text.mjs';

function hasModelOutput(delta) {
  if (!delta) return false;
  return [delta.content, delta.reasoning_content, delta.reasoning, delta.reasoning_text, delta.thinking, delta.refusal]
    .some(value => typeof value === 'string' && value.length > 0) ||
    (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) ||
    (Array.isArray(delta.tool_calls) && delta.tool_calls.some(call =>
      call?.id || call?.function?.name || call?.function?.arguments || call?.custom?.name || call?.custom?.input)) ||
    !!(delta.function_call?.name || delta.function_call?.arguments);
}

export function writingPacketFailure(detail, key) {
  const message = redactProviderMessage(typeof detail === 'string' ? detail : detail?.message, key);
  const code = redactProviderMessage(detail?.code || detail?.type, key);
  return new AppError('AI_STREAM_PROVIDER', (message || '模型服务报告推理失败') + (code ? `（${code}）` : ''), { providerCode: code });
}

export function watchWritingStream(response, { signal, fail, go, key, declaredTools = [], onOutput }) {
  const body = response.body;
  if (!body) throw new AppError('AI_FORMAT', '模型响应没有可读取的内容');
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let pending = '', dataLines = [], eventName = '', finished = false, ended = false;
  let prefix = '', rawTool = null, nativeTool = false, inThought = false, invalidTools = false;

  function visibleDelta(text, final) {
    const combined = prefix + text;
    prefix = '';
    if (rawTool !== null) {
      rawTool += combined;
      return '';
    }
    const waiting = waitingTagLength(combined);
    const hold = final && waiting < 4 ? 0 : waiting;
    if (hold && final) invalidTools = true;
    else if (hold) prefix = combined.slice(-hold);
    const piece = hold ? combined.slice(0, -hold) : combined;
    let visible = '';
    for (const part of piece.split(/(<\/?think>)/giu)) {
      if (part.toLowerCase() === '<think>') inThought = true;
      else if (part.toLowerCase() === '</think>') inThought = false;
      else if (!inThought) visible += part;
    }
    const index = writingToolIndex(visible);
    if (index < 0) return visible;
    rawTool = visible.slice(index);
    return visible.slice(0, index);
  }

  function noteEnd() {
    if (invalidTools) fail(new AppError('AI_TOOL_PROTOCOL', '模型返回了无法使用的工具指令，本轮回答未完成。原问题已保留。'));
  }

  function acceptLine(line, output) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''));
    else if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line === '') emitEvent(output);
  }

  function emitEvent(output) {
    const payload = dataLines.join('\n'), event = eventName;
    dataLines = [];
    eventName = '';
    if (payload.trim() === '[DONE]') {
      if (!finished) throw new AppError('AI_STREAM_INCOMPLETE', '服务结束了响应流，未返回模型完成标记');
      noteEnd();
      output.enqueue(encoder.encode('data: [DONE]\n\n'));
      ended = true;
      output.terminate();
      return;
    }
    if (event === 'ping' || event === 'keepalive' || !payload && event !== 'error') return;
    let packet;
    try { packet = JSON.parse(payload); }
    catch {
      if (event === 'error') throw new AppError('AI_STREAM_PROVIDER', '模型服务报告流式响应失败');
      throw new AppError('AI_FORMAT', '模型返回了无法解析的流式数据');
    }
    if (packet?.error || packet?.type === 'error' || event === 'error') throw writingPacketFailure(packet?.error || packet, key);
    if (go) checkGoBilling(packet?.usage);
    const choice = packet?.choices?.[0];
    if (choice) {
      const delta = choice.delta ||= {};
      const hasOutput = hasModelOutput(delta);
      nativeTool ||= !!delta.tool_calls?.length;
      const wasInlineThought = inThought;
      delta.content = visibleDelta(typeof delta.content === 'string' ? delta.content : '', !!choice.finish_reason) || null;
      if (delta.content?.trim()) onOutput('visible');
      else if (hasOutput) onOutput(nativeTool || rawTool !== null ? 'tool' :
        wasInlineThought || inThought || delta.reasoning || delta.reasoning_content || delta.reasoning_text ||
        delta.reasoning_details || delta.thinking ? 'reasoning' : 'output');
      if (choice.finish_reason) {
        finished = true;
        if (choice.finish_reason === 'content_filter') {
          fail(new AppError('AI_CONTENT_FILTER', '模型服务因内容过滤结束了本轮回复。', { providerCode: 'content_filter' }));
        }
        if (rawTool !== null && !nativeTool && ['stop', 'tool_calls'].includes(choice.finish_reason)) {
          const calls = parseWritingTextCalls(rawTool, declaredTools);
          if (calls) { delta.tool_calls = calls; choice.finish_reason = 'tool_calls'; }
          else invalidTools = true;
        }
      }
    }
    output.enqueue(encoder.encode('data: ' + JSON.stringify(packet) + '\n\n'));
  }

  const source = body.pipeThrough(new TransformStream({
    transform(chunk, output) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        acceptLine(line.replace(/\r$/u, ''), output);
        if (ended) break;
      }
    },
    flush(output) {
      pending += decoder.decode();
      if (pending) acceptLine(pending.replace(/\r$/u, ''), output);
      if (dataLines.length || eventName) emitEvent(output);
      if (!finished) throw new AppError('AI_STREAM_INCOMPLETE', '模型响应流提前结束，未返回完成标记');
      noteEnd();
    },
  }), { signal }).getReader();

  return new Response(new ReadableStream({
    async pull(output) {
      try {
        const { value, done } = await source.read();
        if (done) output.close();
        else output.enqueue(value);
      } catch (error) {
        fail(error);
        output.error(error);
      }
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  }), { status: response.status, headers: response.headers });
}

export function visibleWritingText(message, streaming = false) {
  const text = message?.content?.filter(part => part.type === 'text').map(part => part.text).join('') || '';
  let visible = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  const index = writingToolIndex(visible);
  if (index >= 0) visible = visible.slice(0, index);
  if (streaming) {
    const hold = waitingTagLength(visible);
    if (hold) visible = visible.slice(0, -hold);
  }
  return visible.trim();
}
