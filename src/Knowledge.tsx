import React, { useEffect, useMemo, useState } from 'react';
import type { AppContext, BoardRecord, SourceDocument, StoryEvent } from './domain';
import { dateText, kindLabels, layerLabels, chapterReferenceLabels, documentKindLabel } from './domain';
import { Icon, Badge, Empty, Modal, Markdown, Evidence, SectionTitle } from './components';
import { humanValue } from './domain';
import { SettingInfo } from './SettingInfo';
import { LibraryMigration } from './LibraryMigration';
import { RecordFields } from './RecordFields';
import { PlotReview, VolumeOutlineReview } from './PlotReview';
import { WorldSources, openMaterial, pendingLibraryDoc, worldDocumentStatus, worldKinds } from './WorldSources';
import { ImportTextButton, RevealSourceButton } from './LocalFileActions';
import { DraftImport, importDate, isImportedLibraryText, newestImportFirst } from './DraftImport';
import { DiscussionComposer } from './DiscussionReference';

export function Overview({ ctx }: { ctx: AppContext }) {
  const {work}=ctx; const [plot,setPlot]=useState('');
  useEffect(()=>{const d=work.documents.find(d=>d.kind==='plot');let live=true;if(d)ctx.call('readDocument',{documentId:d.id}).then(r=>{if(live){const m=r.text.match(/## 一、当前状态[^\n]*\n([\s\S]*?)(?=\n## |$)/);setPlot((m?.[1]||r.text).slice(0,1400));}}).catch(()=>{});return()=>{live=false;};},[work.id]);
  const chapters=work.documents.filter(d=>d.kind==='chapter').slice().sort((a,b)=>(b.chapter||0)-(a.chapter||0));
  const drafts=work.documents.filter(d=>d.kind==='draft');
  const stats=[{label:'正文文件',value:work.stats.chapters,unit:'章',icon:'book',caption:`文件最远至第${work.stats.latestFile}章`},{label:'作者已确认',value:work.stats.confirmed,unit:'章',icon:'check',caption:'按确认版本单独统计'},{label:'人物档案',value:work.stats.characters,unit:'人',icon:'users',caption:`${work.stats.baselines}人的初始基座已核对`},{label:'待核对变化',value:work.stats.pending,unit:'项',icon:'inbox',caption:work.stats.external?`另有${work.stats.external}份外部修改`:'修改与归档均有记录'}];
  const last=chapters[0];
  return <div className="workspace-overview"><div className="page-heading"><div><span className="eyebrow">YOUR STORY, IN ONE PLACE</span><h1>作品总览</h1><p>正文、人物与设定，都在这张书桌上。</p></div><div className="actions"><button className="primary" onClick={() => ctx.navigate({page:'cowriting'})}><Icon name="edit"/>构思新章</button><button onClick={()=>ctx.act(()=>ctx.call('refresh'),'已核对本地资料清单')}><Icon name="refresh"/>刷新资料</button><button className="primary" onClick={()=>ctx.navigate({page:'reader',documentId:last?.id})}><Icon name="book"/>继续阅读</button></div></div>
    <section className="story-hero"><div className="hero-lines"/><div className="hero-copy"><span className="eyebrow">长篇创作 · 本地工作区</span><h2>{work.name}</h2><p>{work.era||'每一次推进，都能回到它的出处。'}</p><div className="hero-status"><span className="local-dot"/>原位连接 · Markdown资料<span className="hero-separator"/>作者掌握最终设定</div></div><div className="hero-book"><div className="book-ornament">瑶<br/>川</div><div className="book-spine"/><span>故事有来处<br/>改动有依据</span></div></section>
    <div className="stats-grid">{stats.map(s=><section className="stat-card" key={s.label}><div className="stat-label">{s.label}<span><Icon name={s.icon} size={17}/></span></div><div className="stat-value">{s.value.toLocaleString()}<small>{s.unit}</small></div><p>{s.caption}</p></section>)}</div>
    <div className="overview-columns"><section className="panel chapter-progress"><div className="panel-heading"><h3>正文进度</h3><button className="text-button" onClick={()=>ctx.navigate({page:'reader'})}>全部章节<Icon name="arrow" size={14}/></button></div><div className="chapter-strip">{work.documents.filter(d=>d.kind==='chapter').map(d=><button key={d.id} className={`chapter-tile ${d.status==='confirmed'?'done':''}`} title={`${d.title} · ${d.status==='confirmed'?'已确认':'待确认'}`} onClick={()=>ctx.navigate({page:'reader',documentId:d.id})}>{String(d.chapter).padStart(2,'0')}</button>)}</div><div className="progress-legend"><span><i className="legend-plain"/>文件已接入</span><span><i className="legend-done"/>作者已确认</span></div><div className="recent-chapters">{chapters.slice(0,4).map(d=><button key={d.id} className="recent-chapter" onClick={()=>ctx.navigate({page:'reader',documentId:d.id})}><div className="recent-chapter-icon"><Icon name="book" size={17}/></div><div><strong>{d.title}</strong><small>{dateText(d.modified)}</small></div><Badge status={d.status}/><Icon name="chevron" size={14}/></button>)}</div>{!!drafts.length&&<div className="draft-notice"><Icon name="edit" size={15}/><span>协作资料中另有{drafts.length}份草稿，不计入已确认进度。</span><button className="text-button" onClick={()=>ctx.navigate({page:'library'})}>查看</button></div>}</section>
      <section className="panel work-notes"><div className="panel-heading"><h3>接下来可以做</h3><span className="subtle-label">WORKFLOW</span></div><button className="next-step" onClick={()=>ctx.navigate({page:'characters'})}><span className="step-number">01</span><div><strong>核对人物初始基座</strong><p>把原始设定和后续变化分开</p></div><Icon name="arrow" size={16}/></button><button className="next-step" onClick={()=>ctx.navigate({page:'reader',documentId:last?.id})}><span className="step-number">02</span><div><strong>确认一份正文版本</strong><p>保存、检查和确认分别记录</p></div><Icon name="arrow" size={16}/></button><button className="next-step" onClick={()=>ctx.navigate({page:'updates'})}><span className="step-number">03</span><div><strong>核对剧情归档结果</strong><p>有证据的变化自动写回本地</p></div><Icon name="arrow" size={16}/></button><div className="quiet-note"><Icon name="shield" size={17}/><p>基座变更、人工保护与冲突项，会留给你最终裁定。</p></div></section></div>
    <div className="overview-columns bottom-columns"><section className="panel plot-excerpt"><div className="panel-heading"><h3>剧情推进 · 原档摘录</h3><button className="text-button" onClick={()=>{const d=work.documents.find(d=>d.kind==='plot');if(d)ctx.navigate({page:'reader',documentId:d.id});}}>打开原档<Icon name="arrow" size={14}/></button></div>{plot?<div className="plot-preview"><Markdown text={plot}/></div>:<p className="muted">还没有登记剧情推进文档，可以在资料库接入。</p>}</section><section className="panel"><div className="panel-heading"><h3>资料入口</h3><Icon name="folder" size={17}/></div><div className="quick-links"><button onClick={()=>ctx.navigate({page:'settings-docs'})}><Icon name="world"/><span>世界观与功法<small>按分类核对现行设定</small></span><Icon name="chevron" size={14}/></button><button onClick={()=>ctx.navigate({page:'entities'})}><Icon name="map"/><span>地点与势力<small>关联人物、图纸与事件</small></span><Icon name="chevron" size={14}/></button><button onClick={()=>ctx.navigate({page:'library'})}><Icon name="folder"/><span>全部现行资料<small>{work.stats.documents}份文档与附件已登记</small></span><Icon name="chevron" size={14}/></button></div></section></div><div className="workspace-footnote"><Icon name="folder" size={13}/>{work.root}<span>正式内容保存在本地；检索索引可重建</span></div>
  </div>;
}

function settingCategory(d: SourceDocument) {
  if (d.kind === 'location' || d.kind === 'attachment') return '地理与空间';
  if (d.kind === 'organization') return '门派与势力';
  if (d.kind === 'family') return '姓名与家族';
  if (d.kind === 'item') return '道具与物资';
  if (/武学|武道|功法|驻颜|道种/.test(d.path)) return '武学与修行';
  if (/朝堂|官制|时代|行政|正位诏/.test(d.path)) return '时代与行政';
  if (/服饰|民俗|民风|圈层/.test(d.path)) return '服饰与民俗';
  if (/年表|年号/.test(d.path)) return '时序与年号';
  if (/货币|交易|经营/.test(d.path)) return '货币与经营';
  return '其他设定';
}
export function Library({ctx,settingsOnly=false}:{ctx:AppContext;settingsOnly?:boolean}){
  const [metadata,setMetadata]=useState(false);
  const [changingVisibility, setChangingVisibility] = useState(false);
  const [migration, setMigration] = useState(false);
  const [draftSource, setDraftSource] = useState<SourceDocument | null>(null);
  const [query,setQuery]=useState('');const [category,setCategory]=useState('all');const [create,setCreate]=useState(false);const [title,setTitle]=useState('');const [kind,setKind]=useState(settingsOnly?'setting':'reference');
  const docs = ctx.work.documents.filter(d => !settingsOnly || worldKinds.includes(d.kind) || d.kind === 'attachment');
  const hidden = new Set(settingsOnly ? [] : ctx.work.hiddenChapterMaterials || []);
  const current = docs.filter(d => !hidden.has(d.id));
  const extraCategories: Record<string, string> = {
    'imported-text': '导入文本',
    'library-pending': '待核对原档',
    'chapter-review': chapterReferenceLabels.review,
    'chapter-reference': chapterReferenceLabels.reference,
    'removed': '已移出章节资料',
  };
  const categoryFor = (d: SourceDocument) => settingsOnly ? ctx.work.settingMeta?.[d.id]?.category || settingCategory(d)
    : isImportedLibraryText(d) ? 'imported-text' : pendingLibraryDoc(d) ? 'library-pending'
      : d.kind === 'reference' && d.chapterMaterial ? 'chapter-' + d.chapterMaterial.role : d.kind;
  const categories = [...new Set(current.map(categoryFor)), ...(docs.some(d => hidden.has(d.id)) || category === 'removed' ? ['removed'] : [])];
  const selection = category === 'removed' ? docs.filter(d => hidden.has(d.id)) : current;
  const shown = selection.filter(d => (category === 'all' || category === 'removed' || categoryFor(d) === category) &&
    (!query || [d.title, d.path, ...(d.aliases || [])].some(value => value.includes(query))));
  const imported = current.filter(isImportedLibraryText).sort(newestImportFirst);
  if (category === 'imported-text') shown.sort(newestImportFirst);
  async function changeVisibility(document: SourceDocument, hide: boolean) {
    setChangingVisibility(true);
    try {
      await ctx.act(() => ctx.call('setChapterMaterialVisibility', { documentId: document.id, hidden: hide }),
        hide ? '已移出。可在「已移出章节资料」恢复。' : '已恢复资料');
    } finally { setChangingVisibility(false); }
  }
  return <div className="content-page"><div className="page-heading"><div><span className="eyebrow">{settingsOnly?'WORLD BIBLE':'SOURCE LIBRARY'}</span><h1>{settingsOnly?'世界观设定':'资料库'}</h1><p>{settingsOnly?'时代、名物与武学，按作品现行口径核对。':'现行文档原位接入，暂未结构化的内容也能直接查看。'}</p></div><div className="actions">{!settingsOnly && <>
    <ImportTextButton ctx={ctx} onImported={files => {
      setCategory('imported-text'); setQuery(''); ctx.notify(`已导入 ${files.length} 份文本`);
    }}/>
    <button onClick={() => setMigration(true)}>整理为独立资料库</button></>}<button className="primary" onClick={()=>setCreate(true)}><Icon name="plus"/>新建{settingsOnly?'设定':'资料'}</button></div></div>{ctx.cutoff!==null&&<div className="notice">本页展示现行源文档。按章节回看的动态变化请到人物与事件页查看。</div>}
    <div className="library-layout">
      <aside className="library-categories">
        <button className={category==='all'?'active':''} onClick={()=>setCategory('all')}><Icon name="folder" size={16}/><span>全部{settingsOnly?'设定':'资料'}</span><small>{current.length}</small></button>
        {categories.map(c=><button className={category===c?'active':''} key={c} onClick={()=>setCategory(c)}>
          <span>{settingsOnly ? c : extraCategories[c] || kindLabels[c]}</span><small>{c === 'removed' ? docs.length - current.length : current.filter(d => categoryFor(d) === c).length}</small>
        </button>)}
      </aside>
      <div>
        <div className="list-toolbar"><div className="pane-search"><Icon name="search" size={16}/><input placeholder="筛选标题、别名与路径" aria-label="筛选资料" value={query} onChange={e=>setQuery(e.target.value)}/></div><small className="muted">{shown.length}份资料</small></div>
        {category === 'removed' && <p className="studio-muted">原文件保存在本机。恢复后才回到常用资料和 Agent 的参考范围。</p>}
        <div className="document-grid">{shown.map(d => <div className="library-document-entry" key={d.id}><button className="document-card" onClick={() => openMaterial(ctx, d)}>
          <div className="document-card-top"><span className="document-icon"><Icon name={d.kind==='attachment'?'map':settingsOnly?'world':'book'} size={21}/></span>
            <Badge>{settingsOnly ? categoryFor(d) : documentKindLabel(d)}</Badge></div>
          <h3>{d.title}</h3><p>{d.path}</p>
          {isImportedLibraryText(d) && d.importedAt && <p>导入于 {importDate(d.importedAt)}
            {imported[0]?.id === d.id && <> · 最近导入</>}</p>}
          {d.chapterMaterial && <p>第{d.chapterMaterial.chapter}章 · {d.chapterMaterial.label}</p>}
          <div className="document-card-bottom"><span>{d.kind === 'attachment' ? '打开本地地图' : worldKinds.includes(d.kind) ? worldDocumentStatus(ctx.work, d)
            : pendingLibraryDoc(d) ? '待核对，可归类' : d.error ? '解析待处理' : d.external ? '外部修改待核对' : d.readOnly ? '只读来源'
              : ctx.work.approvals.some(a => a.documentId === d.id && a.sourceHash === d.hash) ? '当前版本已确认' : '原文可查看与编辑'}</span><Icon name="arrow" size={14}/>
          </div>
        </button><div className="actions library-file-actions"><RevealSourceButton ctx={ctx} documentId={d.id} compact/>
        {!settingsOnly && isImportedLibraryText(d) && !d.error && <button className="text-button" onClick={() => setDraftSource(d)}>存为章节草稿</button>}
        {!settingsOnly && (d.chapterMaterial || d.kind === 'draft' && hidden.has(d.id)) && d.kind !== 'chapter' && !ctx.work.chapterOutlines?.some(o => o.documentId === d.id) &&
          <button className="text-button" disabled={changingVisibility} onClick={() => void changeVisibility(d, !hidden.has(d.id))}>
            {hidden.has(d.id) ? '恢复资料' : '移出章节资料'}
          </button>}</div></div>)}</div>
        {!shown.length && <Empty title="没有匹配资料" detail="可以调整分类或在作品设置中登记资料目录。"/>}
      </div>
    </div>
    {settingsOnly&&<div className="library-metadata-action"><button onClick={()=>setMetadata(true)} disabled={!docs.length}><Icon name="edit"/>编辑设定分类、性质与适用范围</button></div>}
    {migration && <LibraryMigration ctx={ctx} onClose={() => setMigration(false)}/>}
    {draftSource && <DraftImport ctx={ctx} chapter={draftSource.draftChapterHint || ctx.work.nextChapter || ctx.work.stats.latestFile + 1}
      initialDocument={draftSource} onClose={() => setDraftSource(null)}
      onSaved={draft => { setDraftSource(null); ctx.navigate({ page: 'cowriting', documentId: draft.id }); }}/>}
    {metadata&&<SettingInfo ctx={ctx} onClose={()=>setMetadata(false)}/>}
    {create&&<Modal title={`新建${settingsOnly?'设定':'资料'}`} onClose={()=>setCreate(false)}><label>标题<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label>资料类型<select value={kind} onChange={e=>setKind(e.target.value)}>
      {(settingsOnly ? worldKinds : [...worldKinds, 'plan', 'reference']).map(value => <option key={value} value={value}>{kindLabels[value]}</option>)}
    </select></label><div className="modal-footer"><button onClick={()=>setCreate(false)}>取消</button><button className="primary" onClick={async()=>{const r=await ctx.act(()=>ctx.call('createDocument',{title,kind}),'资料已创建');if(r){setCreate(false);ctx.navigate({page:'reader',documentId:r.document.id});}}}>创建并编辑</button></div></Modal>}
  </div>;
}

const boardNames:Record<string,string>={plot_arc:'剧情线',hook:'伏笔',decision:'作者裁定',location:'地点',organization:'势力',item:'道具',knowledge:'知情记录'};
const statusNames:Record<string,string>={candidate:'候选',planned:'已拍板未写',active:'进行中',resolved:'已收束',abandoned:'已废弃',introduced:'已埋设',progressing:'推进中',paid_off:'已回收',unknown:'待确定'};
function eventOrder(e:StoryEvent){const m=e.story_time?.match(/(\d+)月(\d+)[日号]?/);return m?Number(m[1])*100+Number(m[2]):null;}
export function Boards({ctx,entities=false,initialTab,initialChapter}:{ctx:AppContext;entities?:boolean;initialTab?:string;initialChapter?:string}){
  const composer = React.useContext(DiscussionComposer);
  const outlines = ctx.work.documents.filter(doc => doc.kind === 'plan' && /大纲|卷纲|章纲/.test(doc.path));
  const firstTab = entities ? 'location' : initialTab || (outlines.length ? 'outline' : 'timeline');
  const [tab,setTab]=useState(firstTab);const [editing,setEditing]=useState<BoardRecord|null|undefined>(undefined);const [event,setEvent]=useState<StoryEvent|null>(null);const [order,setOrder]=useState('chapter');const [layer,setLayer]=useState('all');
  const [volume,setVolume]=useState<SourceDocument>();
  const [title,setTitle]=useState('');const [body,setBody]=useState('');const [details,setDetails]=useState<Record<string,any>>({});const [status,setStatus]=useState('planned');const [participants,setParticipants]=useState<string[]>([]);
  useEffect(() => { setTab(firstTab); }, [firstTab, ctx.work.id]);
  const tabs=entities?['location','organization','item','knowledge']:['review', ...(outlines.length ? ['outline'] : []), 'timeline','plot_arc','hook','decision'];
  const records=ctx.work.records.filter(r=>r.kind===tab);
  const events=ctx.work.events.filter(e=>!e.damaged&&!(e as any).unreviewedExternal&&!(e as any).uncommitted&&!e.superseded&&!e.withdrawn&&(ctx.cutoff===null||(e.source_chapter||0)<=ctx.cutoff)&&
    (e.editorial_status === 'accepted' && (layer === 'all' || e.editorial_layer === layer) || e.facts.some(f=>f.status==='accepted'&&(layer==='all'||f.layer===layer))))
    .slice().sort((a,b)=>order==='story'?(eventOrder(a)??Infinity)-(eventOrder(b)??Infinity):(a.source_chapter||0)-(b.source_chapter||0));
  function openRecord(r:BoardRecord|null){setEditing(r);setTitle(r?.title||'');setBody(r?.body||'');setStatus(r?.status||'planned');setParticipants(r?.participants||[]);setDetails(r?.details||{});}
  return <div className="content-page"><div className="page-heading"><div><span className="eyebrow">{entities?'STORY ENTITIES':'PLOT & TIMELINE'}</span><h1>{entities?'地点 · 势力 · 道具':'剧情总览'}</h1><p>{entities?'补充故事里的空间、组织、持有物与知情记录。':'核对每章带来的变化，确定后续写作使用的卷纲。'}</p></div>{!['timeline','outline','review'].includes(tab)&&<button className="primary" onClick={()=>openRecord(null)}><Icon name="plus"/>新增{boardNames[tab]}</button>}</div><div className="tabs">{tabs.map(t=><button key={t} className={tab===t?'active':''} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='outline'?'卷纲':t==='timeline'?'重大事件':t==='review'?'章节核对':boardNames[t]}</button>)}</div>
    {tab === 'plot_arc' && composer && <div className="actions">
      <button disabled={!composer.ready} onClick={() => void composer.startStage()}><Icon name="edit"/>和 Agent 讨论阶段剧情</button>
    </div>}
    {entities && (tab === 'location' || tab === 'organization' || tab === 'item') && <WorldSources key={tab} ctx={ctx} kind={tab}/>}
    {tab === 'review' ? <PlotReview ctx={ctx} initialChapter={initialChapter}/> : tab === 'outline' ? <div className="document-grid">
      {outlines.map(doc => {
        const decision = [...ctx.work.approvals].reverse().find(a => a.documentId === doc.id && a.purpose === 'volume_outline' && a.status === 'active');
        const bound = decision?.sourceHash === doc.hash;
        return <article key={doc.id} className="document-card">
          <Badge>{bound ? `已定 · 第${decision.fromChapter}–${decision.toChapter}章` : decision ? '改版待确认' : '规划参考'}</Badge>
          <h3>{doc.title}</h3><p>{doc.path}</p>
          <div className="actions"><button onClick={() => ctx.navigate({ page: 'reader', documentId: doc.id })}>阅读原文</button>
            {/(?:卷纲|卷.*大纲)/u.test(doc.title) && <button onClick={() => setVolume(doc)}>{bound ? '调整适用章序' : '确定卷纲'}</button>}</div>
        </article>;
      })}
    </div> : tab==='timeline'?<><div className="list-toolbar"><div className="actions"><select value={layer} onChange={e=>setLayer(e.target.value)} aria-label="事件性质"><option value="all">全部确认事件</option>{Object.entries(layerLabels).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select><select value={order} onChange={e=>setOrder(e.target.value)} aria-label="事件排序"><option value="chapter">按章节披露顺序</option><option value="story">按明确故事日期（未知置后）</option></select></div><small className="muted">{events.length}件事件</small></div>{events.length?<div className="event-grid">{events.map(e=><button className="event-summary panel" key={e.id} onClick={()=>setEvent(e)}><div className="panel-heading"><span className="chapter-label">{e.source_chapter?`第${e.source_chapter}章`:'作者裁定'}</span>{e.stale&&<Badge>待重核</Badge>}</div><h3>{e.title}</h3><p>{e.summary}</p><small>{e.story_time||'故事时间尚未确定'}</small><div className="event-participants">{[...new Set(e.facts.map(f=>f.entity_id))].map(id=><span key={id}>{ctx.work.characters.find(c=>c.id===id)?.name||'待确认人物'}</span>)}</div></button>)}</div>:<Empty title="确认剧情后，事件会汇总到这里" detail="设计定案会标为计划，人物误判会保留为认知，不混入已发生状态。"/>}</>:<><div className="board-explainer">{tab==='hook'?'记录埋设、推进和回收，未写的回收方案保持计划状态。':tab==='item'?'记录道具背景与持有变化；确认剧情中的流转会同时进入事件。':tab==='location'?(ctx.work.locationMaps?.length?'从上方打开现行地图。这里可补充地点说明与关联人物。':'这里可维护地点说明、关联人物和图纸。'):tab==='knowledge'?'人物所知与作者真相分开，记清何时获知、从谁处获知及是否误判。':'把方案、进展与作者裁定留在可核对的本地记录中。'}</div><div className="board-grid">{records.map(r=><button className="board-card panel" key={r.id} onClick={()=>openRecord(r)}><Badge>{statusNames[r.status]||r.status}</Badge><h3>{r.title}</h3><p>{r.body.slice(0,240)}</p><div className="event-participants">{r.participants.map(id=><span key={id}>{ctx.work.characters.find(c=>c.id===id)?.name}</span>)}</div><small>{dateText(r.updated_at)}</small></button>)}</div>{!records.length&&<Empty title={`还没有${boardNames[tab]}记录`} detail="可以开始整理，现有源文档仍完整保留在资料库。" action={<button onClick={()=>openRecord(null)}><Icon name="plus"/>新增记录</button>}/>}</>}
    {editing!==undefined&&<Modal title={`${editing?'编辑':'新增'}${boardNames[tab]}`} subtitle="保存为本地Markdown记录，保留版本历史。" wide onClose={()=>setEditing(undefined)}><div className="form-grid"><label>标题<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label>状态<select value={status} onChange={e=>setStatus(e.target.value)}>{Object.entries(statusNames).map(([s,l])=><option key={s} value={s}>{l}</option>)}</select></label></div><label>内容<textarea rows={10} value={body} onChange={e=>setBody(e.target.value)} placeholder={tab==='hook'?'埋设章节、推进过程、预期回收范围、实际回收与证据…':tab==='item'?'道具身份、初始持有人、转交事件与当前状态…':'背景、依据、变化经过和待确认部分…'}/></label><RecordFields ctx={ctx} kind={tab} value={details} onChange={setDetails}/><label>关联人物<select multiple className="multi-select" value={participants} onChange={e=>setParticipants([...e.target.selectedOptions].map(o=>o.value))}>{ctx.work.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><small className="muted">按住Ctrl可多选</small></label><div className="modal-footer"><button onClick={()=>setEditing(undefined)}>取消</button><button className="primary" onClick={async()=>{const r=await ctx.act(()=>ctx.call('saveRecord',{id:editing?.id,expectedRevision:editing?.revision,kind:tab,title,body,status,participants,details}),'记录已写入本地文件');if(r)setEditing(undefined);}}><Icon name="save"/>保存记录</button></div></Modal>}
    {volume && <VolumeOutlineReview ctx={ctx} doc={volume} onClose={() => setVolume(undefined)}/>}
    {event&&<Modal title={event.title} subtitle={event.source_chapter?`第${event.source_chapter}章 · ${event.story_time||'故事时间待定'}`:'作者裁定'} wide onClose={()=>setEvent(null)}><p>{event.summary}</p>{event.editorial_evidence?.evidence && <Evidence quote={event.editorial_evidence.evidence} chapter={event.source_chapter} stale={event.stale}/>}
      {event.facts.filter(f=>f.status==='accepted').map(f=><div className="fact-card" key={f.id}><div><Badge>{layerLabels[f.layer]}</Badge><strong>{ctx.work.characters.find(c=>c.id===f.entity_id)?.name||'待确认人物'} · {f.field}</strong></div><p>{humanValue(f,ctx.work.characters)}</p><Evidence quote={f.evidence} chapter={f.source_chapter} onOpen={f.source_document_id?()=>{setEvent(null);ctx.navigate({page:'reader',documentId:f.source_document_id!,quote:f.evidence});}:undefined} stale={event.stale}/></div>)}</Modal>}
  </div>;
}
