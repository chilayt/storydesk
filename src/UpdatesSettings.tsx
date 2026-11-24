import { ProposalReview } from './ProposalReview';
import { CurrentArchiveJobs, PendingReviews, ReviewHistoryPanel, ArchiveVersions, inChapter } from './ReviewRecords';
import {ProviderDiagnostic} from './ProviderDiagnostic';
import { EvidenceRepair } from './EvidenceRepair';
import { JobDiagnostic } from './JobDiagnostic';
import React, { useEffect, useState } from 'react';
import type { AppContext, Proposal, CommitBatch } from './domain';
import { dateText, fieldLabels, layerLabels, statusLabels, valueText, kindLabels } from './domain';
import { Icon, Badge, Empty, Modal, Evidence } from './components';
import { humanValue } from './domain';
import { RecoveryPanel } from './RecoveryPanel';
import { RevisionPanel } from './RevisionPanel';
import { ManagedReview } from './ManagedReview';
import { SourceChanges } from './SourceChanges';

export function Updates({ctx,initialTab}:{ctx:AppContext;initialTab?:string}){
  const [chapter,setChapter]=useState(''),[recordVersion,setRecordVersion]=useState(''),[includeObsolete,setIncludeObsolete]=useState(false),[reconsider,setReconsider]=useState(false);
  const [revisionReview,setRevisionReview]=useState<any>(null);
  const [managedPath,setManagedPath]=useState<string|null>(null);
  const [recovery,setRecovery]=useState<any>(null);const [tab,setTab]=useState(initialTab||'jobs');const [review,setReview]=useState<Proposal|null>(null);const [history,setHistory]=useState<CommitBatch[]>([]);const [report,setReport]=useState<any>(null);const [undo,setUndo]=useState<CommitBatch|null>(null);
  useEffect(()=>{if(tab==='history')ctx.call('history').then(setHistory).catch(e=>ctx.notify(e.message,true));},[tab,ctx.work]);
  const pending=ctx.work.proposals.filter(p=>p.status==='pending'&&inChapter(ctx,ctx.work.jobs.find(j=>j.id===p.jobId)?.documentId||p.fact.source_document_id,chapter));
  const tabs=[['jobs','归档任务'],['proposals',`待核对 ${pending.length||''}`],['reviewed','已处理记录'],['archive','章节归档历史'],['external',`外部修改 ${ctx.work.stats.external||''}`],['checks','门禁历史报告'],['revisions','AI修订建议'],['wording','用词裁定'],['history','版本与恢复']];
  return <div className="content-page"><div className="page-heading"><div><span className="eyebrow">REVIEW & HISTORY</span><h1>更新与核对</h1><p>自动写回有记录，待定事项由你裁定。</p></div><button onClick={()=>ctx.act(()=>ctx.call('refresh'),'本地状态已刷新')}><Icon name="refresh"/>刷新</button></div>{!!ctx.work.recovery?.length&&<div className="notice danger">存在未完成写入。<button onClick={()=>ctx.act(()=>ctx.call('recover'),'恢复检查已完成')}>检查并恢复</button>{ctx.work.recovery.map(r=><button key={r.id} onClick={()=>setRecovery(r)}>比较并处理：{r.label}</button>)}<p>如果文件已经出现第三个版本，程序会保留现场。请先比较历史快照与当前文件，再重试恢复。</p></div>}
    <div className="tabs archive-tabs">
      {tabs.slice(0, 3).map(([key, label]) => <button key={key} className={key === tab ? 'active' : ''} aria-pressed={key === tab}
        onClick={() => { setTab(key); if (key === 'reviewed') { setRecordVersion(''); setIncludeObsolete(false); } }}>{label.trim()}</button>)}
      <label className="archive-record-selector"><select aria-label="更多记录" value={tabs.slice(3).some(([key]) => key === tab) ? tab : ''}
        onChange={e => { if (e.target.value) setTab(e.target.value); }}>
        <option value="">更多记录</option>
        {tabs.slice(3).map(([key, label]) => <option key={key} value={key}>{label.trim()}</option>)}
      </select></label>
    </div>
    {['jobs','proposals','reviewed','archive'].includes(tab)&&<div className="review-chapter-filter panel"><label>查看范围<select aria-label="核对章节" value={chapter} onChange={e=>{setChapter(e.target.value);setRecordVersion('');setIncludeObsolete(false);}}><option value="">全部章节</option>{ctx.work.documents.filter(d=>['chapter','draft'].includes(d.kind)).sort((a,b)=>(a.chapter||Infinity)-(b.chapter||Infinity)).map(d=><option key={d.id} value={d.id}>{d.title}</option>)}<option value="__other__">其他资料</option></select></label><p>切换章节只筛选列表。当前任务与历史记录按确认版本保留。</p></div>}
    {tab==='jobs'&&<CurrentArchiveJobs ctx={ctx} chapter={chapter} onProposals={id=>{
      if (ctx.work.jobs.some(job => job.documentId === id && job.reviewPlot && job.sourceHash === ctx.work.documents.find(d => d.id === id)?.hash)) {
        ctx.navigate({ page: 'plot', tab: 'review', documentId: id });
      } else { setChapter(id); setTab('proposals'); }
    }} onHistory={()=>setTab('archive')}/>}
    {tab==='proposals'&&<PendingReviews ctx={ctx} chapter={chapter} onOpen={p=>{setReconsider(false);setReview(p);}}/>}
    {tab==='reviewed'&&<ReviewHistoryPanel ctx={ctx} chapter={chapter} version={recordVersion} onVersion={setRecordVersion} includeObsolete={includeObsolete} onReconsider={p=>{setReconsider(true);setReview(p);}}/>}
    {tab==='archive'&&<ArchiveVersions ctx={ctx} chapter={chapter} onRecords={(id,version)=>{setChapter(id);setRecordVersion(version);setIncludeObsolete(true);setTab('reviewed');}} onPending={id=>{setChapter(id);setTab('proposals');}}/>}
    {tab==='external'&&<SourceChanges ctx={ctx} onManaged={setManagedPath}/>}
    {tab==='checks'&&(ctx.work.checks.length?<div>{ctx.work.checks.slice().reverse().map(c=><button key={c.id} className="check-card panel" onClick={()=>setReport(c)}><Icon name="shield"/><span><strong>{ctx.work.documents.find(d=>d.id===c.documentId)?.title||'稿件'}</strong><small>{dateText(c.checked_at)} · 绑定检查时的稿件版本</small></span><Badge status={c.status}/><Icon name="chevron" size={16}/></button>)}</div>:<Empty title="还没有检查报告" detail="稿件核对与发布时的机检报告会保留在这里。"/>)}
    {tab==='revisions'&&<>{(ctx.work.revisionTasks||[]).length?(ctx.work.revisionTasks||[]).slice().reverse().map((r:any)=><section className="panel" key={r.id}><div className="panel-heading"><h3>{ctx.work.documents.find(d=>d.id===r.documentId)?.title||'源稿已移除'}</h3><Badge>{r.status==='applied'?'已应用':'待作者审核'}</Badge></div><p>{dateText(r.created_at)} · 建议不会自动确认成稿</p><button onClick={async()=>{const d=await ctx.call('readDocument',{documentId:r.documentId});setRevisionReview({id:r.id,document:d});}}>打开建议与手动编辑</button></section>):<Empty title="还没有修订建议" detail="可从稿件核对生成修订建议，或在创作空间查看候选稿。"/>}</>}
    {tab==='wording'&&<><div className="notice">这里显示作者对用词提醒的裁定。放行按本版、本章或全作品生效；撤销后恢复提醒。正式裁定已写入本作品设定文档。</div>{(ctx.work.wordingDecisions||[]).length?(ctx.work.wordingDecisions||[]).slice().reverse().map((r:any)=><section className="panel" key={r.id}><div className="panel-heading"><h3>{r.term}</h3><Badge>{r.active===false?'已撤销':r.allow?'作者放行':'保留提醒'}</Badge></div><p>{({revision:'本章本次版本全文',document:'本章全文及后续修订',work:'全作品及后续章节'} as Record<string,string>)[r.scope]} · {r.documentPath}</p>{r.usage && <p>适用词义 · {r.usage}</p>}<p>{r.reason||'作者裁定'} · {dateText(r.confirmed_at)}</p>{r.active!==false&&<button onClick={()=>ctx.act(()=>ctx.call('revokeWording',{id:r.id}),'用词裁定已撤销')}>撤销裁定</button>}</section>):<Empty title="尚无作者用词裁定" detail="在稿件核对的用词详情中选择放行范围。"/>}</>}
    {tab==='history'&&<><div className="notice">撤销会核对每个文件的当前版本。存在后续修改时会停止覆盖；已完成批次的快照不会自动清理。</div>{history.map(h=><div className="history-row panel" key={h.id}><div className="history-icon"><Icon name="clock"/></div><div><h3>{h.label}</h3><p>{dateText(h.created_at)} · {h.files.length}个文件</p><details><summary>查看涉及文件</summary>{h.files.map(f=><small className="history-path" key={f.path}>{f.path}</small>)}</details></div><Badge status={h.status}/><button disabled={h.status!=='committed'} onClick={()=>setUndo(h)}>撤销此批次</button></div>)}</>}
    {revisionReview&&<RevisionPanel ctx={ctx} document={revisionReview.document} initialId={revisionReview.id} onClose={()=>setRevisionReview(null)}/>}
    {managedPath&&<ManagedReview ctx={ctx} path={managedPath} onClose={()=>setManagedPath(null)}/>}
    {recovery&&<RecoveryPanel ctx={ctx} record={recovery} onClose={()=>setRecovery(null)}/>}
    {review&&<ProposalReview ctx={ctx} proposal={review} reconsider={reconsider} onClose={()=>setReview(null)}/>}
    {report&&<Modal title="门禁历史报告" subtitle="报告只对检查时的文件版本有效；软线与量化指标由作者裁定。" onClose={()=>setReport(null)} wide><Badge status={report.status}/><pre className="full-report">{report.output.split("\n").filter((l:string)=>!l.startsWith("STORYDESK_GATE_JSON:")).join("\n")}</pre></Modal>}
    {undo&&<Modal title="撤销这次文件修改" subtitle="程序会比较当前文件与本批次的写入后版本，任何不一致都会停止。" onClose={()=>setUndo(null)}><h3>{undo.label}</h3>{undo.files.map(f=><p className="small-text" key={f.path}>{f.path}</p>)}<div className="modal-footer"><button onClick={()=>setUndo(null)}>取消</button><button className="primary" onClick={async()=>{const r=await ctx.act(()=>ctx.call('undo',{id:undo.id}),'批次已撤销并保留反向记录');if(r)setUndo(null);}}>核对版本并撤销</button></div></Modal>}
  </div>;
}

