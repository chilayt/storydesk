import React, { useEffect, useState } from 'react';
import type { AppContext, Navigation, Page, SourceDocument } from './domain';
import { Badge, Empty, Icon, Markdown } from './components';
import { ReferenceButton } from './DiscussionReference';
import { WritingExtensionDraft } from './WritingExtensionDraft';
import { RevealSourceButton } from './LocalFileActions';
import { DraftImport, NewChapterDraft, importDate, isImportedLibraryText, newestImportFirst } from './DraftImport';

const Reader = React.lazy(() => import('./Reader').then(m => ({ default: m.Reader })));
const Characters = React.lazy(() => import('./Characters').then(m => ({ default: m.Characters })));
const Library = React.lazy(() => import('./Knowledge').then(m => ({ default: m.Library })));
const Boards = React.lazy(() => import('./Knowledge').then(m => ({ default: m.Boards })));
const Obligations = React.lazy(() => import('./Obligations'));
const ResearchTool = React.lazy(() => import('./ResearchTool'));
const ManuscriptReview = React.lazy(() => import('./ManuscriptReview'));
const BookReview = React.lazy(() => import('./BookReview'));
const Updates = React.lazy(() => import('./UpdatesSettings').then(m => ({ default: m.Updates })));

export const workspaceToolPages = new Set<Page>(['reader', 'manuscript', 'book-review', 'characters', 'settings-docs', 'plot', 'entities', 'library', 'obligations', 'research', 'updates', 'attachment', 'extensions', 'extension-draft']);
export const pageLabels: Record<Page, string> = {
  cowriting: '创作空间', overview: '作品总览', reader: '正文', characters: '人物档案', 'settings-docs': '世界观设定',
  plot: '剧情总览', entities: '地点 · 势力 · 道具', library: '资料库', obligations: '场景与核对',
  manuscript: '稿件核对', 'book-review': '全书核对', research: '查资料', updates: '更新与核对', memory: '记忆与规则', settings: '作品设置',
  attachment: '地图', extensions: '写作扩展', 'extension-draft': '创建写作扩展',
};

export const workspaceCards: { label?: string; icon: string; hint: string; nav: Navigation }[] = [
  { label: '正文与草稿', icon: 'book', hint: '读原文、编辑和引用', nav: { page: 'reader' } },
  { icon: 'users', hint: '查人物、关系与来源', nav: { page: 'characters' } },
  { icon: 'folder', hint: '浏览作品文件和设定', nav: { page: 'library' } },
  { label: '地点与地图', icon: 'map', hint: '打开现行图和地点档案', nav: { page: 'entities', tab: 'location' } },
  { icon: 'world', hint: '读世界观和作者裁定', nav: { page: 'settings-docs' } },
  { icon: 'plot', hint: '卷纲、事件和伏笔', nav: { page: 'plot' } },
  { icon: 'check', hint: '本章用词、对白和文风', nav: { page: 'manuscript' } },
  { icon: 'book', hint: '跨章时间线与证据', nav: { page: 'book-review' } },
  { icon: 'inbox', hint: '归档建议与处理记录', nav: { page: 'updates' } },
  { icon: 'shield', hint: '逐场检查应落实的内容', nav: { page: 'obligations' } },
  { icon: 'search', hint: '联网查证与资料候选', nav: { page: 'research' } },
  { icon: 'settings', hint: '文风、规则和可用能力', nav: { page: 'extensions' } },
  { icon: 'edit', hint: '拟定技能或 MCP 接口草案', nav: { page: 'extension-draft' } },
  { icon: 'home', hint: '作品进度与资料概况', nav: { page: 'overview' } },
];

