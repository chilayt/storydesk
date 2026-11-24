import React, { useEffect, useState } from 'react';
import type { AppContext } from './domain';
import { dateText } from './domain';
import { Badge, Empty, Icon } from './components';
import { MemoryEditor, memoryKinds, memoryStates, memoryScope } from './MemoryEditor';
import { MemoryTrace } from './MemoryTrace';
import { ManagedReview } from './ManagedReview';

export default function MemoryCenter({ ctx, initialQuery = '' }: { ctx: AppContext; initialQuery?: string }) {
  const focusedCandidate = initialQuery.startsWith('candidate:') ? initialQuery.slice('candidate:'.length) : '';
  const memoryQuery = focusedCandidate ? '' : initialQuery;
  const [tab, setTab] = useState(focusedCandidate ? 'shared' : 'memories');
  const [filter, setFilter] = useState(memoryQuery ? 'all' : 'active'), [query, setQuery] = useState(memoryQuery);
  const [shared, setShared] = useState<any>(null), [sharedScope, setSharedScope] = useState('work');
  const [sharedBusy, setSharedBusy] = useState(false), [sharedError, setSharedError] = useState('');
  const [sharedEdit, setSharedEdit] = useState<{ id: string; text: string } | null>(null);
  const [replacement, setReplacement] = useState<{
    id: string; query: string; options: { id: string; text: string }[]; target: string; total: number;
  } | null>(null);
  const [rejection, setRejection] = useState<{ id: string; reason: string } | null>(null);
  const [sharedSearch, setSharedSearch] = useState('');
  const [sharedFilter, setSharedFilter] = useState('');
  const [editing, setEditing] = useState<any>(null), [reviewPath, setReviewPath] = useState(''), [preview, setPreview] = useState<any>(null);
  const [obCardId,setObCardId]=useState('');
  const [docId, setDocId] = useState(ctx.work.documents.find(d => d.kind === 'chapter')?.id || ''), [task, setTask] = useState('revision');
  const memories = ctx.work.memories || [], runs = ctx.work.memoryRuns || [];
  const visible = memories.filter(m => (filter === 'all' || filter === 'active' && ['candidate', 'confirmed'].includes(m.status) || m.status === filter) && `${m.title} ${m.content} ${m.source?.reference}`.includes(query));
  const onceUsed = (id: string) => !!memories.find(m=>m.id===id)?.consumedBy;
  async function loadShared(scope = sharedScope, offset = shared?.offset ?? 0, search = sharedFilter) {
    setSharedBusy(true); setSharedError('');
    try {
      let page = await ctx.call('memlayerMemory', { scope, offset, search });
      if (offset > 0 && offset >= page.total) {
        const lastOffset = Math.floor(Math.max(0, page.total - 1) / page.limit) * page.limit;
        page = await ctx.call('memlayerMemory', { scope, offset: lastOffset, search });
      }
      setShared(page);
    } catch (error: any) {
      setSharedError(error?.message || '共享记忆暂不可用');
      setShared(null);
    } finally { setSharedBusy(false); }
  }
  useEffect(() => {
    if (focusedCandidate) void loadShared('work', 0, '');
  }, [focusedCandidate]);
  async function openShared() {
    setTab('shared');
    if (!sharedBusy) await loadShared();
  }
  async function reviewShared(item: any, decision: 'approve' | 'reject' | 'approve-replacement' | 'approve-exception', supersedesFactId?: string, reason?: string) {
    setSharedBusy(true); setSharedError('');
    try {
      await ctx.call('memlayerReview', { scope: sharedScope, decision, id: item.id, hash: item.hash, supersedesFactId, reason });
      ctx.notify(decision === 'reject' ? '已拒绝，不会进入记忆' : decision === 'approve-replacement'
        ? '已替换，后续对话会使用新记忆' : decision === 'approve-exception'
          ? '已增加适用例外，其他情况继续沿用原约定' : '已确认，后续对话可以读到这条记忆');
      setSharedEdit(null); setReplacement(null); setRejection(null);
      await loadShared(sharedScope, decision === 'reject' ? shared?.offset : 0);
    } catch (error: any) { setSharedError(error?.message || '核对失败'); }
    finally { setSharedBusy(false); }
  }
  async function findReplacement(item: any, query: string, preselect = false) {
    setSharedBusy(true); setSharedError(''); setRejection(null);
    try {
      const result = await ctx.call('memlayerMemory', { scope: sharedScope, search: query, authorNotesOnly: true });
      const target = preselect ? result.facts.find((fact: any) => fact.id === item.suggestedFactId)?.id || '' : '';
      setReplacement({ id: item.id, query: preselect ? '' : query, options: result.facts, target, total: result.total });
    } catch (error: any) { setSharedError(error?.message || '无法查找旧记忆'); }
    finally { setSharedBusy(false); }
  }
  async function resubmitShared(item: any) {
    if (!sharedEdit || sharedEdit.id !== item.id) return;
    setSharedBusy(true); setSharedError('');
    try {
      await ctx.call('memlayerReview', { scope: sharedScope, decision: 'replace', id: item.id, hash: item.hash, text: sharedEdit.text });
      ctx.notify('候选已保存，等待确认');
      setSharedEdit(null); await loadShared();
    } catch (error: any) { setSharedError(error?.message || '修改后提交失败'); }
    finally { setSharedBusy(false); }
  }
  async function retractShared(fact: any) {
    setSharedBusy(true); setSharedError('');
    try {
      await ctx.call('memlayerRetract', { scope: sharedScope, factId: fact.id, reason: '作者在记忆中心撤回' });
      ctx.notify('已撤回，后续对话不再召回');
      await loadShared();
    } catch (error: any) { setSharedError(error?.message || '撤回失败'); }
    finally { setSharedBusy(false); }
  }

  async function changeStatus(m: any, status: string) {
    await ctx.act(() => ctx.call('setMemoryStatus', { id: m.id, expectedHash: m._hash, expectedRevision: m.revision, status }), status === 'disabled' ? '已停用，后续任务不再加载' : '状态已保存');
  }
  return <div className="memory-center">
    <div className="page-heading"><div><h1>记忆与规则</h1><p>让 AI 记住已确认的协作方式，每次调用都有记录。</p></div><button className="primary" onClick={() => setEditing({})}><Icon name="plus"/>新增记忆</button></div>
    <div className="notice">作品内记忆仅属于《{ctx.work.name}》；「共享记忆」页只在作者显式选择「作者共享」时才跨作品读取。人物事实、剧情变化和用词放行仍以各自正式资料为准。待核对、停用或范围不符的内容不会发送给 AI。</div>
    <div className="memory-counts"><span>已确认 <strong>{memories.filter(m => m.status === 'confirmed' && !m.externalPending && !m.damaged).length}</strong></span><span>待核对 <strong>{memories.filter(m => m.status === 'candidate').length}</strong></span><span>调用记录 <strong>{runs.length}</strong></span></div>
    <div className="tabs"><button className={tab === 'memories' ? 'active' : ''} onClick={() => setTab('memories')}>记忆条目</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => { setTab('preview'); setPreview(null); }}>任务读取预览</button><button className={tab === 'shared' ? 'active' : ''} onClick={() => void openShared()}>共享记忆</button><button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>AI 调用记录</button><button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>规则与裁定</button></div>
    {tab === 'memories' && <>
      <div className="list-toolbar"><input aria-label="搜索记忆" placeholder="搜索标题、内容或来源" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="筛选记忆状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">已确认与待核对</option><option value="all">所有条目</option>{Object.entries(memoryStates).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      {!visible.length && <Empty title="这里还没有符合条件的记忆" detail="可以记录协作原则、写作偏好、本次任务约定，或从 AI 修订中保存纠错案例。"/>}
      {visible.map(m => <section className="panel memory-card" key={m.id} data-memory-id={m.id}><div className="panel-heading"><div><h3>{m.title}</h3><p className="muted small-text">{memoryKinds[m.kind] || '资料损坏'} · {memoryScope(m, ctx)} · {m.revision ? `第 ${m.revision} 版` : ''}</p></div><Badge status={m.status === 'confirmed' ? 'accepted' : 'pending'}>{memoryStates[m.status] || '待恢复'}</Badge></div>
        <p className="memory-content">{m.content || m.error}</p>{m.exceptions && <p>例外：{m.exceptions}</p>}
        <p className="muted small-text">AI参考 · {m.tasks?.map((t: string) => ({revision:'AI 修订',extraction:'剧情归档',obligation:'场景核对',cowriting:'创作空间'} as Record<string,string>)[t]||t).join('、')} · 来源：{m.source?.reference || '待核对'} · {dateText(m.updated_at)}</p>
        {m.lifetime === 'once' && <div className="notice">{onceUsed(m.id) ? '这条约定已用于一次请求，后续任务不会再次加载。' : '仅下一次适用的 AI 任务读取；预览不会消耗，网络请求失败也会留下使用记录。'}</div>}
        {(m.damaged || m.externalPending || m.unreviewedExternal) && <div className="notice danger">本地文件有变化或尚未登记，已暂停加载。<button className="text-button" onClick={() => setReviewPath(`_创作管理/记忆/${m.id}.md`)}>核对本地文件</button></div>}
        {!!m.example?.after && <details><summary>查看纠错案例与来源原话</summary><div className="memory-example"><p>原文：{m.example.before || '未记录'}</p><p>AI建议：{m.example.suggested || '未记录'}</p><p>作者改写：{m.example.after}</p>{m.source.quote && <blockquote>{m.source.quote}</blockquote>}</div></details>}
        {m.status === 'superseded' ? <p className="muted small-text">已保留为旧版本，不再加载。</p> : <div className="actions"><button disabled={m.damaged || m.externalPending || m.unreviewedExternal} onClick={() => setEditing(m)}>{m.status === 'candidate' ? '核对并编辑' : '编辑'}</button>{m.status === 'confirmed' && <button onClick={() => changeStatus(m, 'disabled')}>停用</button>}{m.status === 'disabled' && <button onClick={() => setEditing({ ...m, status: 'confirmed' })}>检查后重新启用</button>}</div>}
      </section>)}
    </>}
    {tab === 'shared' && <section className="panel"><h3>共享记忆（跨会话）</h3>
      <p className="muted small-text">创作对话中的长期偏好会先进入待核对候选。可以确认新增，也可以选一条旧记忆进行替换或增加例外。</p>
      {sharedError && <p className="notice danger">{sharedError}</p>}
      <div className="list-toolbar"><button disabled={sharedBusy} onClick={() => void loadShared()}>{sharedBusy ? '读取中…' : '刷新'}</button>
        {shared?.scopes?.map((item: any) => <button key={item.scope} className={sharedScope === item.scope ? 'primary' : ''} disabled={sharedBusy}
          onClick={() => { setSharedScope(item.scope); setShared(null); setSharedEdit(null); setReplacement(null); setRejection(null); void loadShared(item.scope, 0); }}>{item.label}</button>)}
      </div>
      <h4>待核对候选 {shared ? `(${shared.candidates.length})` : ''}</h4>
      {shared && !shared.candidates.length && <p className="muted">当前范围没有待核对的候选。</p>}
      {focusedCandidate && sharedScope === 'work' && shared && !shared.candidates.some((item: any) => item.id === focusedCandidate) &&
        <p className="muted">此候选已处理或无法读取。</p>}
      {shared?.candidates.slice().sort((a: any, b: any) => Number(b.id === focusedCandidate) - Number(a.id === focusedCandidate)).map((item: any) => {
        const edit = sharedEdit?.id === item.id ? sharedEdit : null;
        const change = replacement?.id === item.id ? replacement : null;
        const old = change?.options.find(fact => fact.id === change.target);
        const reject = rejection?.id === item.id ? rejection : null;
        const suggestedLabel = ({ exception: '建议增加例外', duplicate: '可能与已有记忆重复', replace: '建议替换旧记忆' } as Record<string, string>)[item.suggestedAction];
        return <div className="memory-card" key={item.id} data-candidate-id={item.id}>
        {edit ? <textarea aria-label="修改候选原话" rows={4} maxLength={2000} value={edit.text}
          onChange={event => setSharedEdit({ id: edit.id, text: event.target.value })}/> : <p className="memory-content">{item.text}</p>}
        <p className="muted small-text">范围：{item.scopeLabel} · 来源原话：{item.source}</p>
        {suggestedLabel && <p className="muted small-text">{suggestedLabel}</p>}
        <div className="actions">
          {edit
            ? <><button disabled={sharedBusy || !edit.text.trim()} onClick={() => void resubmitShared(item)}>改后重新提交</button>
              <button disabled={sharedBusy} onClick={() => setSharedEdit(null)}>取消修改</button></>
            : !change && !reject && <>
              <button className={item.suggestedFactId ? undefined : 'primary'} disabled={sharedBusy} onClick={() => void reviewShared(item, 'approve')}>确认新增</button>
              <button className={item.suggestedFactId ? 'primary' : undefined} disabled={sharedBusy}
                onClick={() => { setSharedEdit(null); void findReplacement(item, item.suggestedFactId || '', !!item.suggestedFactId); }}>
                {item.suggestedAction === 'exception' ? '核对适用例外' : item.suggestedAction === 'duplicate' ? '核对已有记忆' : '替换旧记忆'}
              </button>
              <button disabled={sharedBusy} onClick={() => setRejection({ id: item.id, reason: '' })}>拒绝</button>
              <button disabled={sharedBusy} onClick={() => { setReplacement(null); setSharedEdit({ id: item.id, text: item.text }); }}>编辑</button>
            </>}
        </div>
        {reject && <form className="writing-reference-picker" onSubmit={event => {
          event.preventDefault();
          if (!sharedBusy) void reviewShared(item, 'reject', undefined, reject.reason || undefined);
        }}>
          <label>拒绝原因（可选）
            <select disabled={sharedBusy} value={reject.reason} onChange={event => setRejection({ ...reject, reason: event.target.value })}>
              <option value="">不填写</option><option value="only_once">只限本次</option>
              <option value="scope_too_broad">范围太广</option><option value="already_exists">已经有了</option>
            </select>
          </label>
          <div className="actions"><button type="submit" disabled={sharedBusy}>确认拒绝</button>
            <button type="button" disabled={sharedBusy} onClick={() => setRejection(null)}>取消</button></div>
        </form>}
        {change && <div>
          <form className="list-toolbar" onSubmit={event => {
            event.preventDefault();
            if (!sharedBusy) void findReplacement(item, change.query.trim());
          }}>
            <input aria-label="搜索要替换的旧记忆" placeholder="输入旧记忆内容或编号" maxLength={200} value={change.query}
              onChange={event => setReplacement({ ...change, query: event.target.value })}/>
            <button type="submit" disabled={sharedBusy}>查找旧记忆</button>
          </form>
          <select aria-label="选择要替换的旧记忆" value={change.target} disabled={sharedBusy}
            onChange={event => setReplacement({ ...change, target: event.target.value })}>
            <option value="">请选择旧记忆</option>
            {change.options.map(fact => <option key={fact.id} value={fact.id}>{fact.text}</option>)}
          </select>
          {old && <p className="memory-content">现行记忆「{old.text}」</p>}
          {old && item.suggestedAction === 'exception' && <p className="muted">确认增加例外后，现行做法继续用于其他情况。</p>}
          {!change.options.length && <p className="muted">没有找到可替换的旧记忆。</p>}
          {change.total > change.options.length && <p className="muted">可用关键词缩小结果范围。</p>}
          <div className="actions">
            <button className={item.suggestedAction === 'exception' ? 'primary' : undefined} disabled={sharedBusy || !old}
              onClick={() => { if (old) void reviewShared(item, 'approve-exception', old.id); }}>确认增加例外</button>
            <button className={item.suggestedAction === 'replace' ? 'primary' : undefined} disabled={sharedBusy || !old}
              onClick={() => { if (old) void reviewShared(item, 'approve-replacement', old.id); }}>确认替换</button>
            {item.suggestedAction === 'duplicate' && <button className="primary" disabled={sharedBusy || !old}
              onClick={() => void reviewShared(item, 'reject', undefined, 'already_exists')}>保留已有记忆</button>}
            <button disabled={sharedBusy} onClick={() => setReplacement(null)}>返回候选</button>
          </div>
        </div>}
      </div>;
      })}
      <h4>已保存 {shared ? `(${shared.total})` : ''}</h4>
      {(shared || sharedFilter) && <form className="list-toolbar" onSubmit={event => {
        event.preventDefault();
        if (sharedBusy) return;
        const search = sharedSearch.trim();
        setSharedFilter(search);
        void loadShared(sharedScope, 0, search);
      }}>
        <input aria-label="查找已保存的记忆" placeholder="输入记忆内容或来源编号" value={sharedSearch} maxLength={200}
          onChange={event => setSharedSearch(event.target.value)}/>
        <button type="submit" disabled={sharedBusy}>查找</button>
        {sharedFilter && <button type="button" disabled={sharedBusy} onClick={() => {
          setSharedSearch(''); setSharedFilter(''); void loadShared(sharedScope, 0, '');
        }}>清除查找</button>}
      </form>}
      {shared && !shared.facts.length && <p className="muted">{sharedFilter ? '没有找到符合条件的记忆。' : '当前范围还没有已确认的共享记忆。'}</p>}
      {shared?.facts.map((fact: any) => <div className="memory-card" key={fact.id}>
        <p className="memory-content">{fact.text}</p>
        <p className="muted small-text">范围：{fact.scopeLabel} · 来源：{fact.source || '未记录'} · 自 {fact.validFrom || '—'}</p>
        <div className="actions"><button disabled={sharedBusy} onClick={() => void retractShared(fact)}>撤回</button></div>
      </div>)}
      {shared && shared.total > shared.limit && <div className="actions">
        <button disabled={sharedBusy || shared.offset === 0} onClick={() => void loadShared(sharedScope, shared.offset - shared.limit)}>上一页</button>
        <span aria-live="polite">{shared.offset + 1}–{shared.offset + shared.facts.length} / {shared.total} 条</span>
        <button disabled={sharedBusy || shared.offset + shared.limit >= shared.total}
          onClick={() => void loadShared(sharedScope, shared.offset + shared.limit)}>下一页</button>
      </div>}
    </section>}
    {tab === 'preview' && <section className="panel"><h3>下次任务会读取什么</h3><p>预览由本地规则筛选，不调用模型，不消耗一次性约定。正式任务开始时会重新计算并固定版本。</p><div className="memory-form-grid"><label>任务<select aria-label="预览AI任务" value={task} onChange={e => { setTask(e.target.value); setPreview(null); }}><option value="revision">AI 修订</option><option value="extraction">剧情归档</option><option value="obligation">场景核对</option><option value="cowriting">创作空间</option></select></label><label>稿件<select aria-label="预览稿件" value={docId} onChange={e => { setDocId(e.target.value); setPreview(null); }}>{ctx.work.documents.filter(d => ['chapter', 'draft', 'plan'].includes(d.kind)).map(d => <option value={d.id} key={d.id}>{d.title}</option>)}</select></label></div>{task==='obligation'&&<label>核对义务卡<select aria-label="预览义务卡" value={obCardId} onChange={e=>{setObCardId(e.target.value);setPreview(null);}}><option value="">请选择已确认的卡片</option>{ctx.work.obligationCards?.filter(c=>c.documentId===docId&&c.status==='confirmed').map(c=><option value={c.id} key={c.id}>{c.title}</option>)}</select></label>}<button disabled={!docId||task==='obligation'&&!ctx.work.obligationCards?.some(c=>c.id===obCardId&&c.documentId===docId)} onClick={async () => { const p = await ctx.act(() => ctx.call('memoryContext', { task, documentId: docId,cardId:task==='obligation'?obCardId:null })); if (p) setPreview(p); }}>预览将加载的记忆</button>{preview && <><p>加载 {preview.selected.length} 条 · 记忆数据 {preview.chars} / {preview.limit} 字符</p>{preview.selected.map((m: any) => <div className="memory-trace-item" key={m.id}><strong>{m.title}</strong><p>{m.content}</p><small>{memoryScope(m, ctx)}</small></div>)}{preview.excluded.length > 0 && <details open><summary>未加载的原因</summary><ul>{preview.excluded.map((m: any) => <li key={m.id}>{m.title}：{m.reason}</li>)}</ul></details>}</>}</section>}
    {tab === 'runs' && <><p className="muted small-text">显示最近 100 次准备或调用；完整记录保存在本地作品管理文件中。</p>{!runs.length && <Empty title="还没有记忆调用记录" detail="今后的 AI 修订、剧情归档和场景核对会记录实际采用的记忆版本；旧任务不会补造调用记录。"/>}{runs.map(run => <MemoryTrace key={run.id} ctx={ctx} run={run} compact/>)}</>}
    {tab === 'rules' && <><section className="panel"><h3>规则各自如何生效</h3><table><thead><tr><th>内容</th><th>执行方式</th><th>维护入口</th></tr></thead><tbody><tr><td>稿件完整性、承接与文风检查</td><td>统一门禁机检；检查失败和未完成分别显示</td><td>正文 → 确认版本 → 运行检查</td></tr><tr><td>作者偏好与协作约定</td><td>已确认记忆按范围传给 AI；语义是否遵守需要核对</td><td>本页记忆条目</td></tr><tr><td>作品用词</td><td>软线提醒；是否放行及放行范围由作者裁定</td><td>稿件核对中的用词提醒</td></tr><tr><td>人物身份与剧情事实</td><td>基座、事件和原文证据；记忆不能替代事实</td><td>人物档案、更新与核对</td></tr></tbody></table><p className="muted small-text">新增记忆不会自动改写门禁脚本。后续可将可确定判定的纠错案例做成带正反例的机器规则。</p></section><section className="panel"><h3>现行用词裁定</h3>{!ctx.work.wordingDecisions?.some(r => r.active !== false) ? <p className="muted">尚无有效作者裁定。</p> : <table><thead><tr><th>用词</th><th>裁定</th><th>范围</th></tr></thead><tbody>{ctx.work.wordingDecisions.filter(r => r.active !== false).map(r => <tr key={r.id}><td>{r.term}</td><td>{r.allow ? '已放行' : '保留提醒'}</td><td>{r.scope === 'work' ? '全作品' : `${ctx.work.documents.find(d => d.id === r.documentId)?.title || '指定文档'} · ${r.scope === 'revision' ? '仅本次版本' : '本章后续版本'}`}</td></tr>)}</tbody></table>}<button onClick={() => ctx.navigate({ page: 'updates' })}>打开更新与核对</button></section></>}
    {editing && <MemoryEditor ctx={ctx} initial={editing} onClose={() => setEditing(null)}/>}
    {reviewPath && <ManagedReview ctx={ctx} path={reviewPath} onClose={() => setReviewPath('')}/>}
  </div>;
}
