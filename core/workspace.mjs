import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { FileStore, AppError, hash, uid, stamp, jsonOr, atomicJson, decode, encode } from './io.mjs';
import { DEFAULT_SOURCES, WORLD_SOURCE_KINDS, isMapPath, addNovelLibrarySources, discover, importEntities, candidateFields, managedBlock, recordMarkdown, parseRecord, recordBody, replaceRecordHeader, plain, sections } from './catalog.mjs';
import { SearchIndex } from './index.mjs';
import { runGate } from './gate.mjs';
import { splitSource, buildPrompt, requestModel, validateExtraction, FIELD_LABELS } from './analysis.mjs';
import { jobMethods } from './jobs.mjs';
import { chapterReviewMethods, chapterReviewState, isRecordedEvent } from './chapter-review.mjs';
import { inverseProject } from './undo.mjs';
import { extraMethods } from './extras.mjs';
import { indexAppearances } from './appearances.mjs';
import { wordingMethods, decorateWording } from './wording.mjs';
import { revisionMethods } from './revision.mjs';
import { memoryMethods, isMemoryRecord } from './memory.mjs';
import { obligationMethods } from './obligation-service.mjs';
import { isObligationCard, isObligationReport } from './obligations.mjs';
import { verifyFactEvidence, evidenceSummary } from './evidence.mjs';
import { reviewMethods, syncReviewLifecycle, recordDecision } from './review.mjs';
import { cowritingMethods } from './cowriting.mjs';
import { creativeTaskMethods } from './creative-tasks.mjs';
import { libraryMethods } from './library-migration.mjs';
import { researchMethods } from './research.mjs';
import { manuscriptReviewMethods } from './manuscript-review.mjs';
import { writingExtensionDraftMethods } from './writing-extension-drafts.mjs';
import { bookReviewMethods } from './book-review.mjs';
import { bookSemanticReviewMethods } from './book-semantic-review.mjs';
import { WRITING_STYLES } from './cowriting-context.mjs';
import { validateMemlayer, memlayerHealth, memlayerScopes,
  listMemlayerCandidates, proposeMemlayerCandidate, reviewMemlayerCandidate,
  retractMemlayerFact, listMemlayerFacts } from './memlayer-client.mjs';
import { connectionBase, writingModel, WRITING_OUTPUT_LIMIT } from './model-connections.mjs';
import { SOURCE_ROUTE_FILE, prepareSourceCatalog, reconcileSourceCatalog, sourceLifecycleMethods } from './source-lifecycle.mjs';
import { LOCATION_MAP_INDEX, loadLocationMaps } from './location-maps.mjs';
import { draftMethods, nextWritingChapter } from './drafts.mjs';
import { stagePlans, validateStageDetails } from './stage-plans.mjs';
import { chapterOutlineApprovals } from './planning.mjs';

const jsonBytes = v => Buffer.from(JSON.stringify(v, null, 2));
const copy = v => structuredClone(v);
const valueText = v => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
const chapterSort = (a, b) => (a.latest_only ? Infinity : a.source_chapter ?? 0) - (b.latest_only ? Infinity : b.source_chapter ?? 0) || (a.start ?? 0) - (b.start ?? 0) || String(a.event_created_at || '').localeCompare(String(b.event_created_at || ''));
const BASE_TOKEN_LIMIT = 120000;
const RECORD_KINDS = new Set(['plot_arc', 'hook', 'location', 'organization', 'item', 'decision', 'knowledge']);
function cleanName(name) { if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\0\r\n]/.test(name)) throw new AppError('VALIDATION', '名称不能为空或包含换行'); return name.trim(); }

