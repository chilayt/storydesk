import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importTextDocuments } from '../core/text-import.mjs';
import { Workspace } from '../core/workspace.mjs';
import { hash, uid, decode } from '../core/io.mjs';
import { requestModel, listModels } from '../core/analysis.mjs';
import {redactProviderMessage} from '../core/provider-errors.mjs';
import { connectionBase } from '../core/model-connections.mjs';

let workspace = null; const keyRequests = new Map(); let seq = 0;
const networkRequests = new Map();
const networkFetch = (url, options) => new Promise((resolve, reject) => {
  const id = ++seq;
  const abort = () => {
    const entry = takeNetworkRequest(id);
    if (!entry) return;
    parentPort.postMessage({ type: 'networkCancel', id });
    const error = options.signal.reason || new DOMException('请求已取消', 'AbortError');
    if (entry.body) entry.body.error(error);
    else reject(error);
  };
  if (options.signal?.aborted) return reject(options.signal.reason || new DOMException('请求已取消', 'AbortError'));
  options.signal?.addEventListener('abort', abort, { once: true });
  networkRequests.set(id, { resolve, reject, cleanup: () => options.signal?.removeEventListener('abort', abort) });
  parentPort.postMessage({ type: 'network', id, url, method: options.method, headers: options.headers, body: options.body,
    streamResponse: options.streamResponse === true, workId: workspace?.project?.id });
});
function takeNetworkRequest(id) {
  const entry = networkRequests.get(id);
  networkRequests.delete(id);
  entry?.cleanup();
  return entry;
}
const mutating = new Set(['saveDocument', 'approveBaseline', 'updateCharacter', 'addCharacter', 'mergeCharacters', 'confirmAppearance', 'restoreMissingDocument', 'acknowledgeManaged', 'updateSettingMeta', 'setLock', 'addScene', 'updateSettings', 'rememberReader', 'saveRecord', 'confirmRevision', 'restartJob', 'cancelJob', 'resolveProposal', 'updateField', 'acknowledgeExternal', 'setDraft', 'decideWording', 'revokeWording', 'saveRevisionDraft', 'applyRevision']);
mutating.add('saveMemory'); mutating.add('setMemoryStatus');
mutating.add('correctReviewedItem'); mutating.add('withdrawReviewedItem');
for(const m of ['saveObligationCard','reviewObligation','acceptObligationEvidence'])mutating.add(m);
mutating.add('saveWritingOutline');
mutating.add('confirmVolumeOutline');
mutating.add('confirmChapterOutline');
mutating.add('decideChapterReview');
mutating.add('buildIndependentLibrary');
mutating.add('classifyLibraryDocument');
mutating.add('registerLocationMap');
for (const method of ['createCreativeTask', 'saveCreativeTask', 'setWritingRecovery']) mutating.add(method);
mutating.add('saveCowritingInput');
mutating.add('saveCowritingQueue');
for (const method of ['forkCowriting', 'setCowritingMessageVisibility']) mutating.add(method);
mutating.add('batchManuscriptWording');
for (const method of ['createResearchCandidate', 'saveResearchCandidate']) mutating.add(method);
mutating.add('resolveMissingSource');
mutating.add('createChapterDraft');
mutating.add('hideOtherChapterDrafts');
for (const method of ['applyWorkspaceDraftEdit', 'applyCowritingDraftEdit', 'undoCowritingDraftEdit', 'archiveWorkspaceFiles', 'restoreWorkspaceFile']) mutating.add(method);
for (const method of ['applyManuscriptEdits', 'decideManuscriptWording']) mutating.add(method);
for (const method of ['confirmManuscriptIssue', 'undoManuscriptDecision', 'carryManuscriptWording']) mutating.add(method);
mutating.add('setChapterMaterialVisibility');
mutating.add('applyCowritingStagePlan');
const allowed = new Set([...mutating, 'readDocument', 'getCharacter', 'managedDiff', 'setDraft', 'clearDraft', 'checksFor', 'getRevision', 'generateRevision', 'cancelRevision', 'proposalEvidence', 'memoryContext', 'checkObligations','cancelObligationCheck','getObligationReport','obligationEvidence','obligationGate','obligationContext']);
allowed.add('readSourceHistory');
for (const method of ['reviewHistory','reviewRecord','reviewSource','approvedSource']) allowed.add(method);
for (const method of ['getCowriting', 'sendCowriting', 'cancelCowriting', 'previewWritingRevision', 'getWorkspaceEditMarks', 'getWorkspaceDraftEdit']) allowed.add(method);
for (const method of ['listCreativeTasks', 'getCreativeTask', 'getWritingContext', 'saveMemoryFeedback']) allowed.add(method);
for (const method of ['memlayerStatus', 'memlayerMemory']) allowed.add(method);
for (const method of ['memlayerPropose', 'memlayerReview', 'memlayerRetract']) { allowed.add(method); mutating.add(method); }
allowed.add('previewLibrary');
for (const method of ['searchResearch', 'listResearchCandidates', 'getResearchCandidate']) allowed.add(method);
for (const method of ['getManuscriptReport', 'manuscriptReviewStates', 'checkManuscript', 'cancelManuscriptReview', 'searchManuscriptWording',
  'writingRuleCatalogue', 'previewWritingRule']) allowed.add(method);