export function Settings({ctx}:{ctx:AppContext}){
  const [name, setName] = useState(ctx.work.name);
  const [era, setEra] = useState(ctx.work.settings.era);
  const [parent, setParent] = useState(ctx.work.settings.parentWork || '');
  const [writingStyle, setWritingStyle] = useState(ctx.work.settings.writingStyle || 'general');
  const [memlayer, setMemlayer] = useState({ enabled: false, baseUrl: 'http://127.0.0.1:8770', sharedProject: '', ...ctx.work.settings.memlayer });
  const [memoryConnection, setMemoryConnection] = useState<{ status: string; available: number; message?: string }>();
  const [checkingMemory, setCheckingMemory] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  async function checkMemory() {
    setCheckingMemory(true); setMemoryError('');
    try { setMemoryConnection(await ctx.call('memlayerStatus')); }
    catch (error) { setMemoryError((error as Error).message); }
    finally { setCheckingMemory(false); }
  }
  const savedMemory = ctx.work.settings.memlayer;
  useEffect(() => {
    setMemoryConnection(undefined);
    if (savedMemory?.enabled) void checkMemory();
  }, [savedMemory?.enabled, savedMemory?.baseUrl, savedMemory?.sharedProject]);
  const [ai, setAi] = useState({ ...ctx.work.settings.ai });
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [gate, setGate] = useState({ ...ctx.work.settings.gate });
  const [sources, setSources] = useState<any[]>((ctx.work as any).sources || []);
  const [testing, setTesting] = useState(false);
  const [modelTest, setModelTest] = useState<any>(ctx.work.modelTest || null);
  const address = (ai.baseUrl || '').trim();
  const workId = ctx.work.id;
  useEffect(() => {
    let live = true;
    setHasKey(false);
    ctx.call('keyStatus', { baseUrl: address }).then(status => {
      if (live) setHasKey(status.configured);
    }).catch(() => {});
    return () => { live = false; };
  }, [workId, address]);

  async function save() {
    return ctx.act(async () => {
      if (ai.enabled && !address) throw new Error('请填写模型服务地址');
      const result = await ctx.call('updateSettings', { name, era, parentWork: parent,
        ai: { ...ai, baseUrl: address, model: (ai.model || '').trim() },
        gate, sources, writingStyle, memlayer, ...(address && ai.model ? { writingModel: 'analysis' } : {}) });
      if (address && key.trim()) {
        await ctx.call('setKey', { key: key.trim(), baseUrl: address });
        setKey('');
        setHasKey(true);
      }
      return result;
    }, '作品设置已保存');
  }

  async function testConnection() {
    setTesting(true);
    try {
      if (!await save()) return;
      try { setModelTest(await ctx.call('testModel', { connection: true })); }
      catch (error) {
        setModelTest((await ctx.call('summary')).modelTest);
        ctx.notify((error as Error).message, true);
      }
    } finally { setTesting(false); }
  }

  return <div className="content-page settings-page"><div className="page-heading"><div><h1>作品设置</h1><p>连接、资料路径和检查规则按作品保存。</p></div><button className="primary" onClick={save}><Icon name="save"/>保存设置</button></div><section className="panel"><div className="panel-heading"><h3>作品信息</h3><Badge>本地优先</Badge></div><div className="form-grid"><label>作品名称<input value={name} onChange={e=>setName(e.target.value)}/></label><label>时代与架空前提<input value={era} onChange={e=>setEra(e.target.value)}/></label></div><label>所属主作品 / 关联说明<input value={parent} onChange={e=>setParent(e.target.value)} placeholder="可留空，不会隐式混入其他作品资料"/></label><div className="setting-path"><Icon name="folder" size={16}/>{ctx.work.root}</div></section>
    <section className="panel">
      <div className="panel-heading"><h3>模型连接</h3></div>
      <div className="form-grid connection-fields">
        <label>服务地址<input value={ai.baseUrl || ''} placeholder="https://api.deepseek.com 或本机兼容地址"
          onChange={e => { setKey(''); setAi({ ...ai, baseUrl: e.target.value, modelList: [] }); }}/></label>
        <label>模型名<input aria-label="模型名" aria-describedby="model-id-help" value={ai.model || ''} placeholder="填写服务商提供的模型 ID"
          onChange={e => setAi({ ...ai, model: e.target.value })}/><small id="model-id-help">支持模型列表的服务也可从对话框拉取。</small></label>
        <label>API 密钥<input aria-label="API 密钥" aria-describedby="model-key-help" type="password" placeholder={hasKey ? '已保存，可输入新密钥' : '服务需要密钥时填写'}
          autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)}/><small id="model-key-help">经系统加密，按作品和服务地址保存。</small></label>
      </div>
      <label className="check-label"><input type="checkbox" checked={!!ai.enabled}
        onChange={e => setAi({ ...ai, enabled: e.target.checked })}/>启用模型连接</label>
      <p className="muted small-text">云端和本机共用这个入口。使用 OpenAI 兼容接口，云端填写 HTTPS，本机可用 HTTP。测试会向所填服务发送一次测试请求。</p>
      <div className="actions">
        <button disabled={testing || !ai.enabled || !address} onClick={testConnection}>
          <Icon name="key"/>{testing ? '正在测试…' : '保存并测试连接'}
        </button>
        {hasKey && <button disabled={testing} onClick={() => ctx.act(async () => {
          await ctx.call('setKey', { key: '', baseUrl: address }); setKey(''); setHasKey(false); return true;
        }, '已移除此地址的密钥')}>清除密钥</button>}
      </div>
      <ProviderDiagnostic test={modelTest} model={ai.model || modelTest?.model || ''} baseUrl={address}/>
      <details>
        <summary>归档与核对用量</summary>
        <div className="form-grid">
          <label>每任务 Token 上限<input type="number" min="1000" value={ai.maxTokensPerJob} onChange={e => setAi({ ...ai, maxTokensPerJob: Number(e.target.value) })}/></label>
          <label>每日 Token 上限<input type="number" min="1000" value={ai.dailyTokenLimit} onChange={e => setAi({ ...ai, dailyTokenLimit: Number(e.target.value) })}/></label>
          <label>单次输出上限<input type="number" min="256" max="131072" value={ai.maxOutputTokens} onChange={e => setAi({ ...ai, maxOutputTokens: Number(e.target.value) })}/>
            <small className="muted">创作对话按模型服务的设置运行。这里用于归档与稿件核对等后台任务。</small></label>
        </div>
      </details>
    </section>
    <section className="panel"><h3>稿件检查</h3><p className="muted">开源版使用内置稿件检查。导入的外部门禁脚本保留在作品目录，由作者在自己的终端中运行。</p></section>
    <section className="panel"><div className="panel-heading"><h3>登记的资料位置</h3><button onClick={()=>setSources([...sources,{path:'资料',kind:'reference',depth:0}])}><Icon name="plus"/>增加路径</button></div><p className="muted">只读取明确登记的路径；不递归扫描备份与旧版目录。深度0表示只读取该目录直接包含的文件。</p><div className="source-config"><div className="source-config-head"><span>相对作品路径</span><span>资料类型</span><span>子目录深度</span><span/></div>{sources.map((s,i)=><div className="source-config-row" key={i}><input value={s.path} onChange={e=>setSources(r=>r.map((v,j)=>j===i?{...v,path:e.target.value}:v))}/><select value={s.kind} onChange={e=>setSources(r=>r.map((v,j)=>j===i?{...v,kind:e.target.value}:v))}>{Object.entries(kindLabels).filter(([k])=>!['event','memory'].includes(k)).map(([k,l])=><option value={k} key={k}>{l}</option>)}</select><input type="number" min="0" max="3" value={s.depth} onChange={e=>setSources(r=>r.map((v,j)=>j===i?{...v,depth:Number(e.target.value)}:v))}/>{s.readOnly && <small>只读</small>}<button className="icon-button" aria-label="移除资料路径" onClick={()=>setSources(r=>r.filter((_,j)=>j!==i))}><Icon name="close" size={15}/></button></div>)}</div></section>
    <section className="panel">
      <div className="panel-heading"><h3>创作与通用记忆</h3></div>
      <label>写作风格<select value={writingStyle} onChange={e => setWritingStyle(e.target.value)}>
        <option value="general">沿用本书规则</option><option value="historical">古风</option><option value="modern">现代</option>
      </select></label>
      <label className="check-label"><input type="checkbox" checked={memlayer.enabled} onChange={e => setMemlayer({ ...memlayer, enabled: e.target.checked })}/>从 MemLayer 召回已确认记忆</label>
      <p className="muted small-text">完整聊天保存在作品的「共写」记录中。这个开关只控制 Agent 从 MemLayer 读取记忆。</p>
      {memlayer.enabled && <div className="form-grid">
        <label>本机服务地址<input value={memlayer.baseUrl} onChange={e => setMemlayer({ ...memlayer, baseUrl: e.target.value })}/></label>
        <label>作者共享记忆（可选）<input value={memlayer.sharedProject} placeholder="shared_author" onChange={e => setMemlayer({ ...memlayer, sharedProject: e.target.value })}/></label>
      </div>}
      {memlayer.enabled && <div className="studio-actions">
        <button disabled={checkingMemory || !savedMemory?.enabled || savedMemory.baseUrl !== memlayer.baseUrl ||
          savedMemory.sharedProject !== memlayer.sharedProject} onClick={() => void checkMemory()}>{checkingMemory ? '连接检查中…' : '检测连接'}</button>
        <span role="status">{memoryError || (!savedMemory?.enabled || savedMemory.baseUrl !== memlayer.baseUrl ||
          savedMemory.sharedProject !== memlayer.sharedProject ? '保存设置后可检查' : memoryConnection?.status === 'ready' ?
            `已连接 · 当前范围可读取 ${memoryConnection.available} 条` : memoryConnection?.status === 'empty' ?
              '已连接 · 当前范围有 0 条已确认记忆' : memoryConnection?.status === 'partial' ?
                '已连接 · 部分已选记忆范围不可用' : memoryConnection?.status === 'unavailable' ? (memoryConnection.message || '本机服务未连通') : '')}</span>
      </div>}
      {memlayer.enabled && <p className="muted small-text">本作品记忆键为 {ctx.work.id}。每次发送讨论后可在「本次依据 → 上轮实际」查看读到的记忆。</p>}
    </section>
    <section className="panel"><div className="panel-heading"><h3>版本与迁移</h3><Icon name="shield"/></div><p>正式内容保存在Markdown和本地管理记录中。每次批次保留前后快照，已有版本不会自动清理；当前版本恢复可在更新中心操作。</p><button onClick={()=>ctx.act(()=>ctx.call('export'),'资料包已导出')}><Icon name="download"/>导出作品资料包</button><small className="setting-note">导出包括文档、事件和管理记录；密钥不导出。图纸保留来源路径，请随作品文件夹一并备份。</small></section>
  </div>;
}
