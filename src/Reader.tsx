import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import type { AppContext, Navigation, SourceDocument } from './domain';
import { documentKindLabel, dateText } from './domain';
import { DiscussionComposer, ReferenceButton } from './DiscussionReference';
import { Icon, Badge, Empty, Modal, Markdown } from './components';
import {ObligationGate} from './ObligationGate';
import { ClassifyMaterial, pendingLibraryDoc, worldKinds } from './WorldSources';
import { SettingInfo } from './SettingInfo';
import { RevealSourceButton } from './LocalFileActions';
import { DraftImport, NewChapterDraft, isImportedLibraryText } from './DraftImport';
import { ManuscriptEditor, type ManuscriptSelection } from './ManuscriptEditor';
import { WorkspaceActionReview } from './WorkspaceActionReview';
import { ReaderVersions, type ReaderVersion } from './ReaderVersions';
import windowAppearance from '../core/window-appearance.json';

const normalized = (text: string) => text.replace(/\r\n?/gu, '\n');
const emptyAgentMarks: NonNullable<SourceDocument['agentEdits']> = [];
type ReadingTheme = 'follow' | 'light' | 'paper' | 'dark';

function ReaderMenu({ title, icon, children }: {
  title: string; icon: string; children: (close: () => void) => React.ReactNode;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={event => {
      const panel = popup.current;
      if (!panel) return;
      if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
      const button = event.currentTarget.getBoundingClientRect();
      const width = Math.min(326, window.innerWidth - 20);
      const roomBelow = window.innerHeight - button.bottom;
      const above = roomBelow < 200 && button.top > roomBelow;
      Object.assign(panel.style, {
        width: `${width}px`, left: `${Math.max(10, Math.min(button.right - width, window.innerWidth - width - 10))}px`,
        top: above ? 'auto' : `${button.bottom + 6}px`, bottom: above ? `${window.innerHeight - button.top + 6}px` : 'auto',
        maxHeight: `${Math.max(80, (above ? button.top : roomBelow) - 16)}px`,
      });
      panel.showPopover({ source: event.currentTarget });
    }}><Icon name={icon} size={15}/>{title}</button>
    <div id={id} ref={popup} className="reader-popover" popover="auto" aria-label={title}
      onToggle={e => setOpen(e.currentTarget.matches(':popover-open'))}>
      {children(() => popup.current?.hidePopover())}
    </div>
  </>;
}

export function ConfirmPanel({ ctx, document: doc, onClose, onPublished }: { ctx: AppContext; document: SourceDocument;
  onClose: () => void; onUpdated?: (d:SourceDocument)=>void; onPublished?: () => void }) {
  const prose = ['chapter', 'draft'].includes(doc.kind);
  const publishing = doc.kind === 'draft';
  const [kind, setKind] = useState(prose ? 'prose' : doc.kind === 'character' ? 'baseline' : doc.kind === 'plan' ? 'plan' : 'ruling');
  const [continuation, setContinuation] = useState(!!ctx.work.settings.gate.enabled && (doc.chapter || 0) > 1);
  const [pair, setPair] = useState(doc.chapter && doc.chapter > 1 ? `第${doc.chapter-1}章 → 第${doc.chapter}章` : '');
  const [card, setCard] = useState(ctx.work.settings.gate.defaultCard || '');
  const [report, setReport] = useState<any>([...ctx.work.checks].reverse().find(c => c.documentId === doc.id && c.sourceHash === doc.hash));
  const [sceneId, setSceneId] = useState(''); const [busy, setBusy] = useState(false);
  const chapterOutline = kind === 'plan' && doc.chapterMaterial?.role === 'design' && !sceneId;
  const activeOutline = chapterOutline && ctx.work.chapterOutlines?.find(row => row.chapter === doc.chapterMaterial?.chapter);
  const replacedOutline = activeOutline && activeOutline.documentId !== doc.id
    ? ctx.work.documents.find(d => d.id === activeOutline.documentId)?.title : null;
  const [legacy, setLegacy] = useState(false); const [metricsReviewed, setMetricsReviewed] = useState(false);
  const [obligationsPassed, setObligationsPassed] = useState(false);
  async function check() { setBusy(true); setMetricsReviewed(false); const r = await ctx.act(() => ctx.call('checksFor', { documentId: doc.id, continuation, pair, card, legacy })); if (r) setReport(r); setBusy(false); }
  async function confirm() {
    setBusy(true);
    const r = await ctx.act(() => chapterOutline
      ? ctx.call('confirmChapterOutline', { documentId: doc.id, expectedHash: doc.hash })
      : ctx.call('confirmRevision', { documentId: doc.id, sourceHash: doc.hash, kind,
        sceneId: sceneId || null, reviewPlot: kind === 'prose', publishDraft: publishing }),
      chapterOutline ? '章纲已定案，供本章创作读取' : publishing ? '已发布为正式正文，资料变化将进入章节核对' :
        kind === 'prose' ? '这一版本已确认，资料变化将进入章节核对' : '这一版本已确认，归档任务已登记');
    setBusy(false);
    if (!r) return;
    onClose();
    if (publishing) { ctx.navigate({ page: 'reader', documentId: doc.id }); onPublished?.(); }
    else if (kind === 'prose') ctx.navigate({ page: 'plot', tab: 'review', documentId: doc.id });
  }
  return <Modal title={publishing ? '核对并发布章节' : '确认这一版本'} subtitle={publishing ? '核对通过后，将按当前草稿版本发布整章正文。' : '确认绑定当前文件内容，后续修改会成为新的修订版本。'} onClose={onClose} wide><div className="confirm-summary"><div><Badge>{documentKindLabel(doc)}</Badge><h3>{doc.title}</h3><small>{doc.path}</small></div><Icon name="shield" size={30}/></div>
    {!publishing && <div className="form-grid"><label>确认类型<select value={kind} onChange={e => { setKind(e.target.value); setReport(null); }}>{prose && <option value="prose">成稿确认 · 已发生剧情</option>}<option value="plan">剧情设计定案 · 尚未发生</option><option value="baseline">整理人物基座 · 全部待审核</option><option value="ruling">设定材料确认 · 变更待审核</option></select></label><label>确认范围<select value={sceneId} onChange={e => setSceneId(e.target.value)}><option value="">整份文档</option>{ctx.work.scenes.filter(s => s.documentId === doc.id && s.sourceHash === doc.hash).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>}
    {kind === 'prose' && <div className="gate-form"><label className="check-label"><input type="checkbox" checked={continuation} onChange={e => { setContinuation(e.target.checked); setReport(null); }}/>参考承接计划（仅提醒，不阻断确认）</label><p className="muted">计划中的章序、人物出场与内容可以调整，以你确认的正文为准。未选参考卡时也可检查和确认。</p>{continuation && <div className="form-grid"><label>参考章节／场次（可选）<input placeholder="如第1章 → 第2章，或完整参考小节标题" value={pair} onChange={e => { setPair(e.target.value); setReport(null); }}/></label><label>参考卡相对路径<input value={card} onChange={e => { setCard(e.target.value); setReport(null); }}/></label></div>}
      {ctx.work.settings.gate.enabled&&<label className="check-label"><input type="checkbox" checked={legacy} onChange={e=>{setLegacy(e.target.checked);setReport(null);}}/>存量稿复检（使用既有稿口径）</label>}<button disabled={busy} onClick={check}><Icon name="shield"/>运行当前版本检查</button>{report && <button className="text-button"
        onClick={() => { onClose(); ctx.navigate({ page: 'manuscript', documentId: doc.id }); }}>在稿件核对中查看与修改</button>}{report && <div className="gate-report">{report.gatePolicyVersion!==2?<div className="notice warning">这是旧规则的检查结果。承接计划现已改为提醒，请重新运行当前版本检查。</div>:<><div className="panel-heading"><strong>文风与数据完整性</strong><Badge status={report.status}/></div>{report.status==="failed"&&<div className="notice danger">{(report.coreOutput||report.output).split("\n").filter((l:string)=>l.trim().startsWith("✗")).slice(0,5).join("\n")}</div>}{report.carry&&<section className="notice warning carry-notice" aria-label="承接计划提醒"><strong>承接计划 · 仅提醒</strong><p>{report.carry.message}</p>{report.carry.selectedTitle&&<p>参考小节：{report.carry.selectedTitle}</p>}{report.carry.scopeWarning&&<p>{report.carry.scopeWarning}</p>}<small>姓名对照无法区分正面出场与他人提及；计划差异由作者裁定，不作为词语修订的硬要求。</small></section>}</>}<details><summary>展开原始检查报告与量化指标</summary><pre>{report.output.split("\n").filter((l:string)=>!l.startsWith("STORYDESK_GATE_JSON:")).join("\n")}</pre></details></div>}
    </div>}
    {kind==='prose'&&<ObligationGate ctx={ctx} documentId={doc.id} sceneId={sceneId} onState={setObligationsPassed} onOpen={()=>{onClose();ctx.navigate({page:'obligations',documentId:doc.id});}}/>}
    {kind==="prose"&&ctx.work.settings.gate.enabled&&report&&<label className="check-label"><input type="checkbox" checked={metricsReviewed} onChange={e=>setMetricsReviewed(e.target.checked)}/>已查看量化指标、软线与承接报告，确认本版可以归档</label>}{!chapterOutline && !ctx.work.writingModel.enabled && <div className="notice">模型尚未启用。你仍可确认版本，任务会在更新中心等待配置，不会发送材料。</div>}
    {kind === 'plan' && <div className="notice">定案供规划和写作参考。已发生的剧情以确认正文为准。</div>}
    {replacedOutline && <div className="notice warning">确认后，本章定案将从「{replacedOutline}」切换到这份设计。</div>}
    <div className="modal-footer"><button onClick={onClose}>返回核对</button><button className="primary" disabled={busy || (kind === 'prose' && (!obligationsPassed || report?.gatePolicyVersion!==2 || !['passed','not_required'].includes(report?.status) || (ctx.work.settings.gate.enabled&&!metricsReviewed)))} onClick={confirm}><Icon name="check"/>{busy ? '正在处理…' : publishing ? '发布为正文' : chapterOutline ? '确认章纲定案' : '确认版本并登记归档'}</button></div>
  </Modal>;
}

export function Reader({ ctx, nav }: { ctx: AppContext; nav: Navigation }) {
  const composer = useContext(DiscussionComposer);
  const chapters = ctx.work.documents.filter(d => d.kind === 'chapter');
  const [id, setId] = useState(nav.documentId || ctx.work.reader.documentId || chapters[0]?.id || '');
  const [doc, setDoc] = useState<SourceDocument | null>(null); const [text, setText] = useState(''); const [saved, setSaved] = useState('');
  const [editing, setEditing] = useState(false); const [confirm, setConfirm] = useState(false); const [versions, setVersions] = useState('');
  const [classify, setClassify] = useState(false);
  const [importAsDraft, setImportAsDraft] = useState(false);
  const [archiveFile, setArchiveFile] = useState(false);
  const [setting, setSetting] = useState(false);
  const [history, setHistory] = useState<{ id: string; versions: { hash: string; saved_at: string }[] }>();
  const [fontSize, setFontSize] = useState<number>(ctx.work.reader.fontSize || 19);
  const [lineHeight, setLineHeight] = useState<number>(ctx.work.reader.lineHeight || 2.1);
  const savedTheme: unknown = ctx.work.reader.theme;
  const [theme, setTheme] = useState<ReadingTheme>(savedTheme === 'paper' || savedTheme === 'dark' ||
    (savedTheme === 'light' && ctx.work.reader.themeExplicit) ? savedTheme : 'follow');
  const [loading, setLoading] = useState(false); const [sceneModal, setSceneModal] = useState(false); const [sceneName, setSceneName] = useState(''); const [sceneQuote, setSceneQuote] = useState('');
  const [newDoc, setNewDoc] = useState(nav.newChapterNumber !== undefined);
  const [saving, setSaving] = useState(false); const dirty = text !== saved; const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const aiWriting = composer?.writingDocumentId === doc?.id && !!doc;
  const canEdit = !!doc && !doc.readOnly && !doc.historical && !doc.generated;
  const inlineEditing = canEdit && !nav.quote && !nav.sourceLine;
  const [agentMarks, setAgentMarks] = useState<{ hash: string; marks: NonNullable<SourceDocument['agentEdits']>; canUndo: boolean }>();
  const [undoingEdit, setUndoingEdit] = useState(false);
  const reader = useRef<HTMLDivElement>(null), article = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftState = useRef<any>(null); draftState.current = dirty && doc ? { documentId: doc.id, text, baseHash: doc.hash } : null;
  useEffect(() => {
    const flush = async () => { if (draftTimer.current) clearTimeout(draftTimer.current); if (draftState.current) await ctx.call('setDraft', draftState.current); };
    const remove = window.storyDesk.onFlush(flush);
    return () => { remove(); flush().catch(() => {}); };
  }, [ctx.work.id]);
  function choose(next: string) {
    if (next !== id) {
      const picked = ctx.work.documents.find(d => d.id === next);
      ctx.navigate({ page: picked?.kind === 'attachment' ? 'attachment' : 'reader', documentId: next });
    }
  }
  useEffect(() => { if (nav.documentId) setId(nav.documentId); }, [nav.documentId]);
  useEffect(() => {
    if (!id) return; let active = true; setLoading(true);
    ctx.call('readDocument', { documentId: id }).then(d => { if (!active) return; setDoc(d); setText(normalized(d.text)); setSaved(normalized(d.text)); setEditing(false); if (article.current) article.current.scrollTop = ctx.work.reader.documentId === id ? ctx.work.reader.offset || 0 : 0; }).catch(e => { if (active) { setDoc(null); ctx.notify(e.message, true); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, ctx.work.id]);
  const diskDocument = ctx.work.documents.find(d => d.id === id);
  const diskHash = diskDocument?.hash, diskPath = diskDocument?.path;
  useEffect(()=>{let live=true;if(doc&&diskHash&&(doc.hash!==diskHash || doc.path!==diskPath)&&!dirtyRef.current)ctx.call('readDocument',{documentId:id}).then(d=>{if(live&&!dirtyRef.current){setDoc(d);setText(normalized(d.text||''));setSaved(normalized(d.text||''));}}).catch(e=>ctx.notify(e.message,true));return()=>{live=false;};},[id,diskHash,diskPath]);
  useEffect(() => {
    if (doc?.kind !== 'draft' || doc.historical) return;
    let current = true;
    ctx.call('getWorkspaceDraftEdit', { documentId: doc.id, sourceHash: doc.hash }).then(result => {
      if (current) setAgentMarks({ hash: doc.hash, ...result });
    }).catch(() => {});
    return () => { current = false; };
  }, [ctx.call, doc?.id, doc?.hash, doc?.kind, doc?.historical]);
  useEffect(() => {
    if (!doc || doc.historical || doc.readOnly) return;
    let active = true;
    ctx.call('versions', { documentId: doc.id }).then(versions => {
      if (active) setHistory({ id: doc.id, versions });
    }).catch(() => {});
    return () => { active = false; };
  }, [doc?.id, doc?.hash, doc?.historical, doc?.readOnly]);
  useEffect(() => { if (!dirty || !doc) return; const t = setTimeout(() => ctx.call('setDraft', { documentId: doc.id, text, baseHash: doc.hash }).catch(e => ctx.notify(e.message, true)), 1200); draftTimer.current = t; return () => clearTimeout(t); }, [text, dirty, doc?.id]);
  async function save() {
    if (!dirty) return true;
    if (!doc || !canEdit || saving || aiWriting) return false;
    setSaving(true);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const result = await ctx.act(() => ctx.call('saveDocument', { documentId: doc.id, expectedHash: doc.hash, text }),
      doc.kind === 'chapter' && ['confirmed', 'revising'].includes(doc.status) ? '已保存正文修订，等待重新核对确认' : '已写入本地文件并保留快照');
    if (result) { setDoc(result.document); setSaved(text); dirtyRef.current = false; draftState.current = null; }
    setSaving(false);
    return !!result;
  }
  const leave = useRef<() => Promise<boolean>>(async () => true);
  leave.current = async () => {
    if (!dirtyRef.current) return true;
    if (!window.confirm(`《${doc?.title || '当前稿件'}》有修改。确认保存后切换？取消可留在原稿撤销或继续修改。`)) return false;
    return save();
  };
  useEffect(() => ctx.registerDocumentLeave(id, () => leave.current()), [ctx.registerDocumentLeave, id]);
  function changeText(value: string) {
    if (aiWriting || saving) return;
    setText(value);
    if (doc && dirty && value === saved) void ctx.call('clearDraft', { documentId: doc.id }).catch(() => {});
  }
  function quoteSelection(selection: ManuscriptSelection) {
    if (!doc || dirty || !composer?.ready) return;
    composer.attach({ kind: 'document', id: doc.id, title: doc.title, hash: doc.hash, selection });
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && reader.current?.getClientRects().length &&
          e.target instanceof Node && reader.current.contains(e.target)) {
        e.preventDefault(); void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, text, saved, editing, saving, aiWriting]);
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current); }, []);
  async function undoAgentEdit() {
    if (!doc || dirty || aiWriting || undoingEdit) return;
    setUndoingEdit(true);
    try {
      await window.storyDesk.flushNow();
      const result = await ctx.act(() => ctx.call('undoCowritingDraftEdit', { documentId: doc.id, sourceHash: doc.hash }),
        '已撤回本次修改，可从原对话再次应用。');
      if (result) {
        setDoc(result.document);
        setText(normalized(result.document.text));
        setSaved(normalized(result.document.text));
        composer?.onDraftEdit();
      }
    } catch (error) { ctx.notify((error as Error).message, true); }
    finally { setUndoingEdit(false); }
  }
  const remember = (offset = article.current?.scrollTop || 0) => { if (!doc || doc.readOnly) return; ctx.call('rememberReader', { documentId: doc.id, offset, fontSize, theme, themeExplicit: true, lineHeight }).catch(() => {}); };
  const currentIndex = chapters.findIndex(c => c.id === id);
  const related = doc ? ctx.work.characters.filter(c => [c.name, ...c.aliases].some(n => n && text.includes(n))) : [];
  const relatedEvents = ctx.work.events.filter(e => e.source_document_id === id && !e.superseded);
  const raw = doc?.text || '';
  const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const requestedSource = !nav.documentId || nav.documentId === doc?.id;
  const updatedSource = requestedSource && nav.sourceHash && doc && nav.sourceHash !== doc.hash;
  const evidenceQuote = requestedSource && !updatedSource ? nav.quote : undefined;
  const line = evidenceQuote && nav.sourceLine ? nav.sourceLine - raw.slice(0, raw.length - content.length).split('\n').length + 1 : undefined;
  const prose = doc && !doc.historical && ['chapter', 'draft'].includes(doc.kind);
  const isDraft = doc?.kind === 'draft';
  const isChapter = doc?.kind === 'chapter';
  const recovery = doc?.draft && normalized(doc.draft.text) !== saved ? doc.draft : undefined;
  const canPublish = isDraft && doc.chapter && !chapters.some(chapter => chapter.chapter === doc.chapter);
  const canArchive = !!doc && canEdit && (isDraft || isImportedLibraryText(doc)) &&
    !ctx.work.approvals.some(item => item.documentId === doc.id && item.status === 'active');
  const comparison: ReaderVersion[] = [];
  if (doc && !doc.historical) {
    if (recovery) comparison.push({ key: 'recovery', kind: 'recovery', label: `恢复草稿 · ${dateText(recovery.saved_at)}`, text: recovery.text });
    if (history?.id === doc.id) for (const item of history.versions) {
      if (item.hash !== doc.hash) comparison.push({ key: item.hash, kind: 'snapshot', hash: item.hash, label: `历史版本 · ${dateText(item.saved_at)} · ${item.hash.slice(0, 7)}` });
    }
    if (prose && doc.chapter) {
      for (const draft of ctx.work.documents.filter(item => item.kind === 'draft' && item.chapter === doc.chapter && item.id !== doc.id &&
        item.hash !== doc.hash && !item.error && !item.historical && !ctx.work.hiddenChapterMaterials?.includes(item.id))) {
        comparison.push({ key: draft.id, kind: 'draft', documentId: draft.id, hash: draft.hash, label: `同章备选稿 · ${draft.path.split('/').at(-1)}` });
      }
    }
  }
  const showDirectory = isChapter || !doc && !nav.documentId;
  const readingPalette = theme === 'light' || theme === 'paper' || theme === 'dark' ? windowAppearance[theme] : null;
  return <div ref={reader} className={`reader-layout${showDirectory ? ' reader-has-directory' : ''}`}
    style={readingPalette ? {
      '--reading-surface': readingPalette.paper, '--reading-ink': readingPalette.ink, '--reading-ground': readingPalette.ground,
      '--reading-muted': readingPalette.muted, '--reading-accent': readingPalette.accent, '--reading-selection': readingPalette.selection,
    } as React.CSSProperties : undefined}>
    {showDirectory && <aside className="chapter-pane"><div className="pane-heading"><strong>正文目录</strong><button className="icon-button" aria-label="新建章节" onClick={() => setNewDoc(true)}><Icon name="plus"/></button></div>
      <div className="chapter-list">{chapters.map(d => <button className={`chapter-entry ${id === d.id ? 'selected' : ''}`} key={d.id} onClick={() => choose(d.id)}><span className="chapter-number">{String(d.chapter || '·').padStart(2,'0')}</span><span><strong>{d.title.replace(/^第[^章]+章\s*/, '')}</strong><small>{d.external ? '外部修改待核对' : d.status === 'confirmed' ? '已确认版本' : d.status === 'revising' ? '修订中' : '定稿状态待确认'}</small></span>{d.status === 'confirmed' && <span className="tiny-check"><Icon name="check" size={13}/></span>}</button>)}</div>
    </aside>}
    <section className="reading-center"><div className="reader-toolbar">
      <div className="reader-status"><Badge>{doc ? documentKindLabel(doc) : '正文'}</Badge>{doc && !isDraft && <Badge status={diskDocument?.status || doc.status}/>}
        {doc?.readOnly && <Badge>只读来源</Badge>}{dirty && <span className="unsaved">修改待确认</span>}
        {aiWriting && <span className="studio-muted" role="status">Agent 正在写入此稿</span>}</div>
      <div className="actions" role="group" aria-label="文稿工具">
        {dirty && inlineEditing && <button className="primary" disabled={saving || aiWriting} onClick={save}>
          <Icon name="save"/>{saving ? '保存中' : '保存'}
        </button>}
        {editing ? <>
          <button onClick={() => setEditing(false)}>返回文稿</button>
          {!inlineEditing && <button className="primary" disabled={!dirty || saving} onClick={save}><Icon name="save"/>{saving ? '保存中' : '保存'}</button>}
        </> : <>
          {!inlineEditing && canEdit && <button onClick={() => setEditing(true)}><Icon name="edit"/>编辑</button>}
          {doc && !doc.historical && !doc.generated && <ReferenceButton item={{ kind: 'document', id: doc.id, hash: doc.hash, title: doc.title }}/>}
          {(prose || nav.reviewDocumentId) && <button className="primary subtle" onClick={() => ctx.navigate({
            page: 'manuscript', documentId: nav.reviewDocumentId || doc?.id, reviewRequestId: nav.reviewDocumentId ? undefined : crypto.randomUUID(),
            reviewIssueId: nav.reviewIssueId, reviewPane: nav.reviewPane
          })}>
            <Icon name="shield"/>{nav.reviewDocumentId ? '返回稿件核对' : '稿件核对'}
          </button>}
          {doc && isImportedLibraryText(doc) && !doc.historical &&
            <button disabled={dirty || aiWriting} onClick={() => setImportAsDraft(true)}>存为章节草稿</button>}
          {doc && canEdit && !isDraft && !isImportedLibraryText(doc) &&
            <button disabled={dirty || aiWriting} onClick={() => setConfirm(true)}><Icon name="check"/>确认版本</button>}
        </>}
          {agentMarks?.hash === doc?.hash && agentMarks?.canUndo && <button type="button" className="reader-undo-edit"
            disabled={dirty || aiWriting || saving || undoingEdit} onClick={() => void undoAgentEdit()}>
            <Icon name="undo"/>{undoingEdit ? '正在撤回…' : '撤回本次修改'}
          </button>}
        {doc && <ReaderMenu title="阅读设置" icon="settings">{close => <>
          <div className="reader-option"><span>字号</span><div className="reader-font-buttons">
            <button type="button" aria-label="缩小字号" disabled={fontSize <= 14} onClick={() => setFontSize(n => Math.max(14, n - 1))}>A−</button>
            <output aria-label="当前字号">{fontSize}</output>
            <button type="button" aria-label="放大字号" disabled={fontSize >= 30} onClick={() => setFontSize(n => Math.min(30, n + 1))}>A＋</button>
          </div></div>
          <label className="reader-option">阅读配色<select value={theme} onChange={e => setTheme(e.target.value as ReadingTheme)}>
            <option value="follow">跟随工作台</option><option value="light">雾白</option><option value="paper">暖纸</option><option value="dark">夜墨</option>
          </select></label>
          <label className="reader-option">行距<select value={lineHeight} onChange={e => setLineHeight(Number(e.target.value))}>
            <option value="1.8">紧凑</option><option value="2.1">舒适</option><option value="2.5">宽松</option>
          </select></label>
          {!doc.readOnly && <button type="button" onClick={() => { remember(); close(); }}>记住阅读设置</button>}
        </>}</ReaderMenu>}
        {doc && <ReaderMenu title="稿件资料" icon="info">{close => <>
          {!!related.length && prose && <section className="reader-info-section" aria-label="本章相关人物">
            <h3>本章相关人物</h3>
            <div className="reader-people">{related.map(c => <button key={c.id} type="button" onClick={() => {
              close(); ctx.navigate({ page: 'characters', characterId: c.id });
            }}>{c.name}</button>)}</div>
          </section>}
          {isChapter && !doc.historical && (relatedEvents.length > 0 || canEdit) && <section className="reader-info-section">
            {!!relatedEvents.length && <><h3>归档事件</h3>{relatedEvents.map(event => <p key={event.id}>{event.title}</p>)}</>}
            {canEdit && <button type="button" disabled={editing || dirty} onClick={() => { close(); setSceneModal(true); }}>划分确认场景</button>}
          </section>}
          <section className="reader-info-section">
            <h3>本地来源</h3><p className="reader-source-path">{doc.path}</p><small>{dateText(doc.modified)}</small>
            {(!doc.historical || doc.archiveAvailable) && <RevealSourceButton ctx={ctx} documentId={doc.id} compact/>}
            {!doc.readOnly && pendingLibraryDoc(doc) && <button type="button" disabled={editing} onClick={() => { close(); setClassify(true); }}>归类本库资料</button>}
            {!doc.readOnly && worldKinds.includes(doc.kind) && <button type="button" disabled={editing} onClick={() => { close(); setSetting(true); }}>核对设定</button>}
          </section>
        </>}</ReaderMenu>}
        {doc && (comparison.length > 0 || canEdit) && <ReaderMenu title="更多" icon="dots">{close => <div className="reader-menu-actions">
          {inlineEditing && !editing && <button type="button" onClick={() => { close(); setEditing(true); }}>Markdown 源文</button>}
          {!!comparison.length && !editing && <button type="button" onClick={() => { close(); setVersions(comparison[0].key); }}><Icon name="clock"/>版本比较</button>}
          {canEdit && canPublish && <button type="button" disabled={dirty || aiWriting || editing}
            onClick={() => { close(); setConfirm(true); }}><Icon name="check"/>核对并发布</button>}
          {isChapter && canEdit && !editing && <button type="button" onClick={() => { close(); ctx.navigate({ page: 'cowriting', documentId: doc.id }); }}>创作本章</button>}
          {canArchive && <button type="button" disabled={dirty || aiWriting} onClick={() => { close(); setArchiveFile(true); }}>归档此文件</button>}
        </div>}</ReaderMenu>}
      </div></div>
      {dirty && diskHash && doc && diskHash !== doc.hash && <div className="notice warning">磁盘上的稿件已有新版本，当前手改保留在编辑区。请对照版本后再合并。</div>}
      {doc && recovery && !dirty && !editing && <div className="notice inline-notice">发现{dateText(recovery.saved_at)}的恢复草稿。<button className="text-button" onClick={() => { if (recovery.baseHash !== doc.hash) { setVersions('recovery'); } else { setText(normalized(recovery.text)); if (!inlineEditing) setEditing(true); } }}>查看 / 恢复</button><button className="text-button" onClick={async () => { await ctx.call('clearDraft', { documentId: id }); setDoc({ ...doc, draft: undefined }); }}>丢弃</button></div>}
      {ctx.work.externalChanges[id] && <div className="notice inline-notice">源文件有外部修改，归档写回已暂停。<button className="text-button" onClick={async () => { await window.storyDesk.flushNow(); const latest = await ctx.call('readDocument', { documentId: id }); setDoc(latest); setText(normalized(latest.text)); setSaved(normalized(latest.text)); }}>读取最新内容</button><button className="text-button" onClick={() => ctx.act(() => ctx.call('acknowledgeExternal', { documentId: id, expectedHash: doc?.hash }), '已保留外部修改，相关字段已保护')}>已核对并保留</button></div>}
      {doc?.historical && <div className="notice inline-notice">
        <span>{doc.reason}</span>
        {doc.archiveAvailable && <button className="text-button" onClick={() => ctx.act(() => ctx.call('openSource', { documentId: doc.id }))}>打开归档文件</button>}
        {doc.evidencePath && <small>出处 · {doc.evidencePath}</small>}
        {!doc.snapshotAvailable && !doc.archiveAvailable && <span>现存记录保留了原路径和处置依据。</span>}
      </div>}
      {updatedSource ? <div className="notice warning">引用的文件已有新版本，请重新核对后定位。</div>
        : evidenceQuote && <div className="evidence-locator"><Icon name="link" size={14}/><span>{nav.sourceLine ? `第 ${nav.sourceLine} 行 · ` : '来自关联资料 · '}{evidenceQuote.slice(0,100)}</span>
          {!doc?.readOnly && <button className="text-button" onClick={() => setEditing(true)}>在源码中核对</button>}</div>}
      {loading ? <Empty title="正在打开本地文档…"/> : !doc ? <Empty title={chapters.length ? '选择一章开始阅读' : '尚未找到正文'}
      detail={chapters.length ? '也可以从资料库打开设定和人物原文。' : '检查作品设置中登记的正文位置。'}
      action={!chapters.length && <button onClick={() => ctx.navigate({ page: 'settings' })}>检查资料位置</button>}/> : inlineEditing || editing ? <>
        {!dirty && agentMarks?.hash === doc.hash && !!agentMarks.marks.length && <div className="manuscript-edit-legend">高亮为本次修改的位置</div>}
        <ManuscriptEditor key={doc.id} text={text} onChange={changeText} raw={editing} locked={aiWriting || saving || !canEdit}
          marks={!dirty && agentMarks?.hash === doc.hash ? agentMarks.marks : emptyAgentMarks}
          revealHash={nav.draftEditHash === doc.hash ? nav.draftEditHash : undefined}
          onQuote={composer?.ready && !dirty && !doc.historical ? quoteSelection : undefined} fontSize={fontSize} lineHeight={lineHeight}/>
      </> : <div className="reading-scroll" ref={article} onScroll={() => { if (scrollTimer.current) clearTimeout(scrollTimer.current); scrollTimer.current = setTimeout(() => remember(), 650); }}><article className="reading-paper" style={{ fontSize, lineHeight }}><div className="chapter-eyebrow">{doc.kind === 'chapter' ? `CHAPTER ${String(doc.chapter).padStart(2,'0')}` : documentKindLabel(doc)}</div><Markdown text={content} quote={evidenceQuote} sourceLine={line} onLink={href => { if (ctx.work.settingMeta?.[id]?.research && /^https?:\/\//i.test(href)) { void ctx.call('openWebSource', { url: href }).catch(error => ctx.notify(error.message, true)); return; } const file = href.replace(/[#?].*$/, '').split(/[\\/]/).pop(); const match = ctx.work.documents.find(d => d.path.split('/').pop() === file); if (match) choose(match.id); else ctx.notify('该链接未登记到本作品；可以从资料库查看相关文件。'); }}/></article>{isChapter && <div className="chapter-navigation"><button disabled={currentIndex <= 0} onClick={() => choose(chapters[currentIndex-1].id)}>← 上一章</button><button disabled={currentIndex < 0 || currentIndex >= chapters.length-1} onClick={() => choose(chapters[currentIndex+1].id)}>下一章 →</button></div>}</div>}
    </section>
    {confirm && doc && <ConfirmPanel ctx={ctx} document={doc} onClose={() => setConfirm(false)} onUpdated={d=>{setDoc(d);setText(d.text||"");setSaved(d.text||"");}}/>}
    {archiveFile && doc && <WorkspaceActionReview ctx={ctx} action={{ type: 'archive',
      files: [{ documentId: doc.id, sourceHash: doc.hash, title: doc.title, path: doc.path, kind: doc.kind }] }}
      onClose={() => setArchiveFile(false)} onApplied={() => { setArchiveFile(false); ctx.navigate({ page: 'reader', tab: 'draft' }); }}/>}
    {importAsDraft && doc && <DraftImport ctx={ctx} initialDocument={doc}
      chapter={doc.draftChapterHint || ctx.work.nextChapter || ctx.work.stats.latestFile + 1}
      onClose={() => setImportAsDraft(false)}
      onSaved={draft => {
        composer?.replaceDocument(doc.id, { kind: 'document', id: draft.id, hash: draft.hash, title: draft.title });
        setImportAsDraft(false); ctx.navigate({ page: 'reader', documentId: draft.id });
      }}/>}
    {classify && doc && <ClassifyMaterial ctx={ctx} doc={doc} onClose={() => setClassify(false)} onClassified={d => setDoc({ ...doc, ...d })}/>}
    {setting && doc && <SettingInfo ctx={ctx} initialDocumentId={doc.id} onClose={() => setSetting(false)}/>}
    {versions && doc && <ReaderVersions key={doc.id} ctx={ctx} document={doc} currentText={saved} options={comparison} initial={versions}
      restoreBlocked={dirty || aiWriting || saving || !canEdit}
      onClose={() => setVersions('')} onRestore={old => {
        setText(old); if (!inlineEditing) setEditing(true); setVersions('');
      }}/>}
    {sceneModal && doc && <Modal title="划分确认场景" subtitle="粘贴本稿中一段完整、唯一、连续的原文；不得与已有场景重叠。" onClose={() => setSceneModal(false)}><label>场景名称<input value={sceneName} onChange={e=>setSceneName(e.target.value)}/></label><label>场景原文<textarea rows={10} value={sceneQuote} onChange={e=>setSceneQuote(e.target.value)}/></label><div className="modal-footer"><button onClick={()=>setSceneModal(false)}>取消</button><button className="primary" onClick={async()=>{const r=await ctx.act(()=>ctx.call('addScene',{documentId:id,name:sceneName,quote:sceneQuote}),'场景已登记');if(r)setSceneModal(false);}}>保存场景范围</button></div></Modal>}
    {newDoc && <NewChapterDraft ctx={ctx} chapter={nav.newChapterNumber ?? ctx.work.nextChapter ?? ctx.work.stats.latestFile + 1}
      onClose={() => setNewDoc(false)} onSaved={draft => {
        setNewDoc(false); ctx.navigate({ page: 'reader', documentId: draft.id });
      }}/>}
  </div>;
}
