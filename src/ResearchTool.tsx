import React, { useContext, useEffect, useId, useState } from 'react';
import { dateText, type AppContext } from './domain';
import { Icon } from './components';
import { ResearchCitation, researchNatureLabels, type ResearchAction, type ResearchCandidate,
  type ResearchFields, type ResearchList, type ResearchSource, type WebSource } from './research-domain';
import './research.css';

const statusLabels = { pending: '待核对', confirmed: '已写入设定', deferred: '已暂缓' };
const fieldValues = ({ title, body, category, nature, fromChapter, toChapter }: ResearchCandidate) =>
  ({ title, body, category, nature, fromChapter, toChapter });

function SourceCitation({ source, onOpen }: { source: ResearchSource; onOpen: (url: string) => void }) {
  if (source.type === 'discussion') {
    return <div className="research-citation">
      <strong>{source.title}</strong>
      <p className="research-meta">{source.role === 'assistant' ? '创作助手回复' : '作者发言'} · {dateText(source.at)}</p>
      <details><summary>查看对话摘录</summary><blockquote>{source.excerpt}</blockquote></details>
    </div>;
  }
  return <div className="research-citation">
    <button className="research-link" type="button" title={source.url} onClick={() => onOpen(source.url)}>{source.title}</button>
    <p className="research-meta">{source.domain}{source.published ? ` · 发布于 ${source.published}` : ''} · 查阅于 {dateText(source.retrievedAt)}</p>
    {source.excerpt && <p className="research-excerpt">{source.excerpt}</p>}
  </div>;
}

