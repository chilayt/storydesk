import { AppError } from './io.mjs';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = v => v === undefined ? undefined : structuredClone(v);

// Reverse only fields changed by this batch. Keep later, unrelated user changes.
export function inverseProject(before, after, current, route = '') {
  if (equal(before, after)) return clone(current);
  if (!route) {
    const result = clone(current);
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
      if (['documents', 'reader', 'externalChanges'].includes(key)) continue;
      const value = inverseProject(before?.[key], after?.[key], current?.[key], key);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isObject(before) && isObject(after) && isObject(current)) {
    const result = clone(current);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = inverseProject(before[key], after[key], current[key], `${route}.${key}`);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current) && [...before, ...after, ...current].every(x => isObject(x) && typeof x.id === 'string')) {
    const result = clone(current); const ids = new Set([...before, ...after].map(x => x.id));
    for (const id of ids) {
      const b = before.find(x => x.id === id), a = after.find(x => x.id === id), c = current.find(x => x.id === id);
      const value = inverseProject(b, a, c, `${route}[${id}]`); const index = result.findIndex(x => x.id === id);
      if (value === undefined) { if (index >= 0) result.splice(index, 1); }
      else if (index < 0) result.push(value); else result[index] = value;
    }
    return result;
  }
  if (!equal(current, after)) throw new AppError('CONFLICT', '此批次涉及的管理资料后来又被修改，未覆盖。', { field: route });
  return clone(before);
}