export class Workspace {
  constructor(root, { notify = () => {}, getKey = async () => '', fetcher, localPresets = [], externalGate = true } = {}) {
    this.externalGate = externalGate;
    this.store = new FileStore(root); this.notify = notify; this.getKey = getKey; this.fetcher = fetcher;
    this.localPresets = localPresets;
    this.project = null; this.documents = []; this.events = []; this.baselines = {}; this.records = []; this.memories = []; this.obligationCards = []; this.obligationChecks = [];
    this.queue = Promise.resolve(); this.controllers = new Map(); this.watcher = null; this.checking = false;
    this.directoryWatchers = new Map(); this.watchDirty = false;
  }
  gateConfiguration() {
    return this.externalGate ? this.project.settings.gate : { ...this.project.settings.gate, enabled: false };
  }
  async init() {
    this.recovery = await this.store.init();
    const file = await this.store.resolve('_创作管理/project.json');
    let project = await jsonOr(file, null);
    if (!project) {
      const hasGate = this.externalGate && !!await this.store.read('_tools/gate.py');
      project = { schema_version: 1, id: uid('work'), name: path.basename(this.store.root), created_at: stamp(), documents: {}, characters: [], sources: copy(DEFAULT_SOURCES), approvals: [], jobs: [], proposals: [], locks: [], checks: [], scenes: [], records: [], baselines: {}, externalChanges: {}, reader: {}, settings: { era: hasGate ? '架空唐 · 天宝三载（744）' : '', parentWork: '', gate: { enabled: hasGate, required: hasGate, script: '_tools/gate.py', python: '', defaultCard: '05-剧本/_本地协作/05_场次交接卡.md' }, ai: { enabled: false, baseUrl: '', model: '', modelList: [], maxOutputTokens: 4096, maxTokensPerJob: BASE_TOKEN_LIMIT, dailyTokenLimit: 300000 }, theme: 'light' } };
      project.reviewLifecycleVersion = 1;
      await atomicJson(file, project);
    }
    if (project.schema_version !== 1) throw new AppError('SCHEMA', '此作品的管理格式版本不受支持，未改写资料');
    if (!this.recovery.length) {
      const ai = project.settings.ai;
      const previousBase = ai.baseUrl;
      try { ai.baseUrl = connectionBase(ai.baseUrl); }
      catch { Object.assign(ai, { enabled: false, baseUrl: '', model: '', modelList: [] }); }
      const sourcesAdded = await addNovelLibrarySources(this.store, project);
      if (sourcesAdded || ai.baseUrl !== previousBase) {
        const previous = await this.store.read('_创作管理/project.json');
        await this.store.batch('接入作品资料与模型配置', [{ path: '_创作管理/project.json', expectedHash: hash(previous), bytes: jsonBytes(project) }]);
      }
    }
    this.project = project;
    for (const job of project.jobs) if (['running', 'applying'].includes(job.status)) { job.status = 'interrupted'; job.error = '程序中断；可从已保存的源版本重新运行'; }
    for (const run of project.memoryRuns || []) if (['prepared', 'requested'].includes(run.status)) { run.status = 'interrupted'; run.finished_at = stamp(); }
    this.index = new SearchIndex(await this.store.resolve('_创作管理/缓存/index.sqlite'));
    await this.index.open(); await this.refresh(true); return this.summary();
  }
  exclusive(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  async close() { this.closing = true; if (this.watcher) clearInterval(this.watcher); for (const watcher of this.directoryWatchers.values()) watcher.close(); for (const c of this.controllers.values()) c.abort(); for (let n = 0; this.controllers.size && n < 1000; n++) await new Promise(r => setTimeout(r, 10)); await this.queue; this.index?.close(); await this.store.close(); }
  startWatching() {
    if (this.watcher) return;
    this.installWatchers().catch(() => {});
    this.watcher = setInterval(async () => {
      if (this.checking || this.controllers.size) return;
      this.checking = true;
      try { const changed = this.watchDirty || await this.hasChanges(); this.watchDirty = false; if (changed) await this.exclusive(async () => { await this.refresh(); await this.installWatchers(); this.notify({ type: 'changed', workId: this.project.id }); }); }
      catch (e) { this.notify({ type: 'warning', message: e.message }); } finally { this.checking = false; }
    }, 1500); this.watcher.unref?.();
  }
  async installWatchers() {
    const folders = new Set(['', ...this.documents.map(d => path.dirname(d.path)), ...this.project.sources.filter(s => !s.path.endsWith('.md')).map(s => s.path), '_创作管理/事件', '_创作管理/资料', '_创作管理/记忆', '_创作管理/场景义务', '_创作管理/义务核对', '_创作管理/人物进展', '_创作管理/关系']);
    folders.add(path.posix.dirname(SOURCE_ROUTE_FILE));
    for (const folder of folders) {
      if (this.directoryWatchers.has(folder) || this.closing) continue;
      try {
        const full = await this.store.resolve(folder);
        const watcher = watch(full, { persistent: false }, (_event, file) => {
          const name = String(file);
          if (!file || /\.md$/i.test(name) || isMapPath(name) || name === path.posix.basename(SOURCE_ROUTE_FILE) ||
              name === path.posix.basename(LOCATION_MAP_INDEX) || this.project.sources.some(s => s.path.startsWith(name))) this.watchDirty = true;
        });
        watcher.on('error', () => { watcher.close(); this.directoryWatchers.delete(folder); }); this.directoryWatchers.set(folder, watcher);
      } catch { /* Explicit polling remains available for unavailable directories. */ }
    }
  }
  async hasChanges() {
    for (const d of this.documents.filter(d => !d.generated)) {
      try { const stat = await fs.stat(await this.store.resolve(d.path)); if (stat.size !== d.size || stat.mtime.toISOString() !== d.modified) return true; } catch { return true; }
    }
    for (const [relative, head] of Object.entries(this.project.managedHeads || {})) {
      if (this.project.protectedFiles?.[relative]) continue;
      const b = await this.store.read(relative), currentHash = b ? hash(b) : null;
      if (currentHash !== head.hash && this.project.externalChanges[`managed:${relative}`]?.newHash !== currentHash) return true;
    }
    // Directory membership is checked on focus/manual refresh; content is polled here.
    return false;
  }
  async persist() { await atomicJson(await this.store.resolve('_创作管理/project.json'), this.project); }
  async refresh(first = false, ownPaths = []) {
    const { catalog, issues } = this.recovery?.length
      ? { catalog: this.project, issues: [] }
      : await prepareSourceCatalog(this.store, this.project);
    const docs = await discover(this.store, catalog);
    await reconcileSourceCatalog(this.store, catalog, docs, ownPaths);
    this.project = catalog;
    this.sourceRouteIssues = issues;
    this.documents = docs; this.project.characters = importEntities(docs, this.project);
    this.locationMaps = await loadLocationMaps(this);
    for (const d of docs) {
      if (d.kind !== 'attachment' && !d.error) {
        const snapshot = `_创作管理/历史/文档版本/${d.id}/${d.hash}.md`, target = await this.store.resolve(snapshot);
        try { await fs.access(target); } catch {
          const bytes = await this.store.read(d.path);
          if (bytes && hash(bytes) === d.hash) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; }); }
        }
        d.snapshot = snapshot;
      }
    }
    this.project.documents = Object.fromEntries(docs.map(({ text, error, ...d }) => [d.path, d]));
    this.events = await this.loadRecords('事件'); this.records = await this.loadRecords('资料'); this.memories = await this.loadRecords('记忆'); this.obligationCards = await this.loadRecords('场景义务'); this.obligationChecks = await this.loadRecords('义务核对');
    for (const event of this.events.filter(e => e.source_document_id)) {
      const source = docs.find(d => d.id === event.source_document_id);
      event.stale = !source || source.hash !== event.source_hash;
      event.sourceRetired = !source && !!this.project.sourceHistory?.retired[event.source_document_id];
      if (!source) event.stale_reason = event.sourceRetired ? '来源已退役，可查原确认版本' : '登记来源当前不可用';
      else if (!event.stale) delete event.stale_reason;
    }
    for (const [relative, head] of Object.entries(this.project.managedHeads || {})) {
      if (!/^_创作管理\/(人物进展\/|关系\/|事件索引\.md)/.test(relative) || this.project.protectedFiles?.[relative]) continue;
      const b = await this.store.read(relative), currentHash = b ? hash(b) : null;
      if (currentHash !== head.hash) this.project.externalChanges[`managed:${relative}`] = { path: relative, newHash: currentHash, reason: '派生文档有手工修改，自动覆盖已暂停', detected_at: stamp() };
    }
    const pendingPaths = new Set((this.recovery || []).flatMap(r => r.files.map(f => f.path)));
    for (const e of this.events) if (pendingPaths.has(`_创作管理/事件/${e.id}.md`)) e.uncommitted = true;
    this.baselines = {};
    this.project.settingMeta ||= {};
    for (const d of docs.filter(d => WORLD_SOURCE_KINDS.has(d.kind) || d.kind === 'plan')) {
      const start = `<!-- storydesk:setting-${d.id}:start -->`, end = `<!-- storydesk:setting-${d.id}:end -->`;
      const a = d.text.indexOf(start), b = d.text.indexOf(end);
      if (a >= 0 && b > a) { const json = d.text.slice(a, b).match(/```json\s*\n([\s\S]*?)\n```/); if (json) { try { const m = JSON.parse(json[1]); if (m.work_id !== this.project.id) throw new Error('作品不匹配'); this.project.settingMeta[d.id] = m; } catch { this.project.externalChanges[d.id] = { path: d.path, reason: '设定信息维护区损坏', detected_at: stamp() }; } } }
    }
    for (const c of this.project.characters) {
      if (c.status === 'merged') continue;
      const d = docs.find(d => d.id === c.primarySourceId);
      if (!d || pendingPaths.has(d.path)) continue;
      const start = `<!-- storydesk:baseline-${c.id}:start -->`, end = `<!-- storydesk:baseline-${c.id}:end -->`;
      const a = d.text.indexOf(start), b = d.text.indexOf(end);
      if (a >= 0 && b > a) {
        const segment = d.text.slice(a, b); const json = segment.match(/```json\s*\n([\s\S]*?)\n```/);
        if (json) { try { this.baselines[c.id] = JSON.parse(json[1]); } catch { this.project.externalChanges[d.id] = { path: d.path, reason: '基座结构化区损坏', detected_at: stamp() }; } }
      }
    }
    const eventDocs = this.events.filter(isRecordedEvent).map(e => ({
      id: e.id, title: e.title, kind: 'event', path: `_创作管理/事件/${e.id}.md`, hash: '',
      text: `${e.title}\n${e.summary}\n${e.facts.filter(f => f.status === 'accepted').map(f => `${FIELD_LABELS[f.field] || f.field} ${valueText(f.value)}\n${f.evidence}`).join('\n')}`, generated: true }));
    const memoryDocs = this.memories.filter(m => !m.damaged).map(m => ({ id: m.id, title: m.title, kind: 'memory', path: `_创作管理/记忆/${m.id}.md`, hash: m._hash || '', text: `${m.content}\n${m.exceptions}\n${m.source.reference}`, generated: true }));
    this.index.rebuild(this.project.id, [...docs.filter(d => !d.error && d.kind !== 'attachment'), ...eventDocs, ...memoryDocs]);
    if (syncReviewLifecycle(this.project, this.documents, this.events)) {
      const previous = await this.store.read('_创作管理/project.json');
      await this.store.batch('整理章节核对版本与历史', [{ path: '_创作管理/project.json', expectedHash: previous ? hash(previous) : null, bytes: jsonBytes(this.project) }]);
      for (const j of this.project.jobs.filter(j => j.versionState !== 'current')) this.controllers.get(j.id)?.abort();
    } else await this.persist();
    if (!first) this.notify({ type: 'refreshed', workId: this.project.id });
  }
  async loadRecords(folder) {
    const p = await this.store.resolve(`_创作管理/${folder}`); let entries;
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') entries = []; else throw e; }
    const result = [];
    for (const e of entries) if (e.isFile() && e.name.endsWith('.md')) {
      try {
        const relative = `_创作管理/${folder}/${e.name}`, bytes = await this.store.read(relative), currentHash = hash(bytes);
        let record = parseRecord(decode(bytes).text);
        if (record.work_id !== this.project.id || record.id !== e.name.slice(0, -3)) throw new Error('作品或记录ID不匹配');
        if (folder === '事件' && (!Array.isArray(record.facts) || record.facts.some(f => !f || typeof f.entity_id !== 'string' || typeof f.field !== 'string'))) throw new Error('事件事实结构损坏');
        if (folder === '资料') record.body = recordBody(decode(bytes).text);
        if (folder === '记忆' && !isMemoryRecord(record)) throw new Error('记忆结构损坏');
        if (folder === '场景义务' && !isObligationCard(record) || folder === '义务核对' && !isObligationReport(record)) throw new Error('场景义务或核对记录结构损坏');
        const head = this.project.managedHeads?.[relative];
        if (folder === '事件' && (!head || !this.project.approvals.some(a => a.id === record.approval_id && a.status === 'active'))) {
          record.unreviewedExternal = true;
          this.project.externalChanges[`managed:${relative}`] = { path: relative, reason: '发现未登记的外部事件，须作者确认后才能进入正式档案', newHash: currentHash, detected_at: stamp() };
        }
        if (['记忆','场景义务','义务核对'].includes(folder) && !head) {
          record.unreviewedExternal = true;
          this.project.externalChanges[`managed:${relative}`] = { path: relative, reason: '外部记忆尚未由作者确认，不会发送给AI', newHash: currentHash, detected_at: stamp() };
        }
        if (head && head.hash !== currentHash) {
          this.project.externalChanges[`managed:${relative}`] = { path: relative, oldHash: head.hash, newHash: currentHash, reason: '结构化记录被外部修改，正式视图保持上次登记版本', detected_at: stamp() };
          const snapshot = await this.store.read(head.snapshot);
          if (!snapshot || hash(snapshot) !== head.hash) throw new Error('上次登记记录的快照缺失或损坏');
          record = parseRecord(decode(snapshot).text); record.externalPending = true;
          if (folder === '资料') record.body = recordBody(decode(snapshot).text);
        }
        if (['记忆','场景义务','义务核对'].includes(folder)) record._hash = head?.hash || currentHash;
        result.push(record);
      }
      catch (error) {
        const relative = `_创作管理/${folder}/${e.name}`; this.project.externalChanges[`managed:${relative}`] = { path: relative, reason: `管理记录损坏：${error.message}`, detected_at: stamp() };
        const head = this.project.managedHeads?.[relative], snapshot = ['场景义务','义务核对'].includes(folder) && head && await this.store.read(head.snapshot);
        if (snapshot && hash(snapshot) === head.hash) { const prior = parseRecord(decode(snapshot).text); result.push({ ...prior, _hash: head.hash, damaged: true, externalPending: true, error: error.message }); }
        else result.push({ id: e.name.replace(/\.md$/, ''), damaged: true, title: e.name, error: error.message, facts: [] });
      }
    }
    if (['记忆','场景义务','义务核对'].includes(folder)) for (const [relative, head] of Object.entries(this.project.managedHeads || {})) {
      if (!relative.startsWith(`_创作管理/${folder}/`) || entries.some(e => relative === `_创作管理/${folder}/${e.name}`)) continue;
      this.project.externalChanges[`managed:${relative}`] = { path: relative, reason: '记忆文件已移除，暂停加载；可恢复登记版本', newHash: null, detected_at: stamp() };
      const snapshot = await this.store.read(head.snapshot);
      if (snapshot && hash(snapshot) === head.hash) { const record = parseRecord(decode(snapshot).text); result.push({ ...record, _hash: head.hash, externalPending: true, missing: true }); }
    }
    return result;
  }
  chapterStatus(d, outlines = null) {
    if (d.kind === 'plan' && d.chapterMaterial?.role === 'design') {
      const approval = (outlines || chapterOutlineApprovals(this)).get(d.chapterMaterial.chapter);
      if (approval?.documentId === d.id) return approval.sourceHash === d.hash && !d.error ? 'confirmed' : 'revising';
    }
    const approvals = this.project.approvals.filter(a => a.documentId === d.id && a.kind === 'prose' && !a.sceneId);
    const approved = approvals.find(a => a.sourceHash === d.hash && a.status === 'active');
    if (approved) return 'confirmed'; if (approvals.length) return 'revising';
    if (this.project.approvals.some(a => a.documentId === d.id && a.sceneId && a.sourceHash === d.hash)) return 'partial';
    return d.kind === 'draft' ? 'draft' : 'unconfirmed';
  }
  agentProfile() { return writingModel(this.project.settings, this.localPresets); }
  async memlayerStatus() {
    const config = validateMemlayer(this.project.settings.memlayer);
    const health = await memlayerHealth(config);
    if (health.status !== 'ready') return { ...config, ...health };
    const workId = this.project.id;
    const scopes = memlayerScopes(config, workId);
    const results = await Promise.allSettled(scopes.map(({ scope }) =>
      listMemlayerFacts(config, { workId, scope, countOnly: true })));
    const available = results.reduce((total, row) => total + (row.status === 'fulfilled' ? row.value.total : 0), 0);
    const failure = results.find(row => row.status === 'rejected');
    const status = failure ? (results.every(row => row.status === 'rejected') ? 'unavailable' : 'partial') : available ? 'ready' : 'empty';
    return { ...config, ...health, status, available, message: failure?.reason?.message };
  }
  async memlayerMemory({ scope = 'work', offset = 0, search = '', authorNotesOnly = false } = {}) {
    const config = this.project.settings.memlayer;
    const workId = this.project.id;
    const scopes = memlayerScopes(config, workId);
    const [candidates, page] = await Promise.all([
      listMemlayerCandidates(config, { workId, scope }),
      listMemlayerFacts(config, { workId, scope, offset, search, authorNotesOnly }),
    ]);
    return { scopes, candidates, ...page };
  }
  async memlayerPropose({ scope, text, sourceId, documentId, sceneId, taskId }) {
    const { source } = await this.readResearchDiscussion({ documentId, sceneId, taskId, messageId: sourceId, authorOnly: true });
    return proposeMemlayerCandidate(this.project.settings.memlayer, { workId: this.project.id, scope, text, sourceId: source.messageId });
  }
  async memlayerReview({ scope, decision, id, hash, text, supersedesFactId, reason }) {
    const config = this.project.settings.memlayer;
    const input = { workId: this.project.id, scope, decision, id, hash, supersedesFactId, reason };
    if (decision !== 'replace') return reviewMemlayerCandidate(config, input);
    const rows = await listMemlayerCandidates(config, input);
    const original = rows.find(row => row.id === id);
    if (!original || original.hash !== hash) throw new AppError('CONFLICT', '候选已变化，请刷新后再编辑');
    if (original.text === String(text || '').trim()) return original;
    const replacement = await proposeMemlayerCandidate(config, { ...input, text, sourceId: original.source, suggestedFactId: original.suggestedFactId, suggestedAction: original.suggestedAction });
    if (replacement.status !== 'pending') throw new AppError('CONFLICT', '同一来源的这段内容已有核对结果，请重新编辑');
    await reviewMemlayerCandidate(config, { ...input, decision: 'reject' });
    return replacement;
  }
  async memlayerRetract({ scope, factId, reason }) {
    return retractMemlayerFact(this.project.settings.memlayer, { workId: this.project.id, scope, factId, reason });
  }
  summary() {
    const outlineApprovals = chapterOutlineApprovals(this);
    const docs = this.documents.map(({ text, format, ...d }) => ({ ...d, status: this.chapterStatus(d, outlineApprovals), external: !!this.project.externalChanges[d.id] }));
    const chapters = docs.filter(d => d.kind === 'chapter');
    const chapterReviews = (this.project.chapterReviews || []).map(row => ({ ...row, status: chapterReviewState(this.project, docs, row) }));
    const chapterOutlines = [...outlineApprovals].map(([chapter, a]) =>
      ({ chapter, approvalId: a.id, documentId: a.documentId, sourceHash: a.sourceHash }));
    const reviewData = { chapterReviews, sourceHistory: this.project.sourceHistory, sourceRouteIssues: this.sourceRouteIssues,
      nextChapter: nextWritingChapter(this, chapters), stagePlans: stagePlans(this), chapterOutlines,
      hiddenChapterMaterials: this.project.hiddenChapterMaterials || [],
      locationMaps: this.locationMaps?.places || [], locationMapIssue: this.locationMaps?.issue,
      wordingDecisions: this.project.wordingDecisions || [], revisionTasks: this.project.revisionTasks || [], aiAssistanceUsage: this.project.aiAssistanceUsage || [], memories: this.memories.map(m => ({ ...m, consumedBy: m.lifetime === 'once' ? this.project.memoryRuns?.find(r => r.requests?.length && r.selected.some(s => s.id === m.id))?.id || null : null })), memoryRuns: [...(this.project.memoryRuns || [])].reverse().slice(0, 100), obligationCards:this.obligationCards, obligationChecks:this.obligationChecks,modelTest:this.project.modelTest||null };
    return { ...reviewData, writingModel: this.agentProfile(), localPresets: this.localPresets, id: this.project.id, name: this.project.name, root: this.store.root, era: this.project.settings.era, documents: docs, characters: this.project.characters.filter(c => c.status !== 'merged').map(c => ({ ...c, baselineConfirmed: !!this.baselines[c.id], fields: this.baselines[c.id]?.fields || [], sourceMissing: !docs.some(d => d.id === c.primarySourceId) && !!c.primarySourceId })), sources: this.project.sources, settings: { ...this.project.settings, gate: this.externalGate ? this.project.settings.gate : { ...this.gateConfiguration(), required: false } }, approvals: this.project.approvals, jobs: this.project.jobs, proposals: this.project.proposals, locks: this.project.locks, checks: this.project.checks.map(c=>decorateWording(c,this.project)), scenes: this.project.scenes, events: this.events, records: this.records, externalChanges: this.project.externalChanges, identityConflicts: this.project.identityConflicts || [], settingMeta: this.project.settingMeta || {}, recovery: this.recovery, reader: this.project.reader, stats: { documents: docs.length, chapters: chapters.length, confirmed: chapters.filter(d => d.status === 'confirmed').length, latestFile: Math.max(0, ...chapters.map(d => d.chapter || 0)), characters: this.project.characters.filter(c => c.status !== 'merged').length, candidates: this.project.characters.filter(c => c.status === 'candidate').length, baselines: Object.keys(this.baselines).length, pending: this.project.proposals.filter(p => p.status === 'pending').length + chapterReviews.filter(row => row.status === 'pending').length, external: Object.keys(this.project.externalChanges).length, events: this.events.filter(isRecordedEvent).length } };
  }
  doc(id) { const d = this.documents.find(d => d.id === id); if (!d) throw new AppError('NOT_FOUND', '此文档尚未登记或已移除'); return d; }
  character(id) { const c = this.project.characters.find(c => c.id === id); if (!c) throw new AppError('NOT_FOUND', '人物不存在'); return c; }
  async snapshotDocument(d) {
    if (d.kind === 'attachment') throw new AppError('READ_ONLY', '图纸附件请使用打开原文件功能');
    const bytes = await this.store.read(d.path); if (!bytes) throw new AppError('NOT_FOUND', '源文件已经移除');
    const contentHash = hash(bytes); const format = decode(bytes);
    const relative = `_创作管理/历史/文档版本/${d.id}/${contentHash}.md`;
    const target = await this.store.resolve(relative);
    if (!await this.store.read(relative)) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; }); }
    return { ...d, ...format, hash: contentHash, snapshot: relative };
  }
  async readDocument(id) {
    if (id.startsWith('event_')) {
      const e = this.events.find(e => e.id === id); if (!e) throw new AppError('NOT_FOUND', '事件不存在');
      const p = `_创作管理/事件/${id}.md`; const b = await this.store.read(p);
      return { id, path: p, title: e.title, kind: 'event', text: decode(b).text, hash: hash(b), readOnly: true };
    }
    if (this.project.sourceHistory?.retired[id]) return this.readSourceHistory({ documentId: id });
    const doc = await this.snapshotDocument(this.doc(id));
    const draft = await jsonOr(await this.store.resolve(`_创作管理/草稿恢复/${id}.json`), null);
    return { ...doc, draft, status: this.chapterStatus(doc), external: this.project.externalChanges[id] || null, scenes: this.project.scenes.filter(s => s.documentId === id) };
  }
  async saveDocument({ documentId, expectedHash, text }, { label = '保存文档', additionalChanges = [] } = {}) {
    if (typeof text !== 'string' || text.length > 5000000) throw new AppError('VALIDATION', '正文格式无效或超过编辑限制');
    const d = this.doc(documentId); if (d.kind === 'attachment' || d.readOnly) throw new AppError('READ_ONLY', '此资料按只读来源接入');
    const current = await this.snapshotDocument(d); if (current.hash !== expectedHash) throw new AppError('CONFLICT', '源文件已被修改，请先比较版本。', { current });
    const bytes = encode(text, current); const next = copy(this.project);
    delete next.externalChanges[d.id];
    const changes = [{ path: d.path, expectedHash, bytes }];
    const affected = this.events.filter(e => e.source_document_id === d.id && e.source_hash !== hash(bytes));
    for (const e of affected) {
      const ep = `_创作管理/事件/${e.id}.md`, b = await this.store.read(ep);
      if (e.stale) continue;
      const updated = { ...e, stale: true, stale_reason: '源稿已经修改，等待新版本确认' };
      changes.push({ path: ep, expectedHash: hash(b), text: this.eventMarkdown(updated, decode(b).text) });
    }
    for (const j of next.jobs) if (j.documentId === d.id && j.sourceHash !== hash(bytes) && ['completed', 'partial'].includes(j.status)) j.sourceChanged = true;
    await this.commit(label, [...changes, ...additionalChanges], next); await this.clearDraft(documentId);
    return { document: await this.readDocument(documentId), affectedEvents: affected.map(e => ({ id: e.id, title: e.title })) };
  }
  async setDraft({ documentId, text, baseHash }) {
    this.doc(documentId); if (typeof text !== 'string' || text.length > 5000000) throw new AppError('VALIDATION', '草稿超过限制');
    await atomicJson(await this.store.resolve(`_创作管理/草稿恢复/${documentId}.json`), { text, baseHash, saved_at: stamp() }); return true;
  }
  async clearDraft(id) { await fs.unlink(await this.store.resolve(`_创作管理/草稿恢复/${id}.json`)).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  async commit(label, changes, next = this.project, { allowManagedEdits = [] } = {}) {
    const readOnly = new Set(this.documents.filter(d => d.readOnly).map(d => d.path.toLowerCase()));
    if (changes.some(change => readOnly.has(change.path.replaceAll('\\', '/').toLowerCase()))) {
      throw new AppError('READ_ONLY', '此资料按只读来源接入，请在原稿中修改');
    }
    next = copy(next); next.managedHeads ||= {};
    for (const c of changes.filter(c => /^_创作管理\/(?:事件\/|资料\/|记忆\/|场景义务\/|义务核对\/|人物进展\/|关系\/|事件索引\.md)/.test(c.path))) {
      const before = await this.store.read(c.path), previous = this.project.managedHeads?.[c.path];
      if (previous && (before ? hash(before) : null) !== previous.hash && !allowManagedEdits.includes(c.path)) {
        this.project.externalChanges[`managed:${c.path}`] = { path: c.path, reason: '管理文档存在外部修改，已停止覆盖', newHash: before ? hash(before) : null, detected_at: stamp() };
        await this.persist(); throw new AppError('CONFLICT', '本地管理文档被人工修改，请先到更新中心核对。');
      }
      if (c.bytes === null) { delete next.managedHeads[c.path]; continue; }
      const b = c.bytes || Buffer.from(c.text || ''), contentHash = hash(b), snapshot = `_创作管理/历史/记录版本/${contentHash}.md`;
      const oldSnapshot = await this.store.read(snapshot);
      if (!oldSnapshot) { const target = await this.store.resolve(snapshot); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, b, { flag: 'wx' }); }
      else if (hash(oldSnapshot) !== contentHash) throw new AppError('DAMAGED_DATA', '管理文档版本快照损坏，未覆盖资料');
      next.managedHeads[c.path] = { hash: contentHash, snapshot };
    }
    const p = '_创作管理/project.json'; const before = await this.store.read(p);
    const result = await this.store.batch(label, [...changes, { path: p, expectedHash: hash(before), bytes: jsonBytes(next) }]);
    this.project = next; await this.refresh(false, changes.map(c => c.path)); return result;
  }
  async getCharacter(id, cutoff = null) {
    const c = this.character(id); const source = this.documents.find(d => d.id === c.primarySourceId);
    const mentions = this.documents.filter(d => d.kind === 'chapter' && (cutoff === null || d.chapter <= cutoff) && [c.name, ...c.aliases].some(n => n && d.text.includes(n))).map(d => ({ documentId: d.id, chapter: d.chapter, title: d.title, type: 'mention_unverified' }));
    const facts = this.visibleFacts(cutoff).filter(f => f.entity_id === id).sort(chapterSort);
    const appearances = indexAppearances(this.documents, c, cutoff, facts.filter(f => f.field === 'appearance' && f.layer === 'occurred' && !f.eventStale));
    const confirmedAppearance = appearances.filter(f => f.value?.type === 'onscreen');
    const baseline = this.baselines[id] || null; const current = {};
    for (const f of facts.filter(f => f.layer === 'occurred' || f.layer === 'ruling').sort(chapterSort)) {
      if (['relationship', 'skill', 'appearance', 'knowledge'].includes(f.field)) continue;
      current[f.field] = f;
    }
    const history = this.events.filter(e => !e.damaged && !e.uncommitted && !e.unreviewedExternal && !e.withdrawn && !e.superseded && e.facts.some(f => f.entity_id === id && f.status === 'accepted' && (cutoff === null || (f.source_chapter ?? 0) <= cutoff))).sort((a, b) => (a.source_chapter ?? 0) - (b.source_chapter ?? 0));
    const skills = facts.filter(f => f.field === 'skill' && ['occurred','ruling'].includes(f.layer));
    const relationships = this.relationships(cutoff).filter(r => r.fromId === id || r.toId === id);
    return { ...c, baseline, candidates: source ? candidateFields(source.text) : [], current, history, facts, mentions, appearances, firstMention: mentions.sort((a,b) => a.chapter-b.chapter)[0] || null, firstAppearance: confirmedAppearance[0] || null, skills, relationships, sourceHash: source?.hash, sourceText: source?.text || '', pending: this.project.proposals.filter(p => p.fact.entity_id === id && p.status === 'pending') };
  }
  visibleFacts(cutoff = null, { includeLatest = false, currentOnly = false } = {}) {
    const facts = this.events.filter(e => isRecordedEvent(e) && (!currentOnly || !e.stale && !e.externalPending))
      .flatMap(e => e.facts.map(f => ({ ...f, eventId: e.id, eventTitle: e.title, eventStale: !!e.stale, sourceRetired: !!e.sourceRetired, approvalId: e.approval_id, event_created_at: e.created_at })));
    const valid = facts.filter(f => f.status === 'accepted' && (cutoff === null ||
      (includeLatest && f.latest_only) || !f.latest_only && (f.source_chapter === null || f.source_chapter <= cutoff)));
    const superseded = new Set(valid.map(f => f.supersedes_fact_id).filter(Boolean));
    return valid.filter(f => !superseded.has(f.id));
  }
  relationships(cutoff = null) {
    const edges = new Map();
    for (const f of this.visibleFacts(cutoff).filter(f => f.field === 'relationship' && f.value?.otherId && ['occurred', 'ruling'].includes(f.layer)).sort(chapterSort)) {
      const key = `${f.entity_id}|${f.value.otherId}|${f.value.type || '关联'}`;
      const old = edges.get(key);
      edges.set(key, { id: key, fromId: f.entity_id, toId: f.value.otherId, type: f.value.type || '关联', attitude: f.value.attitude || '', firstFact: old?.firstFact || f, currentFact: f, changes: [...(old?.changes || []), f] });
    }
    return [...edges.values()];
  }
  async approveBaseline({ characterId, fields, expectedSourceHash, appliesAt = '故事初始状态', proposalId = null, proposalEvidence, reconsider = false, reviewOrigin = null }) {
    const c = this.character(characterId); if (!Array.isArray(fields) || !fields.length || fields.length > 100) throw new AppError('VALIDATION', '请至少选择一个基座字段');
    const normalized = fields.map(f => ({ field: cleanName(f.field), value: typeof f.value === 'string' ? f.value.trim() : valueText(f.value), certainty: f.certainty === 'reserved' ? 'reserved' : 'confirmed', evidence: f.evidence || null }));
    if (new Set(normalized.map(f => f.field)).size !== normalized.length) throw new AppError('VALIDATION', '基座字段名称重复，请先合并或改名');
    for (const f of normalized) if (!f.value) f.certainty = 'reserved';
    let d = this.documents.find(d => d.id === c.primarySourceId); let relative, before, text, format;
    if (d) { const current = await this.snapshotDocument(d); if (current.hash !== expectedSourceHash) throw new AppError('CONFLICT', '人物原档已改变，请刷新后确认'); relative = d.path; before = current.hash; text = current.text; format = current; }
    else { relative = `人物/${c.name.replace(/[<>:"/\\|?*]/g, '')}_${c.id.slice(-6)}.md`; before = null; text = `# ${c.name}\n`; format = {}; }
    const baseline = { id: uid('base'), work_id: this.project.id, characterId, revision: (this.baselines[characterId]?.revision || 0) + 1, appliesAt, fields: normalized, approved_at: stamp(), author: '作者', ...(reviewOrigin ? { review_origin: reviewOrigin } : {}) };
    const body = `## 已确认初始基座\n\n适用点：${appliesAt}\n\n\`\`\`json\n${JSON.stringify(baseline, null, 2)}\n\`\`\`\n\n${normalized.map(f => `### ${f.field}\n\n${f.value || '保留待定'}`).join('\n\n')}`;
    text = managedBlock(text, `baseline-${characterId}`, body);
    const next = copy(this.project); const nc = next.characters.find(c => c.id === characterId); nc.status = 'registered'; nc.revision++;
    if (!d) { d = { id: uid('doc'), path: relative }; nc.primarySourceId = d.id; nc.sourceIds.push(d.id); next.documents[relative] = d; }
    next.baselines[characterId] = { documentId: d.id, baselineId: baseline.id };
    const proposalChanges=[];
    if (proposalId) {
      const p = next.proposals.find(p => p.id === proposalId && (p.status === 'pending' || reconsider && ['accepted','rejected'].includes(p.status))); if (!p) throw new AppError('NOT_FOUND', '建议已被处理');
      const beforeReview = { status: p.status, resolution: p.resolution || null, resolved_at: p.resolved_at || null, fact: copy(p.fact) }; if (p.status === 'pending') p.originalFact ||= copy(p.fact);
      const source=this.doc(p.fact.source_document_id),event=this.events.find(e=>e.id===p.eventId);if(!event)throw new AppError('NOT_FOUND','基座建议对应的事件缺失');
      const fact=await verifyFactEvidence(this.store,source,p.fact,proposalEvidence);fact.entity_id=characterId;const selected=normalized.find(f=>f.field===fact.field.replace(/^base\./,''));if(selected)fact.value=selected.value;fact.status='baseline_recorded';fact.author_reviewed_at=stamp();p.fact=copy(fact);p.status='accepted';p.resolved_at=stamp();
      const revised=copy(event),i=revised.facts.findIndex(f=>f.id===fact.id);if(i<0)throw new AppError('NOT_FOUND','基座建议对应事实缺失');revised.facts[i]=fact;revised.revision++;revised.evidence_review_required=revised.facts.some(f=>f.status==='pending'&&f.evidence_match?.status!=='matched');
      const ep=`_创作管理/事件/${event.id}.md`,b=await this.store.read(ep);proposalChanges.push({path:ep,expectedHash:hash(b),text:this.eventMarkdown(revised,decode(b).text)});
      const job=next.jobs.find(j=>j.id===p.jobId);if(job){job.pending=next.proposals.filter(p=>p.jobId===job.id&&p.status==='pending').length;job.evidenceSummary=evidenceSummary(this.events.map(e=>e.id===revised.id?revised:e).filter(e=>e.approval_id===job.approvalId));if(!job.pending)job.status='completed';}
      p.resolution = 'baseline'; recordDecision(p, beforeReview, reconsider ? 'reconsider_baseline' : 'baseline');
    }
    for (const f of normalized) {
      next.locks = next.locks.filter(l => !(l.entityId === characterId && l.field === `base.${f.field}`));
      next.locks.push({ id: uid('lock'), entityId: characterId, field: `base.${f.field}`, active: true, reason: '作者确认基座', created_at: stamp() });
    }
    delete next.externalChanges[d.id];
    if (reviewOrigin) { next.reviewAudit ||= []; next.reviewAudit.push({ id: uid('review'), ...copy(reviewOrigin), action: 'correct_current_baseline', at: stamp(), after: normalized.find(f => f.field === reviewOrigin.field.replace(/^base\./,''))?.value, baselineId: baseline.id }); }
    const versionPath = `_创作管理/历史/基座版本/${baseline.id}.md`;
    return this.commit('确认人物初始基座', [{ path: relative, expectedHash: before, bytes: encode(text, format) }, { path: versionPath, expectedHash: null, text: recordMarkdown({ ...baseline, title: `${c.name}·基座版本${baseline.revision}` }, body) },...proposalChanges], next);
  }
  async updateCharacter({ id, name, aliases = [], disambiguation = '', confirmIdentity = false }) {
    const next = copy(this.project); const c = next.characters.find(c => c.id === id); if (!c) throw new AppError('NOT_FOUND', '人物不存在');
    c.name = cleanName(name); c.aliases = [...new Set(aliases.map(cleanName))]; c.disambiguation = String(disambiguation).slice(0, 300); c.revision++;
    if (confirmIdentity) c.status = 'registered';
    return this.commit('修改人物索引', [], next);
  }
  async addCharacter({ name, aliases = [] }) {
    const next = copy(this.project); const n = cleanName(name);
    const c = { id: uid('char'), work_id: next.id, name: n, aliases: aliases.map(cleanName), sourceIds: [], sourceEvidence: [], status: 'registered', revision: 1, created_at: stamp(), authorCreated: true };
    next.characters.push(c); await this.commit('新建人物', [], next); return c;
  }
  async setLock({ entityId, field, active }) {
    this.character(entityId); const next = copy(this.project);
    next.locks = next.locks.filter(l => !(l.entityId === entityId && l.field === field));
    if (active) next.locks.push({ id: uid('lock'), entityId, field: cleanName(field), active: true, reason: '作者手动保护', created_at: stamp() });
    return this.commit(active ? '保护字段' : '解除字段保护', [], next);
  }
  async addScene({ documentId, name, quote }) {
    const d = await this.snapshotDocument(this.doc(documentId)); const start = d.text.indexOf(quote);
    if (typeof quote !== 'string' || quote.length < 2 || start < 0 || d.text.indexOf(quote, start + 1) >= 0) throw new AppError('SCENE', '请提供源稿中唯一的连续片段作为场景');
    const end = start + quote.length;
    if (this.project.scenes.some(s => s.documentId === documentId && s.sourceHash === d.hash && s.start < end && s.end > start)) throw new AppError('SCENE', '场景范围与已有场景重叠');
    const scene = { id: uid('scene'), documentId, name: cleanName(name), start, end, sourceHash: d.hash };
    const next = copy(this.project); next.scenes.push(scene); await this.commit('划分场景', [], next); return scene;
  }
  async setChapterMaterialVisibility({ documentId, hidden }) {
    const doc = this.doc(documentId);
    if (typeof hidden !== 'boolean' || (!doc.chapterMaterial && doc.kind !== 'draft') || doc.kind === 'chapter') {
      throw new AppError('VALIDATION', '请选择一份可整理的章节资料');
    }
    const approved = chapterOutlineApprovals(this).get(doc.chapterMaterial?.chapter ?? doc.chapter);
    if (hidden && approved?.documentId === doc.id) throw new AppError('VALIDATION', '本章采用的章纲须先改用另一份定案');
    const ids = new Set(this.project.hiddenChapterMaterials || []);
    if (ids.has(doc.id) === hidden) return true;
    if (hidden) ids.add(doc.id);
    else ids.delete(doc.id);
    await this.commit(hidden ? '从本章资料移出' : '恢复到本章资料', [], { ...copy(this.project), hiddenChapterMaterials: [...ids] });
    return true;
  }
  async selectWritingModel({ key, model, baseUrl, modelList }) {
    if (this.controllers.size) throw new AppError('BUSY', '请先完成或停止正在运行的 AI 任务。');
    if (typeof key !== 'string' || !key) throw new AppError('AI_CONFIG', '请选择一个可用模型。');
    if (key !== 'analysis') return this.updateSettings({ writingModel: key });
    const ai = this.project.settings.ai;
    if (!ai.enabled || !ai.baseUrl || ai.baseUrl !== baseUrl || typeof model !== 'string' ||
        !model.trim() || model.length > 200 || /[\r\n\0]/u.test(model)) {
      throw new AppError('AI_CONFIG', '模型连接已变化，请重新读取列表后选择。');
    }
    return this.updateSettings({ writingModel: key, ai: { ...ai, model, modelList } });
  }
  async updateSettings(input) {
    const next = copy(this.project);
    if (input.name !== undefined) next.name = cleanName(input.name);
    if (input.era !== undefined) next.settings.era = String(input.era).slice(0, 500);
    if (input.parentWork !== undefined) next.settings.parentWork = String(input.parentWork).slice(0, 200);
    if (input.writingStyle !== undefined) {
      if (!Object.hasOwn(WRITING_STYLES, input.writingStyle)) throw new AppError('VALIDATION', '共写风格无效');
      next.settings.writingStyle = input.writingStyle;
    }
    if (input.writingModel !== undefined) {
      if (input.writingModel !== 'analysis' && !this.localPresets.some(preset => preset.id === input.writingModel && preset.available)) {
        throw new AppError('AI_CONFIG', '请选择已有的本机写作模型或沿用剧情分析模型');
      }
      next.settings.writingModel = input.writingModel;
    }
    if (input.memlayer !== undefined) next.settings.memlayer = validateMemlayer(input.memlayer);
    if (input.ai) {
      const old = next.settings.ai; const ai = input.ai;
      const aiModelList = Array.isArray(ai.modelList)
        ? [...new Set(ai.modelList.map(v => String(v ?? '').trim()).filter(v => v && v.length <= 200))].slice(0, 300)
        : Array.isArray(old.modelList) ? old.modelList : [];
      next.settings.ai = { ...old, enabled: !!ai.enabled, baseUrl: connectionBase(String(ai.baseUrl || '').trim()), model: String(ai.model || '').trim(), modelList: aiModelList, maxOutputTokens: Math.max(256, Math.min(Math.trunc(Number(ai.maxOutputTokens)) || 8192, WRITING_OUTPUT_LIMIT)), maxTokensPerJob: Math.max(1000, Math.min(Number(ai.maxTokensPerJob) || old.maxTokensPerJob, 2000000)), dailyTokenLimit: Math.max(1000, Math.min(Number(ai.dailyTokenLimit) || old.dailyTokenLimit, 10000000)) };
    }
    if (input.gate && this.externalGate) next.settings.gate = { ...next.settings.gate, enabled: next.settings.gate.required || !!input.gate.enabled, python: String(input.gate.python || ''), defaultCard: String(input.gate.defaultCard || '') };
    if (input.sources) {
      if (!Array.isArray(input.sources) || input.sources.length > 50) throw new AppError('VALIDATION', '资料路径配置无效');
      const kinds = new Set([...WORLD_SOURCE_KINDS, 'chapter', 'draft', 'character', 'reference', 'plan', 'rule', 'plot', 'attachment']);
      for (const s of input.sources) { await this.store.resolve(s.path); if (!kinds.has(s.kind)) throw new AppError('VALIDATION', '资料类型不受支持'); }
      next.sources = input.sources.map(s => ({ path: s.path, kind: s.kind, depth: Math.max(0, Math.min(Number(s.depth) || 0, 3)), ...(s.readOnly === true ? { readOnly: true } : {}) }));
    }
    await this.commit('修改作品设置', [], next); return this.summary();
  }
  async rememberReader({ documentId, offset, fontSize, theme, themeExplicit, lineHeight }) {
    if (documentId) this.doc(documentId);
    this.project.reader = { ...this.project.reader, documentId, offset: Math.max(0, Number(offset) || 0), fontSize: Math.max(14, Math.min(Number(fontSize) || 19, 32)),
      theme: ['light', 'dark', 'paper'].includes(theme) ? theme : 'follow', themeExplicit: themeExplicit === true,
      lineHeight: Math.max(1.5, Math.min(Number(lineHeight) || 2.1, 3)) };
    await this.persist(); return true;
  }
  async saveRecord({ id, kind, title, body, status = 'planned', participants = [], details = {}, expectedRevision, expectedHash }, extra = () => []) {
    if (!RECORD_KINDS.has(kind)) throw new AppError('VALIDATION', '资料类型无效');
    const old = this.records.find(r => r.id === id);
    if (old && old.revision !== expectedRevision) throw new AppError('CONFLICT', '资料版本已变化');
    for (const p of participants) this.character(p);
    if (!details || typeof details !== 'object' || Array.isArray(details) || JSON.stringify(details).length > 30000) throw new AppError('VALIDATION', '结构化资料格式无效或超过限制');
    if (kind === 'plot_arc') validateStageDetails(details, this.events, old?.details);
    for (const key of ['initialHolderId', 'currentHolderId', 'knowerId', 'informerId']) if (details[key]) this.character(details[key]);
    for (const member of details.members || []) { this.character(member.characterId); if (member.fromChapter && member.toChapter && member.toChapter < member.fromChapter) throw new AppError('VALIDATION', '离开章节不能早于加入章节'); }
    for (const key of ['actualEventIds', 'relatedEventIds', 'custodyEventIds']) for (const eventId of details[key] || []) if (!this.events.some(e => e.id === eventId)) throw new AppError('VALIDATION', '关联事件不属于本作品');
    for (const key of ['attachmentDocIds', 'sourceDocIds']) for (const docId of details[key] || []) this.doc(docId);
    const record = { id: old?.id || uid('record'), work_id: this.project.id, kind, title: cleanName(title), body: String(body || '').slice(0, 100000), status, participants, revision: (old?.revision || 0) + 1, created_at: old?.created_at || stamp(), updated_at: stamp(), updated_by: '作者' };
    record.details = copy(details);
    const p = `_创作管理/资料/${record.id}.md`, bytes = await this.store.read(p);
    if (bytes && expectedHash && hash(bytes) !== expectedHash) throw new AppError('CONFLICT', '资料文件已被外部修改');
    await this.commit('保存剧情资料', [{ path: p, expectedHash: bytes ? hash(bytes) : null, text: recordMarkdown(record, record.body) }, ...extra(record)]); return record;
  }
  eventMarkdown(e, existing = null) {
    const pending=e.facts.filter(f=>f.status==='pending').length;
    const pendingNote = e.editorial_status === 'accepted' ? '事件摘要已核对，关联变化待处理。' : '以下摘要尚未完整确认。';
    const body = `${pending?`> 记录状态：${pending} 项提取待作者核对。${pendingNote}\n\n`:''}${e.summary || ''}\n\n故事时间：${e.story_time || '尚未确定'}\n\n${e.facts.filter(f => f.status === 'accepted').map(f => `## ${this.project.characters.find(c => c.id === f.entity_id)?.name || f.entity_id} · ${FIELD_LABELS[f.field] || f.field}\n\n${valueText(f.value)}\n\n> ${f.evidence || '作者手动裁定'}\n\n出处：${f.source_document_id || '作者裁定'}，${f.source_chapter ? `第${f.source_chapter}章` : '章序未定'}；事实ID：${f.id}`).join('\n\n')}`;
    const base = existing ? replaceRecordHeader(existing, e) : recordMarkdown(e, '');
    const evidence = e.editorial_evidence?.evidence;
    return managedBlock(base, `event-body-${e.id}`, evidence ? `> 事件依据：${evidence}\n\n${body}` : body);
  }
  async checksFor({ documentId, ...options }) {
    const d = await this.snapshotDocument(this.doc(documentId)); const result = decorateWording(await runGate(this.store, d, this.gateConfiguration(), options), this.project);
    return this.exclusive(async () => { this.project.checks = [...this.project.checks.slice(-199), result]; await this.persist(); return result; });
  }
  async undoBatch(id) {
    const record = (await this.store.history()).find(r => r.id === id && r.status === 'committed');
    if (!record) throw new AppError('RESTORE', '只能撤销已完成批次');
    const changes = []; let next = copy(this.project);
    for (let i = 0; i < record.files.length; i++) {
      const f = record.files[i];
      const b = f.beforeHash ? await this.store.read(`_创作管理/历史/${id}/${i}.before`) : null;
      const a = f.afterHash ? await this.store.read(`_创作管理/历史/${id}/${i}.after`) : null;
      if ((b ? hash(b) : null) !== f.beforeHash || (a ? hash(a) : null) !== f.afterHash) throw new AppError('DAMAGED_SNAPSHOT', '批次快照缺失或损坏，停止撤销');
      if (f.path === '_创作管理/project.json') {
        const before = JSON.parse(b.toString()), after = JSON.parse(a.toString());
        next = inverseProject(before, after, this.project);
        if (record.label === '登记资料新路径') {
          const previousIds = new Set((before.sourceHistory?.moves || []).map(move => move.id));
          for (const move of (after.sourceHistory?.moves || []).filter(item => !previousIds.has(item.id))) {
            const latest = this.project.sourceHistory?.moves.filter(item => item.documentId === move.documentId).at(-1);
            if (latest?.id !== move.id || this.project.sourceHistory?.retired[move.documentId]) {
              throw new AppError('CONFLICT', '这个来源后来又处理过，请核对最新去向');
            }
            if (next.documents[move.to]?.id === move.documentId) delete next.documents[move.to];
          }
        }
        if (record.label === '发布草稿为正文') {
          for (const [documentId, publication] of Object.entries(after.chapterPublications || {})) {
            if (before.chapterPublications?.[documentId]) continue;
            if (next.documents[publication.to]?.id === documentId) delete next.documents[publication.to];
            next.documents[publication.from] = before.documents[publication.from];
          }
        }
      } else changes.push({ path: f.path, expectedHash: f.afterHash, bytes: b });
    }
    for (const j of next.jobs) if (['running', 'applying', 'queued'].includes(j.status)) { j.status = 'interrupted'; j.error = '批次已撤销，可重新运行确认版本'; }
    return this.commit(`撤销：${record.label}`, changes, next);
  }
}
Object.assign(Workspace.prototype, jobMethods);
Object.assign(Workspace.prototype, chapterReviewMethods);
Object.assign(Workspace.prototype, extraMethods);
Object.assign(Workspace.prototype, sourceLifecycleMethods);
Object.assign(Workspace.prototype, draftMethods);
Object.assign(Workspace.prototype, wordingMethods);

Object.assign(Workspace.prototype, revisionMethods);
Object.assign(Workspace.prototype, memoryMethods);
Object.assign(Workspace.prototype, obligationMethods);
Object.assign(Workspace.prototype, reviewMethods);
Object.assign(Workspace.prototype, cowritingMethods);
Object.assign(Workspace.prototype, creativeTaskMethods);
Object.assign(Workspace.prototype, libraryMethods);
Object.assign(Workspace.prototype, researchMethods);
Object.assign(Workspace.prototype, manuscriptReviewMethods);
Object.assign(Workspace.prototype, writingExtensionDraftMethods);
Object.assign(Workspace.prototype, bookReviewMethods);
Object.assign(Workspace.prototype, bookSemanticReviewMethods);
