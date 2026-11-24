import { AppError, decode, hash } from './io.mjs';
import { isMapPath, WORLD_SOURCE_KINDS } from './catalog.mjs';
import { sourceFile } from './source-lifecycle.mjs';

export const LOCATION_MAP_INDEX = '00-项目导航/地点地图.json';
const normal = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase() : '';
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

function relativePath(value, accepts) {
  if (typeof value !== 'string' || /[\\:\0\r\n]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..') || !accepts(value)) {
    throw new Error('地点地图使用作品内的资料路径');
  }
  return value;
}

function label(value, maxLength = 140) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error('地点资料标签无效');
  return value.trim();
}

function resolveDocument(workspace, path, accept) {
  const move = workspace.project.sourceHistory?.moves.find(entry => pathKey(entry.from) === pathKey(path));
  return workspace.documents.find(doc => accept(doc) &&
    (move ? doc.id === move.documentId : pathKey(doc.path) === pathKey(path)));
}

export async function loadLocationMaps(workspace) {
  const bytes = await workspace.store.read(LOCATION_MAP_INDEX);
  if (!bytes) return { hash: null, places: [], historicalPaths: [] };
  const indexHash = hash(bytes);
  try {
    const data = JSON.parse(decode(bytes).text);
    if (data.version !== 1 || !Array.isArray(data.places)) throw new Error('地点地图清单格式无效');
    const markdown = value => /\.md$/i.test(value);
    const historicalPaths = (data.historicalPaths || []).map(value => {
      const relative = relativePath(value, markdown);
      return resolveDocument(workspace, relative, doc => WORLD_SOURCE_KINDS.has(doc.kind))?.path || relative;
    });
    const places = data.places.map(entry => {
      const id = label(entry.id, 60), name = label(entry.name);
      const aliases = (entry.aliases || []).map(value => label(value, 60));
      const mapPath = relativePath(entry.map.path, isMapPath);
      const map = resolveDocument(workspace, mapPath, doc => doc.kind === 'attachment');
      const sources = (entry.sources || []).map(row => {
        const original = relativePath(row.path, markdown);
        const registered = resolveDocument(workspace, original, doc => WORLD_SOURCE_KINDS.has(doc.kind) && !doc.error);
        const anchors = row.anchors.map(value => label(value));
        if (!anchors.length) throw new Error('地点设定需要指定可核对的摘录位置');
        return {
          documentId: registered?.id || null, hash: registered?.hash || null, path: registered?.path || original,
          title: label(row.title), anchors, status: label(row.status, 60)
        };
      });
      return {
        id, name, aliases, summary: label(entry.summary, 200),
        map: {
          title: label(entry.map.title), version: label(entry.map.version, 40), path: map?.path || mapPath,
          documentId: map?.id || null, modified: map?.modified || null, size: map?.size ?? null
        },
        sources
      };
    });
    if (new Set(places.map(place => place.id)).size !== places.length) throw new Error('地点编号重复');
    return { hash: indexHash, places, historicalPaths };
  } catch (error) {
    return { hash: indexHash, places: [], historicalPaths: [], issue: '地点地图清单待核对 · ' + error.message };
  }
}

export function locationMapVersion(workspace) {
  const catalog = workspace.locationMaps;
  if (!catalog?.hash) return null;
  return [catalog.hash, catalog.places.map(({ map }) => [map.documentId, map.path, map.modified, map.size])];
}

function scorePlace(place, term, lookup) {
  const names = [place.name, ...place.aliases].map(normal);
  if (names.includes(term)) return 10;
  if (lookup && term.length >= 2 && names.some(name => name.includes(term))) return 3;
  return Math.max(0, ...names.filter(name => name.length >= 2 && term.includes(name)).map(name => Math.min(8, name.length)));
}

function selectedLines(content, anchors, term) {
  const lines = content.split(/\r?\n/).map(line => line.trim());
  const passages = anchors.flatMap(anchor => {
    const found = lines.filter(line => line.startsWith(anchor));
    if (found.length !== 1) return [];
    const keyword = normal(anchor.replace(/^[^\p{L}]+/u, ''));
    return [{ line: found[0], relevant: keyword.length >= 2 && term.includes(keyword) }];
  });
  return [...new Set(passages.sort((a, b) => Number(b.relevant) - Number(a.relevant))
    .map(({ line }) => line.length > 265 ? line.slice(0, 265) + '…' : line))]
    .join('\n\n').slice(0, 820);
}

export async function findLocationReferences(workspace, hints, readPinned, { lookup = false } = {}) {
  const terms = (Array.isArray(hints) ? hints : [hints]).map(normal).filter(Boolean);
  const catalog = workspace.locationMaps;
  if (!terms.length || !catalog?.places.length) return [];
  const found = catalog.places.map(place => ({ place, score: Math.max(...terms.map(term => scorePlace(place, term, lookup))) }))
    .filter(entry => entry.score).sort((a, b) => b.score - a.score).slice(0, 3);
  if (!found.length) return [];
  // Hash the index and the selected text sources as part of this writing turn.
  if (await readPinned(LOCATION_MAP_INDEX, catalog.hash) === null) {
    throw new AppError('CONFLICT', '地点地图清单已有更新，请刷新资料后重试');
  }
  const result = [];
  for (const { place } of found) {
    const { map } = place;
    const available = !!map.documentId && await sourceFile(workspace.store, map.path);
    const settings = [];
    for (const reference of place.sources) {
      const content = reference.hash && await readPinned(reference.path, reference.hash);
      const excerpt = typeof content === 'string' ? selectedLines(content, reference.anchors, terms.join('、')) : '';
      const external = workspace.project.externalChanges?.[reference.documentId];
      settings.push({
        title: reference.title, path: reference.path, documentId: reference.documentId,
        status: excerpt ? reference.status + (external ? ' · 内容变更待核对' : '') : '原档不可用或摘录位置待核对',
        excerpt
      });
    }
    result.push({
      id: place.id, title: place.name, summary: place.summary,
      map: { title: map.title, version: map.version, path: map.path, documentId: available ? map.documentId : null, available },
      settings
    });
  }
  return result;
}
