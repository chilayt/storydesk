import fs from 'node:fs/promises';
import { AppError, hash, uid, stamp, atomicJson, encode, decode } from './io.mjs';
import { splitSource, buildPrompt, requestModel, validateExtraction, FIELD_LABELS } from './analysis.mjs';
import { managedBlock, recordMarkdown } from './catalog.mjs';
import { evidenceSummary, verifyFactEvidence, sourceSpans } from './evidence.mjs';
import { loadExtraction, saveExtraction } from './extraction-cache.mjs';
import { gateQuotationStyle, GATE_POLICY_VERSION } from './gate.mjs';
import { assertReviewCurrent, recordDecision } from './review.mjs';
import { chapterReviewEntries, isRecordedEvent } from './chapter-review.mjs';
import { prepareDraftPublication, registerDraftPublication } from './drafts.mjs';
import { recordSourceMove } from './source-lifecycle.mjs';

const copy = v => structuredClone(v);
const textValue = v => typeof v === 'string' ? v : JSON.stringify(v);
const fingerprint = f => JSON.stringify([f.source_document_id, f.source_hash, f.entity_id, f.field, f.value, f.layer, f.start]);
const safeLine = s => String(s).replace(/[\r\n]+/g, ' ').replaceAll('|', '｜');

export const jobMethods = {
  async confirmRevision({ documentId, sourceHash, kind = 'prose', sceneId = null, independentReason = '', reviewPlot = false, publishDraft = false }) {
    if (!['prose', 'plan', 'ruling', 'baseline'].includes(kind)) throw new AppError('VALIDATION', '确认类型无效');
    const d = await this.snapshotDocument(this.doc(documentId));
    if (d.hash !== sourceHash) throw new AppError('CONFLICT', '当前文件与所确认的版本不同，请重新打开');
    if (kind === 'prose' && !['chapter', 'draft'].includes(d.kind)) throw new AppError('VALIDATION', '请将正文放入已登记的正文或草稿目录');
    if (publishDraft && (kind !== 'prose' || sceneId)) throw new AppError('VALIDATION', '发布需核对整章草稿');
    if (publishDraft && d.kind === 'chapter' && this.project.chapterPublications?.[d.id]?.hash === d.hash) {
      const release = this.project.chapterPublications[d.id];
      const approval = this.project.approvals.find(row => row.id === release.approvalId);
      return { approval, job: this.project.jobs.find(row => row.approvalId === release.approvalId), publication: release };
    }
    let scene = null;
    if (sceneId) { scene = this.project.scenes.find(s => s.id === sceneId && s.documentId === documentId && s.sourceHash === d.hash); if (!scene) throw new AppError('SCENE', '场景版本已失效'); }
    let obligations = null, gateCheck = null, carryReview = null;
    if (kind === 'prose') {
      const check = [...this.project.checks].reverse().find(c => c.documentId === documentId && c.sourceHash === d.hash);
      if (!check || !['passed', 'not_required'].includes(check.status)) throw new AppError('NEEDS_GATE', '请先完成当前稿件的检查');
      if (check.gatePolicyVersion !== GATE_POLICY_VERSION) throw new AppError('NEEDS_GATE', '承接规则已改为提醒，请重新运行当前版本检查');
      if (check.quotationStyle === 'any' && await gateQuotationStyle(this.store, this.gateConfiguration()) === 'chinese') {
        throw new AppError('NEEDS_GATE', '作品引号规则已更新，请重新运行当前版本检查');
      }
      gateCheck = check;
      if (check.carry) {
        let currentHash = null;
        if (check.carry.card) { try { const b = await this.store.read(check.carry.card); currentHash = b ? hash(b) : null; } catch {} }
        carryReview = { checkId: check.id, status: check.carry.status, card: check.carry.card || '', selectedTitle: check.carry.selectedTitle || null, checkedCardHash: check.carry.cardHash || null, currentCardHash: currentHash, changedSinceCheck: !!check.carry.cardHash && currentHash !== check.carry.cardHash, blocking: false, authorAcknowledged: true, reviewed_at: stamp() };
      }
      if (check.scriptHash) { const b = await this.store.read(this.project.settings.gate.script); if (!b || hash(b) !== check.scriptHash) throw new AppError('NEEDS_GATE', '门禁规则已经改变，请重新检查'); }
      for (const dependency of check.dependencies || []) { let b; try { b = await fs.readFile(dependency.path); } catch { throw new AppError('NEEDS_GATE', '门禁依赖缺失，请重新检查'); } if (hash(b) !== dependency.hash) throw new AppError('NEEDS_GATE', '词表或检查规则已经改变，请重新检查'); }
      obligations = await this.obligationGate({documentId,sceneId});
      if (!obligations.passed) throw new AppError('OBLIGATION_REVIEW', '本版本的场景义务尚未逐项处理，请在场景与核对中完成检查或作者裁定', {cards:obligations.cards});
    }
    let existing = this.project.approvals.find(a => a.documentId === documentId && a.sourceHash === d.hash && a.kind === kind && a.sceneId === sceneId && a.status === 'active');
    const release = publishDraft ? await prepareDraftPublication(this, d) : null;
    const obligationRefs=obligations?.cards.map(c=>({cardId:c.id,cardHash:c.cardHash,reportId:c.checkId,reportHash:c.reportHash}))||[];
    if (existing && !release) {
      if(kind==='prose'&&(JSON.stringify(existing.obligationChecks||[])!==JSON.stringify(obligationRefs)||existing.gateCheckId!==gateCheck?.id)){const next=copy(this.project);Object.assign(next.approvals.find(a=>a.id===existing.id),{obligationChecks:obligationRefs,obligation_reviewed_at:stamp(),gateCheckId:gateCheck?.id,carryReview});await this.commit('作者复核本版本检查与提醒',[],next);existing=this.project.approvals.find(a=>a.id===existing.id);}
      const job = this.project.jobs.find(j => j.approvalId === existing.id);
      if (job && ['completed', 'partial', 'running', 'queued'].includes(job.status)) return { approval: existing, job };
      if (job) { await this.restartJob({ jobId: job.id }); return { approval: existing, job }; }
    }
    const approval = existing ? { ...existing, obligationChecks: obligationRefs, gateCheckId: gateCheck?.id, carryReview }
      : { id: uid('approval'), work_id: this.project.id, documentId, sourceHash: d.hash, snapshot: d.snapshot, kind, sceneId, start: scene?.start ?? 0, end: scene?.end ?? d.text.length, author: '作者', confirmed_at: stamp(), status: 'active', independentReason, obligationChecks:obligationRefs, gateCheckId:gateCheck?.id, carryReview };
    const previousJob = release && existing && this.project.jobs.find(j => j.approvalId === existing.id);
    const job = previousJob || { id: uid('job'), approvalId: approval.id, documentId, sourceHash: d.hash, mode: kind === 'ruling' ? 'baseline' : kind,
      status: this.agentProfile().enabled ? 'queued' : 'waiting_config', versionState: 'current', pending: 0, obsoletePending: 0,
      created_at: stamp(), completedChunks: 0, totalChunks: 0, usage: { total_tokens: 0 }, error: null };
    if (!previousJob && kind === 'prose' && (reviewPlot === true || release)) job.reviewPlot = true;
    const next = copy(this.project);
    if (!existing) next.approvals.push(approval);
    else if (release) next.approvals[next.approvals.findIndex(row => row.id === existing.id)] = approval;
    if (!previousJob) next.jobs.push(job);
    const changes = [];
    if (release) {
      registerDraftPublication(next, d, approval, release.target);
      recordSourceMove(next, d, release.target, '作者发布草稿为正文，原稿保留在原路径');
      changes.push({ path: release.target, expectedHash: null, bytes: release.bytes },
        { path: d.path, expectedHash: d.hash, bytes: release.bytes });
    }
    await this.commit(release ? '发布草稿为正文' : kind === 'prose' ? '作者确认稿件版本' : '作者确认设计或设定材料', changes, next);
    if (!previousJob && job.status === 'queued') setTimeout(() => this.executeJob(job.id).catch(e => this.notify({ type: 'warning', message: e.message })), 0);
    return { approval, job, ...(release ? { publication: next.chapterPublications[d.id] } : {}) };
  },
  async restartJob({ jobId, forceAnalysis = false }) {
    const job = this.project.jobs.find(j => j.id === jobId); if (!job) throw new AppError('NOT_FOUND', '任务不存在');
    const currentDoc = this.documents.find(d => d.id === job.documentId), currentBytes = currentDoc && await this.store.read(currentDoc.path);
    if (!currentBytes || hash(currentBytes) !== job.sourceHash) throw new AppError('STALE_REVIEW', '这是旧版本归档任务，已保留在章节历史中；请确认当前版本后处理对应的新任务');
    if (this.controllers.has(jobId)) return job;
    if (!this.agentProfile().enabled && (forceAnalysis||!job.rawResultAvailable)) throw new AppError('AI_CONFIG', '请先在设置中启用后台模型');
    if (['completed', 'partial'].includes(job.status)) throw new AppError('DUPLICATE', '该版本已处理，请在待核对项中处理剩余内容');
    job.status = 'queued'; job.error = null; job.errorCode=null;job.diagnostics=null;job.forceAnalysis=!!forceAnalysis;await this.persist();
    setTimeout(() => this.executeJob(job.id).catch(e => this.notify({ type: 'warning', message: e.message })), 0); return job;
  },
  async cancelJob({ jobId }) {
    const job = this.project.jobs.find(j => j.id === jobId); if (!job) throw new AppError('NOT_FOUND', '任务不存在');
    if (job.status === 'applying') throw new AppError('COMMITTING', '当前批次正在落盘，完成后可以撤销');
    this.controllers.get(jobId)?.abort(); job.status = 'cancelled'; job.error = '作者取消'; await this.persist(); return job;
  },
  async executeJob(jobId) {
    if (this.closing || this.controllers.size) { return; }
    const job = this.project.jobs.find(j => j.id === jobId); if (!job || job.status !== 'queued') return;
    const approval = this.project.approvals.find(a => a.id === job.approvalId);
    const controller = new AbortController(); this.controllers.set(jobId, controller); let memoryRun = null;
    try {
      const doc = this.doc(job.documentId); const bytes = await this.store.read(approval.snapshot);
      if (!bytes || hash(bytes) !== job.sourceHash) throw new AppError('SOURCE', '已确认源版本的快照缺失或损坏');
      const allText = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
      const source = allText.slice(approval.start, approval.end);
      const cached=await loadExtraction(this,job,approval);
      const characters = copy(this.project.characters.filter(c => c.status !== 'merged'));
      const related = characters.filter(c => [c.name, ...c.aliases].some(n => n && source.includes(n)));
      const profile = this.agentProfile();profile.sessionId ||= jobId.slice(jobId.indexOf('_')+1);
      const today = stamp().slice(0, 10);
      const usedToday = [...this.project.jobs, ...(this.project.aiAssistanceUsage || [])].filter(j => j.id !== jobId && j.created_at.startsWith(today)).reduce((sum, j) => sum + (j.usage?.total_tokens || 0), 0);
      const sourceHeads = cached?.sourceHeads||Object.fromEntries(this.documents.map(d => [d.id, d.hash]));
      const relatedNames = related.map(c => c.name);
      const prior = job.reviewPlot ? this.visibleFacts(doc.chapter - 1).filter(f => !f.eventStale && ['occurred', 'ruling'].includes(f.layer)) : [];
      const context = related.slice(0, 10).map(c => ({ id: c.id, baseline: this.baselines[c.id]?.fields?.slice(0, 3).map(f => ({ field: f.field, value: String(f.value).slice(0, 220) })),
        ...(job.reviewPlot ? { current: prior.filter(f => f.entity_id === c.id).slice(-5).map(f => ({ field: f.field, value: textValue(f.value).slice(0, 180) })) }
          : { notes: this.documents.find(d => d.id === c.primarySourceId)?.text.slice(0, 250) || '' }) }));
      const hooks = job.reviewPlot ? this.records.filter(r => r.kind === 'hook' && !r.damaged && !r.externalPending && !['paid_off', 'abandoned'].includes(r.status))
        .filter(r => !r.details?.introducedChapter || r.details.introducedChapter <= doc.chapter)
        .sort((a, b) => Number(source.includes(b.title)) - Number(source.includes(a.title)))
        .slice(0, 10).map(r => ({ id: r.id, title: r.title, status: r.status })) : null;
      const chunkLimit = Math.min(6000, Math.max(1400, Math.floor(profile.maxOutputTokens * 0.6)));
      let chunks = splitSource(source, chunkLimit);
      if (job.mode === 'prose' && !approval.sceneId) {
        const covered = this.project.jobs.filter(j => j.id !== jobId && j.documentId === job.documentId && j.sourceHash === job.sourceHash && ['completed', 'partial'].includes(j.status)).map(j => this.project.approvals.find(a => a.id === j.approvalId)).filter(a => a?.sceneId);
        if (covered.length) {
          let ranges = [{ start: approval.start, end: approval.end }];
          for (const c of covered) ranges = ranges.flatMap(r => c.end <= r.start || c.start >= r.end ? [r] : [{ start: r.start, end: Math.max(r.start, c.start) }, { start: Math.min(r.end, c.end), end: r.end }].filter(r => r.end > r.start));
          chunks = ranges.flatMap(r => splitSource(allText.slice(r.start, r.end), chunkLimit).map(c => ({ start: r.start - approval.start + c.start, text: c.text })));
        }
      }
      const extraction=cached||{schema_version:1,jobId,approvalId:approval.id,documentId:doc.id,sourceHash:job.sourceHash,start:approval.start,end:approval.end,sourceHeads,model:profile.model,created_at:stamp(),complete:false,parts:[]};
      if(cached?.complete)chunks=[];
      else if(extraction.parts.length){
        let ranges=chunks.map(c=>({start:approval.start+c.start,end:approval.start+c.start+c.text.length}));
        for(const p of extraction.parts)ranges=ranges.flatMap(r=>p.end<=r.start||p.start>=r.end?[r]:[{start:r.start,end:Math.max(r.start,p.start)},{start:Math.min(r.end,p.end),end:r.end}].filter(r=>r.end>r.start));
        chunks=ranges.flatMap(r=>splitSource(allText.slice(r.start,r.end),chunkLimit).map(c=>({start:r.start-approval.start+c.start,text:c.text})));
      }
      if(chunks.length&&!profile.enabled)throw new AppError('AI_CONFIG','本地结果尚未完整，请启用模型完成剩余分段');
      if(chunks.length&&usedToday>=profile.dailyTokenLimit)throw new AppError('BUDGET','已达到今日Token上限，未发送剧情');
      const key=chunks.length?await this.getKey(profile):'';
      if (chunks.length) memoryRun = await this.exclusive(() => this.beginMemoryRun({ taskId: jobId, task: 'extraction', documentId: doc.id, sourceHash: job.sourceHash, sceneId: approval.sceneId || null, characterIds: related.map(c => c.id), chapter: doc.chapter }));
      await this.exclusive(async () => { const live = this.project.jobs.find(j => j.id === jobId); live.status = 'running'; live.started_at = stamp(); live.totalChunks = chunks.length+extraction.parts.length; live.completedChunks = extraction.parts.length; live.relatedNames = relatedNames;live.reusedChunks=extraction.parts.length; await this.persist(); this.notify({ type: 'job', job: live }); });
      let totalTokens = Number(job.usage?.total_tokens) || 0;
      if(!cached)await saveExtraction(this,job,extraction,{fresh:true});
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        if (controller.signal.aborted) throw new AppError('CANCELLED', '任务已取消');
        const messages = buildPrompt(chunk.text, related, context, job.mode, memoryRun?.selected || [], hooks);
        const estimated = messages.reduce((n, m) => n + m.content.length * 2, 0) + profile.maxOutputTokens;
        if (totalTokens + estimated > profile.maxTokensPerJob || usedToday + totalTokens + estimated > profile.dailyTokenLimit) throw new AppError('BUDGET', '本次分析将超过所设Token上限，已停止；正式资料未改变');
        let result;
        try { result = await requestModel(profile, key, messages, { signal: controller.signal, beforeRequest: ({ attempt }) => this.exclusive(() => this.noteMemoryRequest({ runId: memoryRun.id, start: approval.start + chunk.start, end: approval.start + chunk.start + chunk.text.length, attempt })), ...(this.fetcher ? { fetcher: this.fetcher } : {}) }); }
        catch (e) {
          const charged = e.details?.requestSent===false?0:Number(e.details?.usage?.total_tokens) || estimated; totalTokens += charged; e._usageAccounted = true;
          await this.exclusive(async()=>{const live=this.project.jobs.find(j=>j.id===jobId);live.usage={total_tokens:totalTokens,estimated:!e.details?.usage?.total_tokens};await this.persist();});
          if ((e.code === 'AI_TRUNCATED' || e.code === 'AI_EMPTY' && e.details?.hasReasoning) && chunk.text.length > 1000) {
            const smaller = splitSource(chunk.text, Math.max(650, Math.floor(chunk.text.length / 2))).map(c=>({start:chunk.start+c.start,text:c.text}));
            chunks.splice(chunkIndex,1,...smaller);chunkIndex--;
            await this.exclusive(async()=>{const live=this.project.jobs.find(j=>j.id===jobId);live.totalChunks=chunks.length+(cached?.parts.length||0);live.adaptiveSplits=(live.adaptiveSplits||0)+1;live.diagnostics=e.details;await this.persist();this.notify({type:'job',job:live});});
            continue;
          }
          throw e;
        }
        totalTokens += Number(result.usage?.total_tokens) || estimated;
        extraction.usage={total_tokens:totalTokens,estimated:!result.usage?.total_tokens};
        extraction.parts.push({start:approval.start+chunk.start,end:approval.start+chunk.start+chunk.text.length,events:result.events,diagnostics:result.diagnostics||null,memoryRunId:memoryRun?.id||null});
        await saveExtraction(this,job,extraction);
        await this.exclusive(async () => { const live = this.project.jobs.find(j => j.id === jobId); live.completedChunks++; live.usage = { total_tokens: totalTokens, estimated: !result.usage?.total_tokens }; await this.persist(); this.notify({ type: 'job', job: live }); });
      }
      extraction.complete=true;await saveExtraction(this,job,extraction);
      if (controller.signal.aborted) throw new AppError('CANCELLED', '任务已取消');
      const snapshot = { document: { ...doc, hash: approval.sourceHash }, text: allText, characters, locks: copy(this.project.locks), sourceHeads, approval, chapterReview: !!job.reviewPlot };
      if(extraction.parts.reduce((n,p)=>n+p.events.reduce((sum,e)=>sum+(Array.isArray(e?.facts)?e.facts.length:0),0),0)>500)throw new AppError('AI_FORMAT','单任务事实超过500条，请缩小确认范围后分析',{stage:'extraction'});
      const events = extraction.parts.flatMap(part=>validateExtraction(part.events,{...snapshot,analysisRange:{start:part.start,end:part.end}},job.mode));
      const summary=evidenceSummary(events);
      await this.exclusive(async()=>{const live=this.project.jobs.find(j=>j.id===jobId);live.evidenceSummary=summary;live.diagnostics={stage:'evidence',...summary};await this.persist();});
      await atomicJson(await this.store.resolve(`_创作管理/任务/${jobId}.json`), { snapshot: { ...snapshot, characters: characters.map(c => ({ id: c.id, name: c.name, status: c.status })) }, events, evidenceSummary:summary, created_at: stamp(), model: extraction.model });
      await this.exclusive(async () => {
        const live = this.project.jobs.find(j => j.id === jobId); live.status = 'applying'; await this.persist();
        await this.applyAnalysis(jobId, events, snapshot);
      });
    } catch (e) {
      await this.exclusive(async () => {
        const current = this.project.jobs.find(j => j.id === jobId);
        if (e.code === 'RECOVERY_REQUIRED') { this.recovery = await this.store.recover(false); this.notify({ type: 'warning', message: e.message }); }
        else if (current) { current.status = current.versionState && current.versionState !== 'current' ? 'superseded' : e.code === 'CANCELLED' ? 'cancelled' : e.code === 'CONFLICT' ? 'stale' : 'failed'; current.error = e.message; current.errorCode = e.code || 'ERROR'; current.diagnostics = e.details || null; if (!e._usageAccounted && e.details?.usage?.total_tokens) current.usage = { total_tokens: (current.usage?.total_tokens || 0) + Number(e.details.usage.total_tokens), estimated: false }; await this.persist(); this.notify({ type: 'job', job: current }); }
      });
    } finally {
      try { if (memoryRun) await this.exclusive(() => this.finishMemoryRun({ runId: memoryRun.id, status: this.project.jobs.find(j => j.id === jobId)?.status || 'interrupted' })); }
      finally {
      this.controllers.delete(jobId);
      const next = this.project.jobs.find(j => j.status === 'queued');
      if (next && !this.closing) setTimeout(() => this.executeJob(next.id).catch(() => {}), 0);
      }
    }
  },
  async applyAnalysis(jobId, events, snapshot) {
    const job = this.project.jobs.find(j => j.id === jobId); const doc = this.doc(job.documentId);
    const current = await this.store.read(doc.path);
    if (!current || hash(current) !== job.sourceHash) throw new AppError('CONFLICT', '确认稿件已在分析期间改变；提取结果已保留，未自动归档');
    const next = copy(this.project); const changes = []; const acceptedIds = new Set();
    const chapterItems = [];
    const existingKeys = new Set(this.events.filter(e => !e.damaged).flatMap(e => e.facts.map(fingerprint)));
    const oldFacts = this.events.filter(e => !e.damaged && !e.unreviewedExternal && !e.uncommitted && !e.superseded && e.source_document_id === doc.id && e.source_hash !== job.sourceHash).flatMap(e => e.facts.filter(f => f.status === 'accepted').map(f => ({ ...f, eventId: e.id })));
    const matchedOld = new Set(); let applied = 0, pending = 0;
    for (const event of events) {
      event.work_id = this.project.id; event.source_document_id = doc.id; event.source_hash = job.sourceHash; event.source_chapter = doc.chapter; event.approval_id = snapshot.approval.id; event.created_at = stamp(); event.revision = 1;
      event.facts = event.facts.filter(f => !existingKeys.has(fingerprint(f)));
      if (!event.facts.length && (!job.reviewPlot || !event.editorial_evidence?.evidence && !event.hook_suggestions?.length)) continue;
      for (const fact of event.facts) {
        const character = this.project.characters.find(c => c.id === fact.entity_id);
        if (this.project.locks.some(l => l.entityId === fact.entity_id && l.field === fact.field && l.active !== false)) { fact.status = 'pending'; if (!fact.review_reasons.includes('字段受到人工保护')) fact.review_reasons.push('字段受到人工保护'); }
        if (character?.primarySourceId) {
          const sourceDoc = this.documents.find(d => d.id === character.primarySourceId);
          const b = sourceDoc && await this.store.read(sourceDoc.path);
          if (!b || hash(b) !== snapshot.sourceHeads[sourceDoc.id] || this.project.externalChanges[sourceDoc.id]) { fact.status = 'pending'; fact.review_reasons.push('人物原档存在尚未核对的外部修改'); }
        }
        const possible = oldFacts.filter(f => f.entity_id === fact.entity_id && f.field === fact.field && (f.field !== 'relationship' || f.value?.otherId === fact.value?.otherId));
        if (possible.length === 1) { fact.supersedes_fact_id = possible[0].id; matchedOld.add(possible[0].id); }
        else if (possible.length > 1) { fact.status = 'pending'; fact.review_reasons.push('旧稿存在多条同字段变化，需核对替代关系'); }
        if (job.reviewPlot) fact.status = 'pending';
        if (fact.status === 'accepted') { applied++; acceptedIds.add(fact.entity_id); }
        else { pending++; next.proposals.push({ id: uid('proposal'), eventId: event.id, jobId, fact: copy(fact), originalFact: copy(fact), revision: 0, status: 'pending', created_at: stamp(), operation: 'accept' }); }
        existingKeys.add(fingerprint(fact));
      }
      if (job.reviewPlot) chapterItems.push(...chapterReviewEntries(job, event));
      else changes.push({ path: `_创作管理/事件/${event.id}.md`, expectedHash: null, text: this.eventMarkdown(event) });
    }
    if (job.reviewPlot && !snapshot.approval.sceneId) {
      for (const event of this.events.filter(e => e.editorial_status === 'accepted' && e.source_document_id === doc.id &&
          e.source_hash !== job.sourceHash && isRecordedEvent(e) && !e.facts.some(f => matchedOld.has(f.id)))) {
        chapterItems.push({ id: uid('chapter-review'), eventId: event.id, eventRevision: event.revision, jobId,
          kind: 'withdraw_event', revision: 0, status: 'pending', title: event.title, evidence: event.editorial_evidence, created_at: stamp() });
      }
    }
    const retiringEvents = new Set(chapterItems.filter(item => item.kind === 'withdraw_event').map(item => item.eventId));
    for (const old of oldFacts.filter(f => !matchedOld.has(f.id) && !retiringEvents.has(f.eventId))) {
      if (next.proposals.some(p => p.operation === 'withdraw' && p.fact.id === old.id && p.status === 'pending')) continue;
      pending++; next.proposals.push({ id: uid('proposal'), eventId: old.eventId, jobId, fact: { ...copy(old), review_reasons: ['旧稿事实在新版本中尚未找到对应依据，请决定是否撤回'] }, operation: 'withdraw', status: 'pending', created_at: stamp() });
    }
    if (job.reviewPlot) {
      next.chapterReviews = [...(next.chapterReviews || []), ...chapterItems];
      pending += chapterItems.length;
    } else {
      const merged = [...this.events, ...events.filter(e => e.facts.length)];
      changes.push(...await this.projectionChanges(acceptedIds, merged, snapshot.sourceHeads));
    }
    const nj = next.jobs.find(j => j.id === jobId); nj.status = pending ? 'partial' : 'completed'; nj.applied = applied; nj.pending = pending; nj.completed_at = stamp(); nj.error = null;
    await this.commit(job.reviewPlot ? '生成章节待核对资料' : '归档已确认剧情', changes, next);
    this.notify({ type: 'job', job: this.project.jobs.find(j => j.id === jobId) });
  },
  async projectionChanges(characterIds, events, sourceHeads = null, { skipOriginals = false } = {}) {
    const changes = []; const superseded = new Set(events.filter(isRecordedEvent).flatMap(e => e.facts || []).filter(f => f.status === 'accepted').map(f => f.supersedes_fact_id).filter(Boolean));
    for (const id of characterIds) {
      const c = this.character(id);
      const related = events.filter(e => !e.superseded && !e.withdrawn && !e.damaged && !e.unreviewedExternal && !e.uncommitted).map(e => ({ ...e, facts: e.facts.filter(f => f.entity_id === id && f.status === 'accepted' && !superseded.has(f.id)) })).filter(e => e.facts.length).sort((a, b) => (a.source_chapter || 0) - (b.source_chapter || 0));
      const content = `# ${c.name} · 程序归档进展\n\n> 本节由已确认事件生成。初始基座与原作者手写段落独立保留。\n\n${related.map(e => `## ${e.source_chapter ? `第${e.source_chapter}章 · ` : ''}${e.title}${e.stale ? '〔源稿修订待核对〕' : ''}\n\n${e.facts.map(f => `- 【${({ occurred: '已发生', plan: '计划', belief: '人物认知', baseline: '基座', ruling: '作者裁定' })[f.layer]}】${FIELD_LABELS[f.field] || f.field}：${safeLine(textValue(f.value))}\n  - 依据：${safeLine(f.evidence || '作者裁定')}\n  - 事件：${e.id}；事实：${f.id}`).join('\n')}`).join('\n\n') || '尚无已确认变化。'}`;
      const p = `_创作管理/人物进展/${id}.md`, old = await this.store.read(p);
      if (!this.project.protectedFiles?.[p]) changes.push({ path: p, expectedHash: old ? hash(old) : null, text: content });
      const doc = this.documents.find(d => d.id === c.primarySourceId);
      if (doc && !doc.readOnly && !skipOriginals) {
        const current = await this.snapshotDocument(doc);
        if (sourceHeads && sourceHeads[doc.id] !== current.hash) throw new AppError('CONFLICT', '人物文件已变化，停止写回');
        if (this.project.externalChanges[doc.id]) throw new AppError('CONFLICT', '人物档存在外部修改，需先核对');
        changes.push({ path: doc.path, expectedHash: current.hash, bytes: encode(managedBlock(current.text, `progress-${id}`, `## 程序归档 · 已确认变化\n\n${content.replace(/^# .+\n/, '')}`), current) });
      }
    }
    const active = events.filter(isRecordedEvent);
    const ep = '_创作管理/事件索引.md', b = await this.store.read(ep);
    if (active.length || b) {
      const global = this.documents.find(d => d.kind === 'plot' && !d.readOnly);
      const summary = `## 程序归档 · 事件索引\n\n| 章 | 事件 | 时间 | 事件ID |\n|---|---|---|---|\n${active.sort((a, b) => (a.source_chapter || 0) - (b.source_chapter || 0)).map(e => `| ${e.source_chapter ?? '待定'} | ${safeLine(e.title)} | ${safeLine(e.story_time || '待定')} | ${e.id} |`).join('\n')}`;
      if (global && !this.project.externalChanges[global.id]) {
        const d = await this.snapshotDocument(global);
        if (!sourceHeads || sourceHeads[global.id] === d.hash) changes.push({ path: d.path, expectedHash: d.hash, bytes: encode(managedBlock(d.text, 'global-events', summary), d) });
      }
      if (!this.project.protectedFiles?.[ep]) changes.push({ path: ep, expectedHash: b ? hash(b) : null, text: summary });
    }
    const rels = active.flatMap(e => e.facts.filter(f => f.status === 'accepted' && f.field === 'relationship' && !superseded.has(f.id)).map(f => ({ ...f, event: e.title })));
    const rp = '_创作管理/关系/关系索引.md', rb = await this.store.read(rp);
    if (!this.project.protectedFiles?.[rp]) changes.push({ path: rp, expectedHash: rb ? hash(rb) : null, text: `# 关系索引\n\n${rels.map(f => `- ${this.project.characters.find(c => c.id === f.entity_id)?.name || f.entity_id} → ${this.project.characters.find(c => c.id === f.value.otherId)?.name || f.value.otherId}：${safeLine(textValue(f.value))}（${f.event}，${f.id}）`).join('\n') || '尚无确认关系。'}` });
    return changes;
  },
  async resolveProposal({ proposalId, resolution, value, entityId, expectedSourceHash, evidenceQuote, reconsider = false, expectedRevision }) {
    const proposal = this.project.proposals.find(p => p.id === proposalId); if (!proposal) throw new AppError('NOT_FOUND', '核对项不存在');
    await assertReviewCurrent(this, proposal);
    if (proposal.status !== 'pending' && !(reconsider && ['accepted','rejected'].includes(proposal.status))) throw new AppError('NOT_FOUND', '此项已处理或已撤回，请刷新记录');
    if ((reconsider || expectedRevision !== undefined) && expectedRevision !== (proposal.revision || 0)) throw new AppError('CONFLICT', '此项已被再次处理，请重新打开最新记录');
    if (reconsider && proposal.operation === 'withdraw' && proposal.status === 'accepted') throw new AppError('VALIDATION', '已撤回的旧事实不能直接恢复为新版事实；请使用更正当前档案');
    if (reconsider && proposal.fact.status === 'baseline_recorded' && !['accept','edit'].includes(resolution)) throw new AppError('VALIDATION', '已写入的基座请明确填写修正值，不能仅改变核对状态');
    if (!['accept', 'reject', 'belief', 'plan', 'edit'].includes(resolution)) throw new AppError('VALIDATION', '处理方式无效');
    if (resolution !== 'reject' && this.project.chapterReviews?.some(row => row.kind === 'event' && row.eventId === proposal.eventId && row.status === 'pending')) {
      throw new AppError('VALIDATION', '请先在剧情总览核对关联事件');
    }
    const next = copy(this.project); const p = next.proposals.find(p => p.id === proposalId);
    const beforeReview = { status: p.status, resolution: p.resolution || null, resolved_at: p.resolved_at || null, fact: copy(p.fact) }; if (p.status === 'pending') p.originalFact ||= copy(p.fact);
    if (resolution === 'reject') {
      p.status = 'rejected'; p.resolution = 'reject'; p.resolved_at = stamp();const changes=[];
      const original=this.events.find(e=>e.id===p.eventId);let revised;
      if(original){revised=copy(original);const fact=revised.facts.find(f=>f.id===p.fact.id),wasAccepted=fact?.status==='accepted';if(fact&&p.operation!=='withdraw')fact.status='rejected';if(fact)p.fact=copy(fact);revised.evidence_review_required=revised.facts.some(f=>f.status==='pending'&&f.evidence_match?.status!=='matched');revised.revision++;const ep=`_创作管理/事件/${revised.id}.md`,b=await this.store.read(ep);changes.push({path:ep,expectedHash:hash(b),text:this.eventMarkdown(revised,decode(b).text)});if(wasAccepted&&p.operation!=='withdraw')changes.push(...await this.projectionChanges(new Set([fact.entity_id]),this.events.map(e=>e.id===revised.id?revised:e)));}
      const job=next.jobs.find(j=>j.id===p.jobId);if(job){job.pending=next.proposals.filter(p=>p.jobId===job.id&&p.status==='pending').length;job.evidenceSummary=evidenceSummary(this.events.map(e=>e.id===p.eventId&&revised?revised:e).filter(e=>e.approval_id===job.approvalId));if(!job.pending)job.status='completed';}
      recordDecision(p, beforeReview, reconsider ? 'reconsider_reject' : 'reject');
      return this.commit('保留现有资料，拒绝归档建议',changes,next);
    }
    const original = this.events.find(e => e.id === proposal.eventId); if (!original) throw new AppError('NOT_FOUND', '对应事件文件不存在');
    const event = copy(original); const fact = event.facts.find(f => f.id === proposal.fact.id); if (!fact) throw new AppError('NOT_FOUND', '对应事实不存在');
    if (entityId) fact.entity_id = this.character(entityId).id;
    this.character(fact.entity_id);
    if (proposal.operation !== 'withdraw' && fact.source_document_id) {
      const d = this.doc(fact.source_document_id);
      if(!fact.confirmed_range){const approval=this.project.approvals.find(a=>a.id===event.approval_id);if(approval&&Number.isInteger(approval.start)&&Number.isInteger(approval.end))fact.confirmed_range={start:approval.start,end:approval.end};}
      Object.assign(fact,await verifyFactEvidence(this.store,d,fact,evidenceQuote));
    }
    if (resolution === 'edit') { if (value === undefined || value === null) throw new AppError('VALIDATION', '请填写修正值'); fact.value = value; }
    if (resolution === 'belief') fact.layer = 'belief'; if (resolution === 'plan') fact.layer = 'plan';
    if (fact.layer === 'occurred' && ['plan', 'belief'].includes(event.editorial_layer)) fact.layer = event.editorial_layer;
    if (fact.field === 'relationship' && proposal.operation !== 'withdraw') {
      if (!fact.value?.otherId || fact.value.otherId === fact.entity_id) throw new AppError('VALIDATION', '请选择有效的另一名人物');
      this.character(fact.value.otherId);
    }
    if (!['belief', 'plan'].includes(fact.layer) && (fact.layer === 'baseline' || fact.field.startsWith('base.')) && proposal.operation !== 'withdraw') {
      const c = this.character(fact.entity_id); const d = this.documents.find(d => d.id === c.primarySourceId); const fields = copy(this.baselines[c.id]?.fields || []);
      const field = fact.field.replace(/^base\./, ''); const old = fields.find(f => f.field === field);
      if (old) {old.value = textValue(fact.value);old.evidence=fact.evidence;} else fields.push({ field, value: textValue(fact.value), evidence: fact.evidence });
      return this.approveBaseline({ characterId: c.id, fields, expectedSourceHash: expectedSourceHash || d?.hash, proposalId, proposalEvidence:fact.evidence, reconsider });
    }
    fact.status = proposal.operation === 'withdraw' ? 'withdrawn' : 'accepted'; fact.author_reviewed_at = stamp(); fact.review_reasons = [];
    p.fact=copy(fact);event.evidence_review_required=event.facts.some(f=>f.status==='pending'&&f.evidence_match?.status!=='matched');
    event.revision++; event.updated_at = stamp();
    const doc = this.documents.find(d => d.id === this.character(fact.entity_id).primarySourceId);
    if (doc && this.project.externalChanges[doc.id]) {
      const b = await this.store.read(doc.path);
      if (expectedSourceHash !== hash(b)) throw new AppError('CONFLICT', '人物档存在外部修改，请先打开原档核对后再接受');
      delete next.externalChanges[doc.id];
    }
    p.status = 'accepted'; p.resolved_at = stamp(); p.resolution = resolution;
    recordDecision(p, beforeReview, reconsider ? `reconsider_${resolution}` : resolution);
    const job = next.jobs.find(j => j.id === p.jobId); if (job) { job.pending = next.proposals.filter(p => p.jobId === job.id && p.status === 'pending').length;job.evidenceSummary=evidenceSummary(this.events.map(e=>e.id===event.id?event:e).filter(e=>e.approval_id===job.approvalId)); if (!job.pending) job.status = 'completed'; }
    const ep = `_创作管理/事件/${event.id}.md`, before = await this.store.read(ep);
    const merged = this.events.map(e => e.id === event.id ? event : e);
    const oldExternal = this.project.externalChanges; this.project.externalChanges = next.externalChanges;
    let projections;
    try { projections = await this.projectionChanges(new Set([fact.entity_id, original.facts.find(f => f.id === fact.id)?.entity_id].filter(Boolean)), merged); } finally { this.project.externalChanges = oldExternal; }
    return this.commit('作者处理归档建议', [{ path: ep, expectedHash: hash(before), text: this.eventMarkdown(event, decode(before).text) }, ...projections], next);
  },
  async proposalEvidence({ proposalId }) {
    const p=this.project.proposals.find(p=>p.id===proposalId&&p.status==='pending');if(!p)throw new AppError('NOT_FOUND','待核对项不存在或已处理');
    await assertReviewCurrent(this, p);
    const d=await this.snapshotDocument(this.doc(p.fact.source_document_id));if(d.hash!==p.fact.source_hash)throw new AppError('CONFLICT','证据源稿已修改，请先确认新版本后重新分析');
    const e=this.events.find(e=>e.id===p.eventId),a=this.project.approvals.find(a=>a.id===e?.approval_id);
    const range=p.fact.confirmed_range||(a&&Number.isInteger(a.start)?{start:a.start,end:a.end}:{start:0,end:d.text.length});
    return {documentId:d.id,title:d.title,sourceHash:d.hash,range,text:d.text.slice(range.start,range.end),spans:sourceSpans(d.text.slice(range.start,range.end),range.start)};
  },
  async updateField({ entityId, field, value, chapter = null, layer = 'ruling', expectedRevision, reviewOrigin = null }) {
    const c = this.character(entityId);
    if (expectedRevision !== undefined && c.revision !== expectedRevision) throw new AppError('CONFLICT', '人物资料版本已变化');
    if (typeof field !== 'string' || !field || field.length > 100 || value === undefined || value === null || JSON.stringify(value).length > 10000) throw new AppError('VALIDATION', '字段或内容无效');
    if (field.startsWith('base.') && !['belief','plan'].includes(layer)) throw new AppError('VALIDATION', '请通过基座页修改初始设定');
    if (field === 'relationship') { if (!value.otherId || value.otherId === entityId) throw new AppError('VALIDATION', '请选择另一名人物'); this.character(value.otherId); }
    if (chapter !== null && (!Number.isInteger(chapter) || chapter < 1)) throw new AppError('VALIDATION', '生效章序无效');
    const fact = { id: uid('fact'), entity_id: entityId, field, value, layer: ['plan', 'belief'].includes(layer) ? layer : 'ruling', source_document_id: null, source_hash: null, source_chapter: chapter, latest_only: chapter === null, evidence: '作者在程序中手动裁定', status: 'accepted', start: 0, review_reasons: [] };
    const supersededId = reviewOrigin?.currentFactId || reviewOrigin?.factId;
    if (supersededId && this.events.some(e => e.facts.some(f => f.id === supersededId && f.entity_id === entityId && f.field === field && f.status === 'accepted'))) fact.supersedes_fact_id = supersededId;
    const event = { id: uid('event'), work_id: this.project.id, title: `作者修正：${c.name} · ${FIELD_LABELS[field] || field}`, summary: textValue(value), story_time: '', source_document_id: null, source_hash: null, source_chapter: chapter, approval_id: uid('approval'), facts: [fact], revision: 1, created_at: stamp() };
    const next = copy(this.project); next.approvals.push({ id: event.approval_id, kind: 'ruling', author: '作者', confirmed_at: stamp(), status: 'active' });
    if (reviewOrigin) { event.review_origin = copy(reviewOrigin); next.reviewAudit ||= []; next.reviewAudit.push({ id: uid('review'), ...copy(reviewOrigin), action: 'correct_current', at: stamp(), after: copy(value), eventId: event.id, factId: fact.id }); }
    const nc = next.characters.find(c => c.id === entityId); nc.revision++;
    next.locks = next.locks.filter(l => !(l.entityId === entityId && l.field === field)); next.locks.push({ id: uid('lock'), entityId, field, active: true, reason: '作者手动编辑', created_at: stamp() });
    const changes = [{ path: `_创作管理/事件/${event.id}.md`, expectedHash: null, text: this.eventMarkdown(event) }, ...await this.projectionChanges(new Set([entityId]), [...this.events, event])];
    return this.commit('作者修正人物当前状态', changes, next);
  },
  async acknowledgeExternal({ documentId, expectedHash }) {
    const d = await this.snapshotDocument(this.doc(documentId)); if (d.hash !== expectedHash) throw new AppError('CONFLICT', '文件又发生了变化，请刷新');
    const next = copy(this.project); delete next.externalChanges[documentId];
    // Protect every currently known field sourced from this card until the author unlocks it.
    for (const c of next.characters.filter(c => c.primarySourceId === documentId)) {
      const fields = new Set(this.visibleFacts().filter(f => f.entity_id === c.id).map(f => f.field));
      for (const field of fields) if (!next.locks.some(l => l.entityId === c.id && l.field === field)) next.locks.push({ id: uid('lock'), entityId: c.id, field, active: true, reason: '外部人工修改已保留', created_at: stamp() });
    }
    return this.commit('核对并保留外部文件修改', [], next);
  }
};