export function WorkspaceShelf({ onNavigate, onDocument, onEvidence }: {
  onNavigate: (nav: Navigation) => void; onDocument: () => void; onEvidence: () => void;
}) {
  const [query, setQuery] = useState('');
  const match = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const cards = workspaceCards.filter(item => match((item.label || pageLabels[item.nav.page]) + ' ' + item.hint));
  return <div className="dock-shelf">
    <label className="dock-search"><Icon name="search" size={16}/><input aria-label="搜索工作区入口" placeholder="查找文件或工具" value={query} onChange={e => setQuery(e.target.value)}/></label>
    <div className="dock-card-grid">
      {match('当前文稿 章纲 正文 草稿 试写') && <button onClick={onDocument}><Icon name="edit"/><strong>当前文稿</strong><small>章纲、草稿和试写</small></button>}
      {match('本次依据 参考来源 版本') && <button onClick={onEvidence}><Icon name="link"/><strong>本次依据</strong><small>查看本轮资料和版本</small></button>}
      {cards.map(item => <button key={item.nav.page} onClick={() => onNavigate(item.nav)}>
        <Icon name={item.icon}/><strong>{item.label || pageLabels[item.nav.page]}</strong><small>{item.hint}</small>
      </button>)}
    </div>
    {query.trim() && !cards.length && !match('当前文稿 章纲 正文 草稿 试写') && !match('本次依据 参考来源 版本') && <p className="muted">没有匹配的工作区入口。</p>}
  </div>;
}

function Attachment({ ctx, id }: { ctx: AppContext; id?: string }) {
  const doc = ctx.work.documents.find(row => row.id === id && row.kind === 'attachment');
  const place = ctx.work.locationMaps?.find(row => row.map.documentId === id);
  if (!doc) return <Empty title="地图文件不可用" detail="可以在地点档案核对现行图的路径。"/>;
  const url = `storydesk-map://preview/${ctx.work.id}/${doc.id}?v=${encodeURIComponent(doc.modified || '')}`;
  const label = place ? `${place.map.title} ${place.map.version}` : doc.title;
  const image = /\.(?:svg|png|jpe?g|webp)$/i.test(doc.path);
  return <section className="dock-attachment">
    <div className="dock-attachment-head"><strong>{label}</strong><small>{doc.path}</small>
      <div className="actions">{place && <ReferenceButton item={{ kind: 'map', id: place.id, title: place.name, documentId: doc.id, version: place.map.version }}/>}
        <RevealSourceButton ctx={ctx} documentId={doc.id} compact/>
        <button onClick={() => ctx.act(() => ctx.call('openSource', { documentId: doc.id }))}>在系统中打开</button></div>
    </div>
    {image ? <img src={url} alt={label}/> : /\.html$/i.test(doc.path) ?
      <iframe key={url} src={url} sandbox="allow-scripts" title={label}/> : <Empty title="请在系统中打开此附件"/>}
    {place && <div className="dock-attachment-sources">{place.summary && <p>{place.summary}</p>}
      {place.sources.filter(row => row.documentId).map(row => <button className="text-button" key={row.path}
        onClick={() => ctx.navigate({ page: 'reader', documentId: row.documentId! })}>{row.title}</button>)}</div>}
  </section>;
}

type RuleSource = { path: string; label: string; group: string; use: string };
const writingRuleGroups = [
  ['style', '文风与人物声口', '随写作任务选取，专项按场引用'],
  ['wording', '唐代用词与判例', '查词义、场合和作者已有裁定'],
  ['context', '交接与前情', '按场查承接，前情以现行确认资料为准'],
  ['legacy', '旧流程', '查阅旧版开工与验收记录'],
];

