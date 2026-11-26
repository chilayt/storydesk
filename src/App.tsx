import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Work, Navigation, AppContext, SearchResult } from './domain';
import { kindLabels } from './domain';
import { Icon, Badge, Empty, Modal } from './components';
import windowAppearance from '../core/window-appearance.json';
import { WorkspaceTools, pageLabels, workspaceToolPages } from './WorkspaceTools';
import appMark from '../assets/workbench-mark.png';
const Overview=React.lazy(()=>import('./Knowledge').then(m=>({default:m.Overview})));
const Cowriting=React.lazy(()=>import('./Cowriting'));
const MemoryCenter=React.lazy(()=>import('./MemoryCenter'));
const Settings=React.lazy(()=>import('./UpdatesSettings').then(m=>({default:m.Settings})));

const navigation: { nav: Navigation; label: string; icon: string }[] = [
  { nav: { page: 'cowriting' }, label: '创作空间', icon: 'home' },
  { nav: { page: 'library' }, label: '资料库', icon: 'folder' },
  { nav: { page: 'entities', tab: 'location' }, label: '地图', icon: 'map' },
  { nav: { page: 'extensions' }, label: '写作扩展', icon: 'book' },
];
const dockId = (value: Navigation) => [value.page, value.documentId, value.characterId, value.researchId].filter(Boolean).join(':');
const dockLabel = (work: Work, value: Navigation) => {
  const doc = work.documents.find(row => row.id === value.documentId);
  if ((value.page === 'reader' || value.page === 'attachment') && doc) return doc.title;
  if (value.page === 'reader' && !value.documentId) return '正文与草稿';
  if (value.page === 'characters' && value.characterId) return work.characters.find(row => row.id === value.characterId)?.name || '人物档案';
  if (value.page === 'entities' && value.tab === 'location') return '地点与地图';
  return pageLabels[value.page];
};
export default function App() {
  const [work, setWork] = useState<Work | null>(null); const workRef = useRef<Work | null>(null);
  const [loading, setLoading] = useState(true); const [nav, setNav] = useState<Navigation>({ page: 'cowriting' });
  const [workspaceNav, setWorkspaceNav] = useState<Navigation | null>(null);
  const [dockTabs, setDockTabs] = useState<Navigation[]>([]);
  const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null);
  const toolLocation = useRef<Navigation | null>(null);
  const toolHistory = useRef<Navigation[]>([]);
  const documentGuards = useRef(new Map<string, () => Promise<boolean>>());
  const registerDocumentLeave = useCallback((id: string, confirm: () => Promise<boolean>) => {
    documentGuards.current.set(id, confirm);
    return () => { if (documentGuards.current.get(id) === confirm) documentGuards.current.delete(id); };
  }, []);
  const confirmDocumentLeave = useCallback(async () => {
    const current = toolLocation.current;
    if (current?.page !== 'reader' || !current.documentId) return true;
    return await documentGuards.current.get(current.documentId)?.() ?? true;
  }, []);
  const [canGoBack, setCanGoBack] = useState(false);
  const [writingRequest, setWritingRequest] = useState<{ documentId?: string; chapterNumber?: number; id: number }>();
  const navigationSequence = useRef(0);
  const [navigating, setNavigating] = useState(false);
  const [switchingWork, setSwitchingWork] = useState(false);
  const [version, setVersion] = useState('');
  const [cutoff, setCutoff] = useState<number | null>(null); const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [search, setSearch] = useState(false); const [query, setQuery] = useState(''); const [results, setResults] = useState<SearchResult[]>([]);
  const [switcher, setSwitcher] = useState(false); const [works, setWorks] = useState<any[]>([]); const [busy, setBusy] = useState(0);
  const [newWork, setNewWork] = useState(false); const [newWorkName, setNewWorkName] = useState('');
  const [studioTheme, setStudioTheme] = useState<keyof typeof windowAppearance>(() => {
    const saved = localStorage.getItem('writing-theme');
    return saved === 'dark' || saved === 'paper' || saved === 'charcoal' ? saved : 'light';
  });
  const [captionHeight, setCaptionHeight] = useState<number | null>(null);
  const palette = windowAppearance[studioTheme];
  const [navHidden, setNavHidden] = useState(() => window.innerWidth < 900);
  const assignWork = (w: Work | null) => { workRef.current = w; setWork(w); };
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const call = useCallback((method: string, args: any = {}) => window.storyDesk.call(method, args, workRef.current?.id || null), []);
  const refresh = useCallback(async () => {
    const origin = workRef.current?.id;
    const summary = await call('summary');
    if (origin === workRef.current?.id && summary.id === origin) assignWork(summary);
  }, [call]);
  const act = useCallback(async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(n => n + 1); try { const r = await action(); await refresh(); if (success) notify(success); return r; } catch (e: any) { notify(e.message, true); return undefined; } finally { setBusy(n => Math.max(0, n - 1)); }
  }, [refresh, notify]);
  const navigate = useCallback((next: Navigation, back = false) => {
    const request = ++navigationSequence.current, origin = workRef.current?.id;
    setNavigating(true);
    void (async () => {
      const current = toolLocation.current;
      if (!(current?.page === 'reader' && next.page === 'reader' && current.documentId === next.documentId) &&
          !await confirmDocumentLeave()) return;
      await window.storyDesk.flushNow();
      if (request !== navigationSequence.current || origin !== workRef.current?.id) return;
      if (next.page === 'cowriting') {
        setWorkspaceNav(null);
        toolLocation.current = null; toolHistory.current = []; setCanGoBack(false);
        if (next.documentId || next.newChapterNumber) setWritingRequest({ documentId: next.documentId, chapterNumber: next.newChapterNumber, id: request });
      } else if (workspaceToolPages.has(next.page)) {
        const last = toolLocation.current;
        const returning = next.page === 'manuscript' && !!next.documentId && last?.reviewDocumentId === next.documentId;
        if (back || returning && toolHistory.current.at(-1)?.page === 'manuscript') toolHistory.current.pop();
        else if (!returning && last && JSON.stringify(last) !== JSON.stringify(next)) {
          const fromReview = last.page === 'manuscript' && next.page === 'reader' && next.reviewDocumentId;
          const origin = fromReview ? { ...last, documentId: next.reviewDocumentId, reviewIssueId: next.reviewIssueId, reviewPane: next.reviewPane }
            : last.page === 'book-review' && next.page === 'reader' && next.bookReviewReturn ? { ...last, bookReviewReturn: next.bookReviewReturn } : last;
          toolHistory.current = [...toolHistory.current.slice(-19), origin];
        }
        toolLocation.current = next;
        setDockTabs(rows => rows.some(row => dockId(row) === dockId(next))
          ? rows.map(row => dockId(row) === dockId(next) ? next : row) : [...rows, next]);
        setWorkspaceNav(next); setCanGoBack(toolHistory.current.length > 0);
      }
      setNav(next);
      if (window.innerWidth < 900) setNavHidden(true);
    })().catch(e => notify(`切换前未能保存编辑：${e.message}`, true))
      .finally(() => { if (request === navigationSequence.current) setNavigating(false); });
  }, [confirmDocumentLeave, notify]);
  useEffect(() => {
    window.storyDesk.call('appInfo').then(info => {
      setVersion(info.version);
      setCaptionHeight(info.nativeCaption ? info.captionHeight : 0);
      document.title = `章间 · ${info.version}`;
    }).catch(() => {});
    window.storyDesk.call('bootstrap').then(w => { if (!w.needsWork) assignWork(w); else if (w.error) notify(w.error, true); }).catch(e => notify(e.message, true)).finally(() => setLoading(false));
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = window.storyDesk.subscribe(event => { if (event.type === 'cowriting-progress') return; if (event.type === 'warning' || event.type === 'fatal') notify(event.message, true); clearTimeout(timer); timer = setTimeout(() => { if (workRef.current) refresh().catch(() => {}); }, 200); });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [refresh, notify]);
  useEffect(() => {
    if (captionHeight !== null) void window.storyDesk.call('setWindowTheme', { theme: studioTheme }).catch(e => notify(e.message, true));
  }, [captionHeight, studioTheme, notify]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.error ? 14000 : 4500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)');
    const resize = () => setNavHidden(narrow.matches);
    narrow.addEventListener('change', resize);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && narrow.matches) setNavHidden(true); };
    window.addEventListener('keydown', escape);
    return () => { narrow.removeEventListener('change', resize); window.removeEventListener('keydown', escape); };
  }, []);
  useEffect(() => { const listener = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(s => !s); } }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, []);
  useEffect(() => { if (!search || !query.trim() || !work) { setResults([]); return; } let live = true; const t = setTimeout(() => call('search', { query }).then(r => { if (live) setResults(r); }).catch(e => notify(e.message, true)), 240); return () => { live = false; clearTimeout(t); }; }, [query, search, work?.id, call, notify]);
  async function selectWork(method: string, args?: any) {
    setBusy(n => n + 1); setSwitchingWork(true);
    try { if (!await confirmDocumentLeave()) return; ++navigationSequence.current; await window.storyDesk.flushNow(); const next = await window.storyDesk.call(method, args); if (next) { assignWork(next); setNav({ page: 'cowriting' }); setWorkspaceNav(null); setDockTabs([]); toolLocation.current = null; toolHistory.current = []; setCanGoBack(false); setWritingRequest(undefined); setCutoff(null); setSwitcher(false); setNewWork(false); setSearch(false); setQuery(''); setResults([]); setNavigating(false); } }
    catch (e: any) { notify(e.message, true); } finally { setBusy(n => n - 1); setSwitchingWork(false); }
  }
  const scopedCall = useCallback((method: string, args: any = {}) => window.storyDesk.call(method, args, work?.id || null), [work?.id]);
  const context: AppContext | null = work ? { work, cutoff, call: scopedCall, refresh, navigate, notify, act, registerDocumentLeave, confirmDocumentLeave } : null;
  const currentLabel = pageLabels[nav.page];
  const workspaceVisible = nav.page === 'cowriting' || workspaceToolPages.has(nav.page);
  const activeDock = workspaceNav ? dockId(workspaceNav) : null;
  function closeDock(item: Navigation) {
    const origin = workRef.current?.id, request = navigationSequence.current;
    void (async () => {
      if (activeDock === dockId(item) && !await confirmDocumentLeave()) return;
      await window.storyDesk.flushNow();
      if (origin !== workRef.current?.id || request !== navigationSequence.current) return;
      const remaining = dockTabs.filter(row => dockId(row) !== dockId(item));
      setDockTabs(remaining);
      if (activeDock === dockId(item)) navigate(remaining.at(-1) || { page: 'cowriting' });
    })().catch(e => notify(e.message, true));
  }
  return <div className={`app-shell studio-shell studio-${studioTheme} tabbed-studio ${navHidden ? 'studio-nav-hidden' : ''} ${workspaceVisible ? 'workspace-mode' : 'management-mode'} workspace-page-${nav.page}`}
    style={{ '--studio-caption-height': `${captionHeight || 0}px`,
      ...Object.fromEntries(Object.entries(palette).map(([role, color]) => [`--studio-${role}`, color])) } as React.CSSProperties}>
    {!!captionHeight && <div className="window-caption" aria-hidden="true"><img src={appMark} width="16" height="16" alt=""/>
      <span>章间</span>{version && <small>{version}</small>}</div>}
    {!navHidden && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setNavHidden(true)}/>}
    <aside className="sidebar">
      <nav className="studio-rail" aria-label="作品导航">
        <img className="app-mark" src={appMark} width="28" height="28" alt="章间"/>
        <div className="rail-links">{navigation.map(item => <button key={item.nav.page} className={nav.page === item.nav.page ? 'rail-active' : ''}
          title={item.label} aria-label={item.label} onClick={() => navigate(item.nav)} disabled={!work || navigating || switchingWork}><Icon name={item.icon}/></button>)}</div>
        <div className="rail-bottom">
          <button title="搜索作品资料" aria-label="打开作品搜索" disabled={!work} onClick={() => setSearch(true)}><Icon name="search"/></button>
          <button title="作品设置" aria-label="作品设置" disabled={!work || navigating} onClick={() => navigate({ page: 'settings' })}><Icon name="settings"/></button>
        </div>
      </nav>
      <div className="studio-conversations">
        <div className="studio-work-heading"><button className="work-switch" aria-label={work ? '当前作品 ' + work.name : '选择作品'} title={work?.name || '选择作品'} disabled={switchingWork} onClick={async () => {
          try { setWorks(await call('listWorks')); setSwitcher(true); } catch (error) { notify((error as Error).message, true); }
        }}><strong>{work?.name || '选择作品'}</strong><Icon name="chevron" size={14}/></button>
          <button className="sidebar-close icon-button" aria-label="收起导航" onClick={() => setNavHidden(true)}><Icon name="close" size={14}/></button></div>
        <div className="studio-conversation-host" ref={setSidebarHost}/>
        <small className="studio-version">{version ? `桌面版 ${version}` : '本地创作空间'}</small>
      </div>
    </aside>
    <main className="main-shell" inert={switchingWork} aria-busy={switchingWork}><header className="topbar">
      <div className="breadcrumb"><button aria-expanded={!navHidden} onClick={() => setNavHidden(!navHidden)}>导航</button><span>{work?.name || '作品库'}</span><Icon name="chevron" size={12}/><strong>{currentLabel}</strong></div>
      <div className="topbar-right"><button className="search-trigger" onClick={() => setSearch(true)} disabled={!work}><Icon name="search" size={16}/><span>搜索作品资料</span><kbd>Ctrl K</kbd></button>
        {!workspaceVisible && <button className="workspace-return" disabled={navigating} onClick={() => navigate(workspaceNav || { page: 'cowriting' })}>返回创作空间</button>}
        <select className="theme-select" aria-label="外观主题" value={studioTheme} onChange={event => {
          const theme = event.target.value as keyof typeof windowAppearance;
          localStorage.setItem('writing-theme', theme);
          setStudioTheme(theme);
        }}><option value="light">雾白</option><option value="paper">暖纸</option><option value="dark">夜墨</option><option value="charcoal">炭灰</option></select>
        {work && <select aria-label="查看范围" className="horizon-select" value={cutoff ?? ''} onChange={e => setCutoff(e.target.value ? Number(e.target.value) : null)}><option value="">最新正式状态</option>{[...new Set(work.documents.filter(d => d.kind === 'chapter').map(d => d.chapter).filter((n): n is number => n !== null))].sort((a,b)=>a-b).map(n => <option key={n} value={n}>截至第{n}章</option>)}</select>}
        <span className={`save-indicator ${busy || navigating ? 'working' : ''}`}><span/>{navigating ? '正在保存编辑' : busy ? '正在处理' : '本地保存'}</span></div></header>
      <div className={`page-body page-${nav.page} ${workspaceVisible ? 'workspace-body' : 'management-body'}`}>
        {loading ? <div className="startup"><span className="brand-mark">叙</span><h2>正在打开创作空间</h2><p>连接本地资料…</p></div> : !context ? <Empty title="开始你的创作" detail="接入已有作品，或创建空作品；之后直接进入创作空间。" action={<div className="actions"><button className="primary" onClick={() => selectWork('chooseWork')}><Icon name="folder"/>接入本地作品</button><button onClick={() => setNewWork(true)}>创建空作品</button><button onClick={() => selectWork('newDemoWork')}>试玩示例</button></div>}/> : <>
          <div className="persistent-workspace" hidden={!workspaceVisible}>
            <React.Suspense fallback={<Empty title="正在打开创作空间…"/>}>
              <Cowriting key={work!.id} ctx={context} initialDocumentId={writingRequest?.documentId} initialChapterNumber={writingRequest?.chapterNumber}
                navigationRequestId={writingRequest?.id} sidebarHost={sidebarHost} returnToConversation={!workspaceVisible ? () => navigate({ page: 'cowriting' }) : undefined}
                workspaceDocumentId={workspaceVisible && (workspaceNav?.page === 'reader' || workspaceNav?.page === 'attachment') ? workspaceNav.documentId : undefined}
                tool={workspaceNav ? { key: dockId(workspaceNav), label: dockLabel(work!, workspaceNav) } : undefined}
                dockTabs={dockTabs.map(item => ({ id: dockId(item), label: dockLabel(work!, item),
                  onSelect: () => navigate(item), onClose: () => closeDock(item),
                  content: <WorkspaceTools ctx={context} nav={item} active={workspaceVisible && activeDock === dockId(item)}/> }))}
                onCloseTool={() => navigate({ page: 'cowriting' })}
                onBackTool={canGoBack ? () => { const previous = toolHistory.current.at(-1); if (previous) navigate(previous, true); } : undefined}/>
            </React.Suspense>
          </div>
          {!workspaceVisible && <div className="management-page"><React.Suspense fallback={<Empty title="正在打开资料…"/>}>
            {nav.page === 'overview' ? <Overview ctx={context}/> : nav.page === 'memory' ? <MemoryCenter key={`${work!.id}-${nav.quote || ''}`} ctx={context} initialQuery={nav.quote}/>
                : <Settings key={work!.id} ctx={context}/>} </React.Suspense></div>}
        </>}
      </div>
    </main>
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status"><Icon name={toast.error ? 'info' : 'check'}/><span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><Icon name="close" size={14}/></button></div>}
    {switcher && <Modal title="作品库" subtitle="每部作品使用独立的资料与归档记录" onClose={() => setSwitcher(false)}><div className="work-list">{works.map(w => <button className="work-entry" key={w.id} disabled={switchingWork} onClick={() => selectWork('openWork', { id: w.id })}><span className="work-cover">{w.name.slice(0,1)}</span><span><strong>{w.name}</strong><small>{w.root}</small></span>{work?.id === w.id && <Badge status="confirmed">当前</Badge>}</button>)}</div><div className="modal-footer"><button onClick={() => selectWork('chooseWork')}><Icon name="folder"/>接入目录</button><button className="primary" onClick={() => { setSwitcher(false); setNewWork(true); }}><Icon name="plus"/>创建空作品</button></div></Modal>}
    {search && <Modal title="搜索作品资料" subtitle="支持中文短词、人名、别名和正文片段" onClose={() => setSearch(false)} wide><div className="large-search"><Icon name="search"/><input autoFocus placeholder="搜索人物、章节、功法或一句正文…" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="search-results">{results.map(r => <button className="search-result" key={r.id} onClick={() => { navigate(r.kind==='memory'?{page:'memory',quote:query}:r.kind==='event'?{page:'updates'}:{ page: 'reader', documentId: r.id, quote: query }); setSearch(false); }}><div><Badge>{kindLabels[r.kind] || r.kind}</Badge><strong>{r.title}</strong></div><p>{r.excerpt}</p><small>{r.path}</small></button>)}{query && !results.length && <Empty title="没有找到匹配内容" detail="可以尝试完整姓名，或更短的一段文字。"/>}</div></Modal>}
    {newWork && <Modal title="创建空作品" subtitle="程序会在选择的位置创建同名作品文件夹。" onClose={() => setNewWork(false)}><label>作品名称<input autoFocus value={newWorkName} onChange={e => setNewWorkName(e.target.value)}/></label><div className="modal-footer"><button onClick={() => setNewWork(false)}>取消</button><button className="primary" disabled={!newWorkName.trim()} onClick={() => selectWork('newWork', { name: newWorkName })}>选择位置并创建</button></div></Modal>}
  </div>;
}