for (const method of ['listWritingExtensionDrafts', 'readWritingExtensionDraft', 'saveWritingExtensionDraft']) allowed.add(method);
mutating.add('saveWritingExtensionDraft');
for (const method of ['manuscriptProgress', 'getManuscriptHistory', 'getManuscriptSaveDiff']) allowed.add(method);
allowed.add('suggestManuscriptEdit');
for (const method of ['getBookReview', 'stopBookReview', 'previewBookEvidence', 'startBookReview', 'decideBookReview']) allowed.add(method);
for (const method of ['startBookReview', 'decideBookReview']) mutating.add(method);
for (const method of ['getBookSemanticReview', 'listBookSemanticHistory', 'stopBookSemanticReview', 'startBookSemanticReview']) allowed.add(method);
mutating.add('startBookSemanticReview');
const getKey = (workId, base) => new Promise((resolve, reject) => { const id = ++seq; keyRequests.set(id, { resolve, reject }); parentPort.postMessage({ type: 'key', id, workId, base }); });
parentPort.on('message', async message => {
  if (message.type === 'networkHead') {
    const entry = networkRequests.get(message.id);
    if (!entry) return;
    const body = new ReadableStream({
      start: controller => { entry.body = controller; },
      cancel: () => { if (takeNetworkRequest(message.id)) parentPort.postMessage({ type: 'networkCancel', id: message.id }); },
    });
    entry.resolve(new Response(body, { status: message.status, headers: message.headers }));
    return;
  }
  if (message.type === 'networkChunk') {
    networkRequests.get(message.id)?.body?.enqueue(message.bytes);
    return;
  }
  if (message.type === 'networkEnd') {
    takeNetworkRequest(message.id)?.body?.close();
    return;
  }
  if (message.type === 'networkResult') {
    const entry = takeNetworkRequest(message.id);
    if (!entry) return;
    if (message.error) {
      const error = Object.assign(new Error(message.error), { code: message.code });
      if (entry.body) entry.body.error(error);
      else entry.reject(error);
    } else entry.resolve(new Response([204, 205, 304].includes(message.status) ? null : message.body, {
      status: message.status, headers: message.headers || { 'content-type': 'application/json' },
    }));
    return;
  }
  if (message.type === 'keyResult') { const p = keyRequests.get(message.id); if (p) { keyRequests.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.key); } return; }
  const { id, method, args = {}, expectedWorkId } = message;
  try {
    let result;
    if (method === 'init') {
      if (workspace) await workspace.close();
      const selected = new Workspace(args.root, {
        localPresets: args.localPresets, externalGate: false,
        getKey: profile => getKey(selected.project.id, profile.baseUrl),
        fetcher: networkFetch, notify: event => parentPort.postMessage({ type: 'event', event }),
      }); workspace = selected;
      result = await workspace.init(); workspace.startWatching();
    } else if (method === 'close') { await workspace?.close(); workspace = null; result = true; }
    else {
      if (!workspace) throw new Error('请先选择作品');
      if (expectedWorkId && expectedWorkId !== workspace.project.id) throw new Error('作品已切换，请刷新后再操作');
      if (method === 'summary') result = workspace.summary();
      else if (method === 'refresh') result = await workspace.exclusive(async () => { await workspace.refresh(); return workspace.summary(); });
      else if (method === 'relationships') result = workspace.relationships(args.cutoff ?? null);
      else if (method === 'search') result = workspace.index.search(workspace.project.id, String(args.query || '').slice(0, 300), args.kind)
        .filter(row => !workspace.project.hiddenChapterMaterials?.includes(row.id));
      else if (method === 'history') result = (await workspace.store.history()).slice(0, 300);
      else if (method === 'undo') result = await workspace.exclusive(() => workspace.undoBatch(args.id));
      else if (method === 'recover') result = await workspace.exclusive(async () => { workspace.recovery = await workspace.store.recover(); workspace.project = JSON.parse((await workspace.store.read('_创作管理/project.json')).toString('utf8')); await workspace.refresh(); return workspace.recovery; });
      else if (method === 'abandonRecovery') result = await workspace.exclusive(async () => { const r = await workspace.store.abandonRecovery(args.id); workspace.recovery = await workspace.store.recover(false); workspace.project = JSON.parse((await workspace.store.read('_创作管理/project.json')).toString('utf8')); await workspace.refresh(); return r; });
      else if (method === 'recoveryDiff') {
        const record = (await workspace.store.history()).find(r => r.id === args.id); const index = Number(args.index);
        if (!record || !Number.isInteger(index) || !record.files[index]) throw new Error('恢复记录不存在');
        const f = record.files[index], b = await workspace.store.read(`_创作管理/历史/${record.id}/${index}.before`), a = await workspace.store.read(`_创作管理/历史/${record.id}/${index}.after`), c = await workspace.store.read(f.path);
        result = { path: f.path, before: b?.toString('utf8') || '原文件不存在', after: a?.toString('utf8') || '拟移除文件', current: c?.toString('utf8') || '当前文件不存在' };
      }
      else if (method === 'sourcePath') result = await workspace.registeredSourcePath(args.documentId);
      else if (method === 'importSelectedTexts') {
        const current = workspace;
        result = await current.exclusive(() => importTextDocuments(current, args.files));
      }
      else if (method === 'mapPreviewPath') {
        if (workspace.doc(args.documentId).kind !== 'attachment') throw new Error('此资料不是地图附件');
        result = await workspace.registeredSourcePath(args.documentId);
      }
      else if (method === 'versions') {
        workspace.doc(args.documentId); const dir = await workspace.store.resolve(`_创作管理/历史/文档版本/${args.documentId}`);
        let entries = []; try { entries = await fs.readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        result = [];
        for (const name of entries.filter(n => /^[a-f0-9]{64}\.md$/.test(n))) { const stat = await fs.stat(path.join(dir, name)); result.push({ hash: name.slice(0, -3), saved_at: stat.mtime.toISOString() }); }
        result.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
      } else if (method === 'versionText') {
        workspace.doc(args.documentId); if (!/^[a-f0-9]{64}$/.test(args.hash)) throw new Error('版本号无效');
        const b = await workspace.store.read(`_创作管理/历史/文档版本/${args.documentId}/${args.hash}.md`); if (!b || hash(b) !== args.hash) throw new Error('版本快照不存在或损坏'); result = decode(b).text;
      } else if (method === 'createDocument') {
        result = await workspace.exclusive(async () => {
          const { title, kind, chapter } = args;
          if (typeof title !== 'string' || !title.trim() || /[<>:"/\\|?*\r\n\0]/.test(title) || title.length > 100) throw new Error('标题不能为空或包含文件名禁用字符');
          if (!['chapter', 'setting', 'plan', 'reference', 'organization', 'location', 'item', 'family'].includes(kind)) throw new Error('资料类型无效');
          const sources = workspace.project.sources.filter(s => s.kind === kind && !s.readOnly && !s.path.endsWith('.md'));
          const source = sources.find(s => s.path.startsWith('创作资料库/') && s.path.split('/').length === 2) || sources[0];
          const folder = source?.path || ({ chapter: '正文', setting: '设定', plan: '规划', reference: '资料',
            organization: '势力', location: '地点', item: '道具物资', family: '家族' })[kind];
          if (kind === 'chapter' && (!Number.isInteger(chapter) || chapter < 1 || chapter > 99999)) throw new Error('章序无效');
          const relative = `${folder}/${kind === 'chapter' ? `第${String(chapter).padStart(2, '0')}章_` : ''}${title.trim()}.md`;
          const content = `# ${kind === 'chapter' ? `第${chapter}章　` : ''}${title.trim()}\n\n`;
          const next = structuredClone(workspace.project);
          if (!source) next.sources.push({ path: folder, kind, depth: 0 });
          const result = await workspace.commit('新建文档', [{ path: relative, expectedHash: null, text: content }], next);
          return { ...result, document: workspace.documents.find(d => d.path === relative) };
        });
      } else if (method === 'exportData') {
        result = { schema_version: 1, exported_at: new Date().toISOString(), project: workspace.project, documents: workspace.documents.filter(d => d.kind !== 'attachment' && !d.error).map(d => ({ path: d.path, kind: d.kind, text: d.text })), events: workspace.events, records: workspace.records, memories: workspace.memories, obligationCards:workspace.obligationCards, obligationChecks:workspace.obligationChecks };
      } else if (method === 'testModel') {
        if(workspace.controllers.size)throw new Error('已有AI任务运行，请完成或取消后测试连接');
        const profile=args.connection ? { ...workspace.project.settings.ai } : workspace.agentProfile();
        profile.maxOutputTokens=Math.min(profile.maxOutputTokens||2048,2048);
        profile.sessionId=uid('modeltest').split('_').at(-1);
        const testedEndpoint=(()=>{try{const u=new URL(profile.baseUrl);return u.origin+u.pathname;}catch{return '地址无效';}})();
        const tested={model:profile.model,baseUrl:testedEndpoint,tested_at:new Date().toISOString()};
        try{
          const key = await workspace.getKey(profile);
          if (args.connection && profile.enabled && profile.baseUrl && !profile.model) {
            const { models } = await listModels(profile, key, networkFetch);
            profile.model = models.includes('glm-5.3-flash') ? 'glm-5.3-flash' : models[0];
            tested.model = profile.model;
          }
          const response=await requestModel(profile,key,[{role:'system',content:'直接返回JSON对象，包含空数组events，不要解释。'},{role:'user',content:'这是一条连接测试，不包含小说资料。'}],{fetcher:networkFetch});
          const usage=Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(k=>Number.isFinite(Number(response.usage?.[k]))).map(k=>[k,Number(response.usage[k])]));
          result={...tested,connected:true,httpStatus:200,usage,billingSource:response.usage?.opencode?.billing_source?redactProviderMessage(response.usage.opencode.billing_source,key).slice(0,80):null};
          await workspace.exclusive(async()=>{workspace.project.modelTest=result;await workspace.persist();});
        }catch(e){const failed={...tested,connected:false,message:e.message,errorCode:e.code||'ERROR',diagnostics:e.details||null};await workspace.exclusive(async()=>{workspace.project.modelTest=failed;await workspace.persist();});throw e;}
      } else if (method === 'listModels') {
        // 用界面当前填写的地址（可能还没保存），没填则用已保存的
        const base = connectionBase(String(args?.baseUrl || '').trim() || workspace.project.settings.ai.baseUrl);
        const key = await getKey(workspace.project.id, base);
        result = await listModels({ ...workspace.project.settings.ai, baseUrl: base }, key, networkFetch);
      } else if (method === 'checkModelIdle') {
        if (workspace.controllers.size) throw new Error('请先完成或停止正在运行的 AI 任务。');
        result = true;
      } else if (method === 'selectWritingModel') {
        result = await workspace.exclusive(() => workspace.selectWritingModel(args));
      } else if (allowed.has(method)) {
        const current = workspace;
        const fn = () => method === 'readDocument' ? current.readDocument(args.documentId) : method === 'getCharacter' ? current.getCharacter(args.id, args.cutoff ?? null) : method === 'clearDraft' ? current.clearDraft(args.documentId) : current[method](args);
        result = mutating.has(method) ? await current.exclusive(fn) : await fn();
      } else throw new Error('不支持的操作');
    }
    parentPort.postMessage({ id, result });
  } catch (e) { parentPort.postMessage({ id, error: { code: e.code || 'ERROR', message: e.message, details: e.details || {} } }); }
});