function Extensions({ ctx }: { ctx: AppContext }) {
  const [tab, setTab] = useState('rules');
  const [catalogue, setCatalogue] = useState<RuleSource[] | null>(null);
  const [catalogueError, setCatalogueError] = useState('');
  const [preview, setPreview] = useState<{ source: RuleSource; text?: string; error?: string } | null>(null);
  const rules = ctx.work.documents.filter(row => row.kind === 'rule' && !row.error);
  useEffect(() => {
    let current = true;
    setCatalogue(null);
    setCatalogueError('');
    setPreview(null);
    ctx.call('writingRuleCatalogue').then((rows: RuleSource[]) => {
      if (current) setCatalogue(rows);
    }, (error: Error) => {
      if (current) setCatalogueError(error.message);
    });
    return () => { current = false; };
  }, [ctx.work.id]);
  const openSource = (source: RuleSource) => {
    const doc = rules.find(row => row.path === source.path);
    if (doc) { ctx.navigate({ page: 'reader', documentId: doc.id }); return; }
    setPreview({ source });
    ctx.call('previewWritingRule', { path: source.path }).then((text: string) => {
      setPreview(current => current?.source === source ? { source, text } : current);
    }, (error: Error) => {
      setPreview(current => current?.source === source ? { source, error: error.message } : current);
    });
  };
  const otherRules = rules.filter(doc => !catalogue?.some(source => source.path === doc.path));
  const flow = catalogue?.find(source => source.group === 'workflow');
  if (preview) return <section className="dock-extensions">
    <button onClick={() => setPreview(null)}>返回写作扩展</button>
    {preview.error ? <p role="alert">{preview.error}</p> : preview.text !== undefined
      ? <Markdown text={preview.text}/> : <p className="muted">正在读取{preview.source.label}…</p>}
  </section>;
  return <section className="dock-extensions">
    <div className="studio-actions"><button onClick={() => ctx.navigate({ page: 'extension-draft' })}>创建写作扩展</button></div>
    <div className="tabs">{[['rules', '写作资料'], ['skills', '核对工具'], ['tools', '工具与 MCP'], ['links', '插件与连接器']].map(([key, label]) =>
      <button key={key} aria-pressed={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'rules' && <>
      <div className="studio-actions">
        {flow && <button onClick={() => openSource(flow)}>{flow.label}</button>}
        <button onClick={() => ctx.navigate({ page: 'memory' })}>规则与作者裁定</button>
      </div>
      {catalogueError ? <p role="alert">{catalogueError}</p>
        : !catalogue && <p className="muted">正在读取写作资料目录…</p>}
      {writingRuleGroups.map(([key, label, description]) => {
        const group = catalogue?.filter(source => source.group === key);
        return group?.length ? <details className="extension-rule-group" key={key} open={key === 'style' || key === 'wording'}>
          <summary>{label}</summary>
          <p className="muted">{description}</p>
          <div className="dock-detail-list">{group.map(source =>
            <button key={source.path} onClick={() => openSource(source)}>{source.label}</button>)}</div>
        </details> : null;
      })}
      {(catalogue || catalogueError) && !!otherRules.length && <div className="dock-detail-list">
        {!!catalogue?.length && <h3>其他已登记的写作资料</h3>}
        {otherRules.map(doc => <button key={doc.id} onClick={() => ctx.navigate({ page: 'reader', documentId: doc.id })}>{doc.title}</button>)}
      </div>}
      {catalogue?.length === 0 && !rules.length && <p className="muted">本作品尚未登记写作资料。</p>}
    </>}
    {tab === 'skills' && <div className="dock-detail-list extension-review-tools">
      <button onClick={() => ctx.navigate({ page: 'manuscript' })}>稿件核对</button>
      <p className="muted">单章用词、对白、行为与文风。确认成稿需通过当前稿件机检。</p>
      <button onClick={() => ctx.navigate({ page: 'book-review' })}>全书核对</button>
      <p className="muted">按章查时间线、前后矛盾与伏笔，按需启动。</p>
      <button onClick={() => ctx.navigate({ page: 'obligations' })}>场景义务</button>
      <p className="muted">核对作者登记的场景要求。只有启用的必查项参与确认。</p>
    </div>}
    {tab === 'tools' && <><h3>创作助手内置工具</h3><p>查人物与前情、查设定和地图、查作品大纲、读取已引用的原文。</p></>}
    {tab === 'links' && <><h3>通用记忆</h3><p>Memlayer · {ctx.work.settings.memlayer?.enabled ? '本作品已启用' : '本作品未启用'}</p>
      <button onClick={() => ctx.navigate({ page: 'settings' })}>作品连接设置</button></>}
  </section>;
}

function ManuscriptFiles({ ctx, initialTab }: { ctx: AppContext; initialTab?: string }) {
  const [filter, setFilter] = useState<'chapter' | 'draft'>(initialTab === 'draft' ? 'draft' : 'chapter');
  const [query, setQuery] = useState('');
  const [draftImport, setDraftImport] = useState<{ source?: SourceDocument } | null>(null);
  const [newDraft, setNewDraft] = useState(false);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => { if (initialTab === 'draft') setFilter('draft'); }, [initialTab]);
  const matches = (doc: SourceDocument) => !query.trim() ||
    `${doc.title} ${doc.path} 第${doc.chapter ?? doc.draftChapterHint ?? ''}章`.includes(query.trim());
  const showingDrafts = filter === 'draft';
  const documents = ctx.work.documents.filter(doc => doc.kind === filter && !ctx.work.hiddenChapterMaterials?.includes(doc.id) &&
    matches(doc)).sort(showingDrafts ? newestImportFirst : (a, b) => (a.chapter || 0) - (b.chapter || 0));
  const imports = showingDrafts ? ctx.work.documents.filter(doc => isImportedLibraryText(doc) && doc.draftChapterHint &&
    !doc.error && !doc.historical).sort(newestImportFirst) : [];
  const matchingImports = imports.filter(matches);
  const archived = showingDrafts ? Object.values(ctx.work.sourceHistory?.retired || {}).filter(doc => doc.archivedByAuthor && matches(doc))
    .sort((a, b) => b.at.localeCompare(a.at)) : [];
  return <div className="dock-shelf manuscript-files">
    <div className="manuscript-file-toolbar">
      <div className="tabs" aria-label="稿件类型">
        <button className={!showingDrafts ? 'active' : undefined} aria-pressed={!showingDrafts} onClick={() => setFilter('chapter')}>正文</button>
        <button className={showingDrafts ? 'active' : undefined} aria-pressed={showingDrafts} onClick={() => setFilter('draft')}>草稿</button>
      </div>
      {showingDrafts && <div className="studio-actions">
        <button type="button" className="primary" onClick={() => setNewDraft(true)}><Icon name="plus" size={16}/>新建草稿</button>
        <button type="button" onClick={() => setDraftImport({})}><Icon name="upload" size={16}/>导入草稿</button>
      </div>}
    </div>
    <label className="dock-search"><Icon name="search" size={16}/><input aria-label="筛选文稿" placeholder="输入章名或章号" value={query} onChange={e => setQuery(e.target.value)}/></label>
    {documents.length > 0 && <div className="dock-detail-list">
      {documents.map(doc => <button key={doc.id} className={showingDrafts ? 'draft-file-row' : undefined}
        onClick={() => ctx.navigate({ page: 'reader', documentId: doc.id })}>
        <span>{doc.title}</span> <Badge status={doc.status}/>
        {showingDrafts && <small>{doc.path.split('/').at(-1)}{doc.importedAt && ` · 导入于 ${importDate(doc.importedAt)}`}</small>}
      </button>)}
    </div>}
    {!documents.length && matchingImports.length > 0 && <p className="muted">还没有登记的草稿。可选下方资料库原件存为草稿。</p>}
    {matchingImports.length > 0 && <section aria-labelledby="imported-manuscripts-heading">
      <h3 id="imported-manuscripts-heading">资料库中的章节稿件</h3>
      <div className="dock-detail-list">
        {matchingImports.map(doc => <button key={doc.id} className="draft-file-row" type="button"
          title={`存为第${doc.draftChapterHint}章草稿`} onClick={() => setDraftImport({ source: doc })}>
          <span>{doc.title}</span><Badge>{doc.id === imports[0]?.id ? '最近导入' : '存为草稿'}</Badge>
          <small>{doc.path.split('/').at(-1)} · {importDate(doc.importedAt || doc.modified)}</small>
        </button>)}
      </div>
    </section>}
    {!documents.length && !matchingImports.length && <Empty title={query.trim() ? '没有匹配的文稿' : showingDrafts ? '还没有章节草稿' : '这里还没有正文'}
      detail={showingDrafts && !query.trim() ? '新建空白草稿，或导入已有文稿。' : undefined}/>}
    {!!archived.length && <details className="workspace-archive-list">
      <summary>已归档文件（{archived.length}）</summary>
      {archived.map(doc => <div key={doc.id} className="workspace-archive-row"><div>
        <strong>{doc.title}</strong><small className="studio-path">{doc.path}</small></div>
        <button type="button" disabled={restoring} onClick={async () => {
          setRestoring(true);
          try { await ctx.act(() => ctx.call('restoreWorkspaceFile', { documentId: doc.id }), '已恢复到原位置'); }
          finally { setRestoring(false); }
        }}>恢复</button></div>)}
    </details>}
    {draftImport && <DraftImport ctx={ctx} initialDocument={draftImport.source}
      chapter={draftImport.source?.draftChapterHint ?? ctx.work.nextChapter ?? ctx.work.stats.latestFile + 1}
      onClose={() => setDraftImport(null)} onSaved={() => { setQuery(''); setDraftImport(null); }}/>}
    {newDraft && <NewChapterDraft ctx={ctx} chapter={ctx.work.nextChapter ?? ctx.work.stats.latestFile + 1}
      onClose={() => setNewDraft(false)} onSaved={draft => {
        setNewDraft(false); setQuery(''); ctx.navigate({ page: 'reader', documentId: draft.id });
      }}/>}
  </div>;
}

export function WorkspaceTools({ ctx, nav, active }: { ctx: AppContext; nav: Navigation; active?: boolean }) {
  return <div className={`workspace-tool tool-${nav.page}`} role="region" aria-label={`${pageLabels[nav.page]}工具`}>
    <React.Suspense fallback={<Empty title="正在打开工具…"/>}>
      {nav.page === 'reader' ? nav.documentId || nav.newChapterNumber !== undefined
        ? <Reader ctx={ctx} nav={nav}/> : <ManuscriptFiles ctx={ctx} initialTab={nav.tab}/> : nav.page === 'characters' ? <Characters ctx={ctx} selectedId={nav.characterId}/>
        : nav.page === 'settings-docs' ? <Library ctx={ctx} settingsOnly/> : nav.page === 'library' ? <Library ctx={ctx}/>
          : nav.page === 'plot' || nav.page === 'entities' ? <Boards ctx={ctx} entities={nav.page === 'entities'} initialTab={nav.tab} initialChapter={nav.documentId}/>
            : nav.page === 'obligations' ? <Obligations ctx={ctx} nav={nav}/>
              : nav.page === 'research' ? <ResearchTool ctx={ctx} requestedId={nav.researchId}/>
                : nav.page === 'manuscript' ? <ManuscriptReview ctx={ctx} nav={nav} activeView={active}/>
                  : nav.page === 'book-review' ? <BookReview ctx={ctx} returnTo={nav.bookReviewReturn}/>
                    : nav.page === 'updates' ? <Updates ctx={ctx} initialTab={nav.tab}/>
                      : nav.page === 'attachment' ? <Attachment ctx={ctx} id={nav.documentId}/>
                        : nav.page === 'extensions' ? <Extensions ctx={ctx}/>
                          : nav.page === 'extension-draft' ? <WritingExtensionDraft ctx={ctx}/> : null}
    </React.Suspense>
  </div>;
}
