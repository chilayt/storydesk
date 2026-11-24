import fs from 'node:fs/promises';
import { AppError, decode, hash, stamp, uid } from './io.mjs';
import { isMapPath } from './catalog.mjs';

export const SOURCE_ROUTE_FILE = '00-项目导航/来源去向.json';

function relativeFile(value) {
  const relative = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
  if (!relative || /[:\0\r\n]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new AppError('PATH', '请选择作品目录内的文件');
  }
  return relative;
}

export async function sourceFile(store, relative) {
  const full = await store.resolve(relative);
  try { return (await fs.stat(full)).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

function history(project) {
  return project.sourceHistory ||= { moves: [], retired: {} };
}

export function recordSourceMove(project, document, to, reason, evidencePath) {
  history(project).moves.push({
    id: uid('move'), documentId: document.id, title: document.title, from: document.path, to,
    reason, evidencePath, at: stamp(), snapshot: document.snapshot, hash: document.hash
  });
}

const pathKey = relative => process.platform === 'win32' ? relative.replaceAll('\\', '/').toLowerCase() : relative;
const archiveFolder = relative => relative.split('/').some(part => part === '_archive' || part === '90-历史归档');

async function applyRoute(store, project, document, { action, to, archivePath, reason, evidencePath }) {
  if (!['move', 'retire'].includes(action)) throw new AppError('VALIDATION', '请选择搬迁或退役');
  if (await sourceFile(store, document.path)) throw new AppError('CONFLICT', '原路径已有文件，请刷新后核对');
  const destination = action === 'move' ? to : archivePath;
  const target = destination ? relativeFile(destination) : null;
  if (action === 'move' && !target) throw new AppError('VALIDATION', '请选择资料的新路径');
  if (target) {
    if (target.startsWith('_创作管理/') || (action === 'move' && archiveFolder(target))) {
      throw new AppError('PATH', '可将归档文件登记为历史出处，请选择退役');
    }
    if (!(document.kind === 'attachment' ? isMapPath(target) : /\.md$/i.test(target))) {
      throw new AppError('VALIDATION', document.kind === 'attachment' ? '请选择可打开的地图附件' : '请选择 Markdown 文档');
    }
    const tracked = [...Object.values(project.documents), ...Object.values(project.missingDocuments || {})];
    if (tracked.some(d => d.id !== document.id && pathKey(d.path) === pathKey(target))
        || Object.values(project.sourceHistory?.retired || {}).some(d => [d.path, d.archivePath].filter(Boolean).some(p => pathKey(p) === pathKey(target)))) {
      throw new AppError('CONFLICT', '目标路径已经登记为另一份资料，请核对文档身份');
    }
    if (project.libraryOriginals?.[target]?.some(entry => entry.adopted)) {
      throw new AppError('CONFLICT', '该来源已有独立资料库接入记录');
    }
    if (!await sourceFile(store, target)) throw new AppError('NOT_FOUND', '所选路径找不到文件');
    if (action === 'retire' && document.hash) {
      const bytes = await store.read(target);
      if (!bytes || hash(bytes) !== document.hash) {
        throw new AppError('CONFLICT', '所选归档文件与登记版本不同，请核对出处或使用登记快照');
      }
    }
  }
  const note = typeof reason === 'string' ? reason.trim().slice(0, 320) : '';
  const evidence = evidencePath ? relativeFile(evidencePath) : null;
  if (action === 'move') {
    recordSourceMove(project, document, target, note || '作者登记了新路径', evidence);
    project.documents[target] = { ...document, path: target };
  } else {
    history(project).retired[document.id] = {
      ...document, at: stamp(), reason: note || '作者确认退役', archivePath: target, evidencePath: evidence
    };
  }
  delete project.documents[document.path];
  delete project.missingDocuments?.[document.id];
  if (project.externalChanges[document.id]?.missing || action === 'retire') delete project.externalChanges[document.id];
  else if (project.externalChanges[document.id]) project.externalChanges[document.id] = { ...project.externalChanges[document.id], path: target };
}

export async function prepareSourceCatalog(store, project) {
  const bytes = await store.read(SOURCE_ROUTE_FILE);
  const issues = [];
  if (!bytes) return { catalog: project, issues };
  let entries;
  try {
    const input = JSON.parse(decode(bytes).text);
    if (input.version !== 1 || !Array.isArray(input.entries)) throw new Error();
    entries = input.entries.map(entry => ({ ...entry, from: relativeFile(entry.from) }));
    if (new Set(entries.map(entry => pathKey(entry.from))).size !== entries.length) throw new Error();
  } catch {
    return { catalog: project, issues: ['来源去向清单格式或原路径有误，请核对 ' + SOURCE_ROUTE_FILE] };
  }
  const catalog = {
    ...project, documents: { ...project.documents }, missingDocuments: { ...project.missingDocuments },
    externalChanges: { ...project.externalChanges }, sourceHistory: structuredClone(project.sourceHistory)
  };
  const tracked = new Map([...Object.values(catalog.missingDocuments), ...Object.values(catalog.documents)]
    .map(document => [pathKey(document.path), document]));
  for (const entry of entries) {
    const document = tracked.get(pathKey(entry.from));
    if (!document || await sourceFile(store, document.path)) continue;
    try { await applyRoute(store, catalog, document, entry); }
    catch (error) { issues.push(document.path + ' · ' + error.message); }
  }
  return { catalog, issues };
}

export async function reconcileSourceCatalog(store, project, docs, ownPaths) {
  const previousById = new Map([...Object.values(project.missingDocuments || {}), ...Object.values(project.documents)]
    .map(document => [document.id, document]));
  const own = new Set(ownPaths);
  project.missingDocuments ||= {};
  for (const doc of docs) {
    const prior = previousById.get(doc.id);
    previousById.delete(doc.id);
    const moved = prior && prior.path !== doc.path;
    if (moved) recordSourceMove(project, prior, doc.path, '新路径的文件内容校验值一致');
    delete project.missingDocuments[doc.id];
    if (project.externalChanges[doc.id]?.missing) delete project.externalChanges[doc.id];
    if (prior?.hash && prior.hash !== doc.hash && !own.has(doc.path)) {
      const routed = moved || project.sourceHistory?.moves.some(move => move.documentId === doc.id && move.to === doc.path);
      project.externalChanges[doc.id] = {
        oldHash: prior.hash, newHash: doc.hash, detected_at: stamp(), path: doc.path,
        ...(routed ? { reason: '资料已接到新路径，内容有变更，请核对当前版本' } : {})
      };
    } else if (moved && project.externalChanges[doc.id]) {
      project.externalChanges[doc.id] = { ...project.externalChanges[doc.id], path: doc.path };
    }
  }
  for (const document of previousById.values()) {
    if (project.sourceHistory?.retired[document.id]) continue;
    project.missingDocuments[document.id] = document;
    const warning = project.externalChanges[document.id];
    if (await sourceFile(store, document.path)) {
      if (warning?.missing) delete project.externalChanges[document.id];
    } else if (!warning?.missing || warning.path !== document.path || !warning.title) {
      project.externalChanges[document.id] = {
        path: document.path, title: document.title, kind: document.kind, canRestore: !!document.snapshot,
        missing: true, reason: '找不到登记文件。可接到新路径、恢复登记版本或登记退役',
        detected_at: warning?.missing ? warning.detected_at : stamp()
      };
    }
  }
}

export const sourceLifecycleMethods = {
  async resolveMissingSource({ documentId, action, to, archivePath, reason }) {
    const document = this.project.missingDocuments?.[documentId];
    if (!document || !this.project.externalChanges[documentId]?.missing) {
      throw new AppError('NOT_FOUND', '此资料已更新，请刷新后查看');
    }
    const next = structuredClone(this.project);
    await applyRoute(this.store, next, document, { action, to, archivePath, reason });
    return this.commit(action === 'move' ? '登记资料新路径' : '登记资料退役', [], next);
  },
  async readSourceHistory({ documentId, moveId }) {
    const retired = this.project.sourceHistory?.retired[documentId];
    const move = moveId && this.project.sourceHistory?.moves.find(row => row.id === moveId && row.documentId === documentId);
    const document = moveId ? move && { ...move, id: documentId, path: move.from } : retired || this.project.missingDocuments?.[documentId];
    if (!document) throw new AppError('NOT_FOUND', '找不到这条历史来源记录');
    let text = '';
    let snapshotAvailable = false;
    for (const relative of [document.snapshot, document.archivePath].filter(Boolean)) {
      if (!document.hash || document.kind === 'attachment') break;
      const bytes = await this.store.read(relative);
      if (!bytes || hash(bytes) !== document.hash) continue;
      text = decode(bytes).text;
      snapshotAvailable = true;
      break;
    }
    const archiveAvailable = !!document.archivePath && await sourceFile(this.store, document.archivePath);
    return { ...document, text, snapshotAvailable, archiveAvailable, readOnly: true, historical: true,
      status: retired && !moveId ? 'retired' : 'unconfirmed' };
  },
  async registeredSourcePath(documentId) {
    const retired = this.project.sourceHistory?.retired[documentId];
    const extension = this.project.writingExtensionDrafts?.find(row => row.id === documentId);
    const relative = retired ? retired.archivePath : extension?.path || this.doc(documentId).path;
    if (!relative || !await sourceFile(this.store, relative)) {
      throw new AppError('NOT_FOUND', '文件当前不可用，可在来源去向核对记录');
    }
    return this.store.resolve(relative);
  }
};
