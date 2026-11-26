import { randomUUID } from 'node:crypto';

const toolTag = /<\/?(?:(?:[|｜]DSML[|｜])|(?:tool_call|arg_key|arg_value)(?=[\s>/]|$))/iu;
const tagStarts = ['<think>', '</think>', ...['<', '</'].flatMap(prefix =>
  ['tool_call', 'arg_key', 'arg_value', '|dsml|', '｜dsml｜'].map(name => prefix + name))];

export function writingToolIndex(text) {
  return text.search(toolTag);
}

export function waitingTagLength(text) {
  const tail = text.slice(-12).toLowerCase();
  for (let length = tail.length; length > 0; length--) {
    if (tagStarts.some(tag => tag.startsWith(tail.slice(-length)))) return length;
  }
  return 0;
}

const textTools = new Set(['find_outline', 'find_characters', 'find_setting', 'read_reference', 'read_conversation_history', 'prepare_draft_action',
  'find_workspace_files', 'open_workspace_file', 'prepare_workspace_edit', 'prepare_workspace_archive', 'create_writing_file', 'prepare_wording_review']);

function validParameter(value, rule) {
  if (rule.type === 'string') return typeof value === 'string' && value.length >= (rule.minLength ?? 0) && value.length <= (rule.maxLength ?? Infinity);
  if (rule.type === 'integer') return Number.isSafeInteger(value) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity);
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'array') return Array.isArray(value) && value.length >= (rule.minItems ?? 0) &&
    value.length <= (rule.maxItems ?? Infinity) && value.every(item => validParameter(item, rule.items));
  return rule.type === 'object' && value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(rule.properties, key) && validParameter(item, rule.properties[key])) &&
    !rule.required?.some(key => !Object.hasOwn(value, key));
}

export function parseWritingTextCalls(raw, declaredTools) {
  // Only the current turn's declared tools participate, with the same version and permission checks as native calls.
  const normalized = raw.trim().replace(/<([/]?)[|｜]DSML[|｜]\s*/giu, '<$1DSML_');
  const wrapper = normalized.match(/^<DSML_(calls|function_calls)>\s*([\s\S]*?)\s*<\/DSML_\1>$/u);
  if (!wrapper) return null;
  const invocations = /\s*<DSML_invoke\s+name="([a-z_]+)"\s*>\s*([\s\S]*?)\s*<\/DSML_invoke>\s*/uy;
  const params = /\s*<DSML_parameter\s+name="([a-z_]+)"\s+string="(true|false)"\s*>([\s\S]*?)<\/DSML_parameter>\s*/uy;
  const calls = [];
  for (let pos = 0; pos < wrapper[2].length;) {
    invocations.lastIndex = pos;
    const call = invocations.exec(wrapper[2]);
    if (!call || !textTools.has(call[1])) return null;
    pos = invocations.lastIndex;
    const schema = declaredTools.find(tool => tool.function?.name === call[1])?.function?.parameters;
    if (!schema) return null;
    const args = Object.create(null);
    for (let cursor = 0; cursor < call[2].length;) {
      params.lastIndex = cursor;
      const param = params.exec(call[2]);
      if (!param || param[1] in args || !Object.hasOwn(schema.properties, param[1]) || /<\/?DSML_/u.test(param[3])) return null;
      cursor = params.lastIndex;
      const [, key, isString, value] = param;
      const rule = schema.properties[key];
      if (isString === 'true') {
        if (rule.type !== 'string' || !validParameter(value, rule) || !value.trim()) return null;
        args[key] = value;
      } else {
        try { args[key] = JSON.parse(value); } catch { return null; }
        if (rule.type === 'string' || !validParameter(args[key], rule)) return null;
      }
    }
    if (schema.required?.some(key => !(key in args))) return null;
    calls.push({ index: calls.length, id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function',
      function: { name: call[1], arguments: JSON.stringify(args) } });
  }
  return calls.length ? calls : null;
}