export default function ResearchTool({ ctx, requestedId }: { ctx: AppContext; requestedId?: string }) {
  const citation = useContext(ResearchCitation);
  const formId = useId();
  const [tab, setTab] = useState<'search' | 'candidates'>(requestedId ? 'candidates' : 'search');
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<{ query: string; results: WebSource[] } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [list, setList] = useState<ResearchList | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [activeId, setActiveId] = useState(requestedId || '');
  const [candidate, setCandidate] = useState<ResearchCandidate | null>(null);
  const [fields, setFields] = useState<ResearchFields | null>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [candidateError, setCandidateError] = useState('');
  const { call } = ctx;

  useEffect(() => {
    if (!requestedId) return;
    setActiveId(requestedId); setTab('candidates');
  }, [requestedId]);

  useEffect(() => {
    if (tab !== 'candidates' || activeId) return;
    let live = true;
    setCandidateError('');
    call('listResearchCandidates').then(value => { if (live) setList(value); })
      .catch(error => { if (live) setCandidateError(error.message); });
    return () => { live = false; };
  }, [tab, activeId, listVersion, call]);

  useEffect(() => {
    if (!activeId) return;
    let live = true;
    setCandidate(null); setFields(null); setCandidateError(''); setChecked(false);
    call('getResearchCandidate', { id: activeId })
      .then(value => { if (live) { setCandidate(value); setFields(fieldValues(value)); } })
      .catch(error => { if (live) setCandidateError(error.message); });
    return () => { live = false; };
  }, [activeId, call]);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim() || searching) return;
    setSearching(true); setSearchError(''); setSelectedIds([]); setResponse(null);
    try { setResponse(await call('searchResearch', { query })); }
    catch (error) { setSearchError((error as Error).message); }
    finally { setSearching(false); }
  }

  async function openSource(url: string) {
    try { await call('openWebSource', { url }); }
    catch (error) { ctx.notify((error as Error).message, true); }
  }

  function toggle(id: string, checked: boolean) {
    setSelectedIds(ids => checked ? [...ids, id] : ids.filter(value => value !== id));
  }

  async function createCandidate() {
    if (!selectedIds.length || saving) return;
    setSaving(true); setSearchError('');
    try {
      const saved: ResearchCandidate = await call('createResearchCandidate', { sourceIds: selectedIds });
      setActiveId(saved.id); setTab('candidates'); setListVersion(n => n + 1);
    } catch (error) { setSearchError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function persist(action: ResearchAction, sourceIds?: string[]) {
    if (!candidate || saving) return;
    setSaving(true); setCandidateError(''); setSearchError('');
    try {
      const saved: ResearchCandidate = await call('saveResearchCandidate', {
        id: candidate.id, expectedHash: candidate.hash, fields, action, confirmed: checked, sourceIds,
      });
      setCandidate(saved); setFields(fieldValues(saved)); setChecked(false); setListVersion(n => n + 1);
      if (sourceIds) setTab('candidates');
      if (action === 'adopt') await ctx.refresh();
      ctx.notify(action === 'adopt' ? '已写入本地设定，可从本次依据查看。' : '候选已保存');
    } catch (error) {
      const message = (error as Error).message;
      if (sourceIds) setSearchError(message);
      else setCandidateError(message);
    } finally { setSaving(false); }
  }

  function change<K extends keyof ResearchFields>(key: K, value: ResearchFields[K]) {
    setFields(current => current && { ...current, [key]: value });
    setChecked(false);
  }

  const pending = candidate?.status === 'pending';
  const reading = !!activeId && !candidate && !candidateError;
  const selected = response?.results.filter(row => selectedIds.includes(row.id)) || [];
  const canAdopt = !!(fields?.title.trim() && fields.body.trim() && fields.category.trim() && fields.category !== '待分类');
  const listRows = (processed: boolean) => list?.candidates.filter(row => (row.status !== 'pending') === processed).map(row =>
    <button className="research-row" key={row.id} onClick={() => setActiveId(row.id)}>
      <span><strong>{row.title}</strong><small>{researchNatureLabels[row.nature]} · {row.sourceCount} 条出处 · {dateText(row.updatedAt)}</small></span>
      <span className="research-status">{statusLabels[row.status]}</span>
    </button>);

  return <section className="research-tool">
    <div className="research-heading">
      <h2>查资料</h2>
      <div className="research-tabs" aria-label="查资料方式">
        <button aria-pressed={tab === 'search'} onClick={() => setTab('search')}>联网搜索</button>
        <button aria-pressed={tab === 'candidates'} onClick={() => setTab('candidates')}>候选设定</button>
      </div>
    </div>

    {tab === 'search' ? <>
      <form className="research-search" onSubmit={search}>
        <label htmlFor={formId + '-query'}>搜索词</label>
        <div><input id={formId + '-query'} value={query} maxLength={220} onChange={e => setQuery(e.target.value)}
          placeholder="例如：20 世纪早期广播电台的工作流程"/>
          <button type="submit" className="primary" disabled={searching || !query.trim()}><Icon name="search" size={15}/>{searching ? '搜索中…' : '搜索'}</button></div>
        <p className="research-meta">Exa 网页搜索 · 向搜索服务发送你填写的搜索词</p>
      </form>

      {searchError && <p className="notice danger" role="alert">{searchError}</p>}
      {searching && <p className="research-meta" role="status">正在查找出处…</p>}
      {response && <div className="research-results" aria-busy={searching}>
        {!response.results.length ? <p role="status">这次没有找到带出处的结果。试试更具体的名称或换一个关键词。</p> : <>
          <div className="research-results-heading">
            <span role="status">{response.results.length} 条结果 · 已选 {selectedIds.length} 条</span>
            <div className="studio-actions">
              <button disabled={!selected.length || !citation?.ready} onClick={() => citation?.insert(selected)}>带到对话</button>
              <button className="primary" disabled={!selected.length || saving} onClick={createCandidate}>整理为候选</button>
            </div>
          </div>
          {candidate?.status === 'pending' && <button className="research-supplement" disabled={!selected.length || saving}
            onClick={() => void persist('save', selectedIds)}>补入当前候选「{candidate.title}」</button>}
          <ul className="research-result-list">
            {response.results.map(source => <li key={source.id}>
              <input type="checkbox" aria-label={`选中 ${source.title}`} checked={selectedIds.includes(source.id)}
                disabled={!selectedIds.includes(source.id) && selectedIds.length >= 4}
                onChange={event => toggle(source.id, event.target.checked)}/>
              <SourceCitation source={source} onOpen={openSource}/>
            </li>)}
          </ul>
        </>}
      </div>}
    </> : <>
      {candidateError && <p className="notice danger" role="alert">{candidateError}</p>}
      {!activeId && <>
        {!list && !candidateError && <p className="research-meta" role="status">正在读取本地候选…</p>}
        {!!list?.damaged.length && <p className="notice danger" role="alert">{list.damaged.length} 份本地候选无法读取，原文件已保留。</p>}
        {list && !list.candidates.some(row => row.status === 'pending') && <div className="research-empty">
          <p>目前没有待核对的设定。</p><p className="research-meta">可以选择搜索结果，或在创作对话的消息旁点「整理为候选」。</p>
        </div>}
        <div className="research-queue" aria-label="待核对候选">{listRows(false)}</div>
        {list?.candidates.some(row => row.status !== 'pending') && <details className="research-processed"><summary>已处理的候选</summary>
          <div className="research-queue">{listRows(true)}</div></details>}
      </>}
      {activeId && <button type="button" disabled={saving} onClick={() => { setActiveId(''); setCandidate(null); setFields(null); }}>返回候选列表</button>}
      {reading && <p className="research-meta" role="status">正在打开候选…</p>}
      {candidate && fields && <div className="research-detail">
        <p className="research-status">{statusLabels[candidate.status]}</p>
        {pending ? <fieldset className="research-fields" disabled={saving}>
          <label>设定标题<input value={fields.title} maxLength={90} onChange={e => change('title', e.target.value)}/></label>
          <div className="research-field-grid">
            <label>设定性质<select value={fields.nature} onChange={e => change('nature', e.target.value as ResearchFields['nature'])}>
              {Object.entries(researchNatureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>分类<input value={fields.category === '待分类' ? '' : fields.category} maxLength={40}
              placeholder="例如：服饰与民俗" onChange={e => change('category', e.target.value || '待分类')}/></label>
          </div>
          <label htmlFor={formId + '-adopted-text'}>准备采用的内容</label>
          <textarea id={formId + '-adopted-text'} rows={6} maxLength={4500} value={fields.body} onChange={e => change('body', e.target.value)}
            placeholder="写下要保留的内容，可先把来源带到对话里整理。"/>
          <details className="research-chapters">
            <summary>适用章节{fields.fromChapter || fields.toChapter ? ' · 已限定' : ' · 全书'}</summary>
            <div className="research-field-grid">
              <label>起始章<input type="number" min={1} max={99999} value={fields.fromChapter ?? ''} placeholder="不限"
                onChange={e => change('fromChapter', e.target.value ? Number(e.target.value) : null)}/></label>
              <label>结束章<input type="number" min={1} max={99999} value={fields.toChapter ?? ''} placeholder="不限"
                onChange={e => change('toChapter', e.target.value ? Number(e.target.value) : null)}/></label>
            </div>
          </details>
        </fieldset> : <>
          <h3>{candidate.title}</h3>
          <p className="research-meta">{candidate.category} · {researchNatureLabels[candidate.nature]}</p>
          <p className="research-adopted">{candidate.body}</p>
        </>}
        <section className="research-evidence" aria-label="候选出处">
          <h3>出处</h3>
          {candidate.sources.map(source => <SourceCitation source={source} key={source.id} onOpen={openSource}/>)}
        </section>
        {pending ? <div className="research-review">
          <label className="research-check"><input type="checkbox" disabled={!canAdopt || saving} checked={checked}
            onChange={e => setChecked(e.target.checked)}/>我已核对内容、出处和适用范围</label>
          <div className="studio-actions">
            <button disabled={saving} onClick={() => void persist('save')}>保存候选</button>
            <button disabled={saving} onClick={() => void persist('defer')}>暂缓</button>
            <button className="primary" disabled={!checked || !canAdopt || saving} onClick={() => void persist('adopt')}>
              {saving ? '正在保存…' : '确认写入设定'}</button>
          </div>
        </div> : candidate.status === 'deferred' ? <button disabled={saving} onClick={() => void persist('resume')}>恢复待核对</button>
          : candidate.documentId && <button onClick={() => ctx.navigate({ page: 'reader', documentId: candidate.documentId })}>打开本地设定</button>}
      </div>}
    </>}
  </section>;
}
