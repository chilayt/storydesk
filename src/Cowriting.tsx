import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppContext, SourceDocument } from './domain';
import { dateText } from './domain';
import { Icon, Markdown, Modal } from './components';
import { RevisionPanel } from './RevisionPanel';
import { CreativeTasks, writingScopes } from './CreativeTasks';
import { WritingContext } from './WritingContext';
import { WritingCanvas } from './WritingCanvas';
import type { WritingSelection } from './WritingCanvas';
import { TrialCompare } from './TrialCompare';
import { VoiceInput, type VoicePhase } from './VoiceInput';
import writingLimits from '../core/writing-input-limits.json';
import { StagePlanCard, StageProgress } from './StagePlans';
import { ChapterMaterials } from './ChapterMaterials';
import type { CreativeTask, DiscussionReference, DraftAction, WorkspaceAction, WritingFollowUp, WritingManifest, WritingMode, WritingScope, WritingView } from './writing-domain';
import { ResearchCitation, researchQuoteHeading, type WebSource } from './research-domain';
import { DiscussionComposer } from './DiscussionReference';
import { WritingModels } from './WritingModels';
import { WorkspaceShelf } from './WorkspaceTools';
import { ConversationSources } from './ConversationSources';
import { ImportTextButton, RevealSourceButton } from './LocalFileActions';
import { DraftCleanup, DraftImport, isImportedLibraryText, newestImportFirst } from './DraftImport';
import { WorkspaceActionReview } from './WorkspaceActionReview';
import { BookDesignCard, BookDesignProgress, BookDecisionProposals } from './BookDesign';
import './cowriting.css';

type WorkTab = 'outline' | 'materials' | 'document' | 'trials' | 'review' | 'reference' | 'stages';
const ConfirmPanel = React.lazy(() => import('./Reader').then(module => ({ default: module.ConfirmPanel })));
const promptLimit = writingLimits.promptCharacters;
const draftPriority = (document: SourceDocument) => /改后稿|修订(?:后)?稿/.test(document.chapterMaterial?.label || '') ? 1 : 0;

function AuthorMessageText({ text }: { text: string }) {
  const content = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false), [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setLong(node.getBoundingClientRect().height > 8 * parseFloat(getComputedStyle(node).lineHeight) + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [text]);
  return <div className="author-message-text">
    <div className={!expanded && long ? 'author-message-preview' : undefined}>
      <div ref={content} className="author-message-lines">{text}</div>
    </div>
    {long && <button type="button" className="text-button" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开完整消息'}</button>}
  </div>;
}

function ReplyActivity({ stage, seconds, activity, expanded, onToggle }: {
  stage?: string; seconds: number; activity: string[]; expanded: boolean; onToggle: (expanded: boolean) => void;
}) {
  return <details className="cowriting-turn-details" open={expanded} onToggle={event => {
    if (event.currentTarget.open !== expanded) onToggle(event.currentTarget.open);
  }}>
    <summary>
      <span>{stage && <>{stage} · </>}<time>用时 {Math.floor(seconds / 60) || ''}{seconds >= 60 && ' 分 '}{seconds % 60} 秒</time></span>
      <Icon name="chevron" size={14}/>
    </summary>
    {activity.length ? <ol>{activity.map((item, index) => <li key={index}>{item}</li>)}</ol> :
      <p>{stage ? '等待模型输出或调用工具。' : '这轮没有保存活动记录。'}</p>}
  </details>;
}

function ReplyFileCard({ name, path, caption, onOpen, action }: {
  name: string; path: string; caption: string; onOpen: () => void;
  action?: { label: string; title: string; disabled?: boolean; primary?: boolean; onClick: () => void };
}) {
  return <div className="cowriting-file-card">
    <button type="button" className="cowriting-artifact" title={path} onClick={onOpen}>
      <span className="cowriting-file-icon"><Icon name="file" size={19}/></span>
      <span className="cowriting-file-label"><strong>{name}</strong><small>{caption}</small></span>
      {!action && <Icon name="chevron" size={15}/>}
    </button>
    {action && <button type="button" className={action.primary ? 'primary cowriting-file-action' : 'cowriting-file-action'}
      title={action.title} disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
  </div>;
}
type DockTab = { id: string; label: string; content: React.ReactNode; onSelect: () => void; onClose: () => void };

export default function Cowriting({ ctx, initialDocumentId, initialChapterNumber, navigationRequestId, tool, onCloseTool, onBackTool,
  dockTabs, sidebarHost, returnToConversation, workspaceDocumentId }:
  { ctx: AppContext; initialDocumentId?: string; initialChapterNumber?: number; navigationRequestId?: number;
    tool?: { key: string; label: string }; onCloseTool?: () => void; onBackTool?: () => void;
    dockTabs: DockTab[]; sidebarHost: HTMLElement | null; returnToConversation?: () => void; workspaceDocumentId?: string }) {
  const workId = ctx.work.id;
  const call = useCallback((method: string, args: object = {}) => window.storyDesk.call(method, args, workId), [workId]);
  const manuscriptScope = (id: string): WritingScope => ctx.work.documents.find(d => d.id === id)?.kind === 'draft' ? 'draft' : 'chapter';
  const nextChapter = ctx.work.nextChapter ?? ctx.work.stats.latestFile + 1;
  const emptyBook = !ctx.work.documents.some(doc => ['plan', 'chapter', 'draft'].includes(doc.kind));
  const [scope, setScope] = useState<WritingScope>(initialDocumentId ? manuscriptScope(initialDocumentId)
    : emptyBook && !initialChapterNumber ? 'work' : 'next');
  const [chapterNumber, setChapterNumber] = useState(String(initialChapterNumber || nextChapter));
  const hiddenMaterials = ctx.work.hiddenChapterMaterials || [];
  const allDrafts = ctx.work.documents.filter(d => d.kind === 'draft' && d.chapter !== null)
    .sort((a, b) => (b.chapter || 0) - (a.chapter || 0) || Number(!!b.importedAt) - Number(!!a.importedAt) ||
      draftPriority(b) - draftPriority(a) || newestImportFirst(a, b));
  const drafts = allDrafts.filter(d => !hiddenMaterials.includes(d.id));
  const formal = ctx.work.documents.filter(d => d.kind === 'chapter' && d.chapter !== null)
    .sort((a, b) => (b.chapter || 0) - (a.chapter || 0));
  const chapters = scope === 'draft' ? drafts : formal;
  const [volumeNumber, setVolumeNumber] = useState('1');
  const [documentId, setDocumentId] = useState(initialDocumentId || ctx.work.reader?.documentId || chapters[0]?.id || '');
  const document = chapters.find(d => d.id === documentId) || chapters[0];
  const [requestedScene, setScene] = useState('');
  const scenes = ctx.work.scenes.filter(s => s.documentId === document?.id && s.sourceHash === document.hash);
  const planning = scope !== 'chapter' && scope !== 'draft';
  const sceneId = planning ? null : requestedScene === 'whole' || scenes.some(s => s.id === requestedScene) ? requestedScene : null;
  const number = scope === 'volume' ? volumeNumber : chapterNumber;
  const materialChapter = scope === 'next' || scope === 'draft' && !document ? Number(chapterNumber) : planning ? null : document?.chapter;
  const validMaterialChapter = materialChapter && Number.isInteger(materialChapter) && materialChapter > 0 && materialChapter <= 99999
    ? materialChapter : null;
  const chapterDrafts = drafts.filter(d => d.chapter === validMaterialChapter);
  const chapterFormal = formal.find(d => d.chapter === validMaterialChapter);
  const targetId = !planning ? document?.id || '' : scope === 'work' || scope === 'stage' ? `outline_${scope}`
    : /^[1-9]\d{0,4}$/.test(number) ? `outline_${scope === 'next' ? 'chapter' : 'volume'}_${number}` : '';
  const [view, setView] = useState<WritingView | null>(null);
  const [viewKey, setViewKey] = useState('');
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [task, setTask] = useState<CreativeTask | null>(null);
  const bookGuide = task?.purpose === 'book' || !task && scope === 'work' && emptyBook;
  const taskRef = useRef<CreativeTask | null>(null);
  const taskQueue = useRef(Promise.resolve());
  const [tasks, setTasks] = useState<CreativeTask[]>([]);
  const [taskPanel, setTaskPanel] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [restoringTask, setRestoringTask] = useState(() => !initialDocumentId && !initialChapterNumber && !!localStorage.getItem(`writing-task-${workId}`));
  const creatingTask = useRef<Promise<CreativeTask> | null>(null);
  const [references, setReferences] = useState<DiscussionReference[]>([]);
  const [importingText, setImportingText] = useState(false);
  const reference = references.length ? references : null;
  const setReference = (item: DiscussionReference | null) => setReferences(item ? [item] : []);
  const [freshConversation, setFreshConversation] = useState(false);
  const preserveNewInput = useRef(false);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<WorkTab>(initialDocumentId ? 'document' : 'outline');
  const [message, setMessage] = useState('');
  const [followUps, setFollowUps] = useState<WritingFollowUp[]>([]);
  const followUpsRef = useRef<WritingFollowUp[]>([]);
  const [queuePaused, setQueuePaused] = useState(true);
  const [queueBusy, setQueueBusy] = useState(false);
  const queueWrite = useRef<Promise<boolean> | null>(null);
  const [sendingFollowUp, setSendingFollowUp] = useState<string>();
  const activeTurn = useRef<symbol | undefined>(undefined);
  const insertRequested = useRef(false);
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string }>();
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const sendRecording = useRef<(() => void) | null>(null);
  const [pendingMessage, setPendingMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [stage, setStage] = useState('');
  const [turnStarted, setTurnStarted] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [liveDetailsOpen, setLiveDetailsOpen] = useState(false);
  const [openedActivities, setOpenedActivities] = useState<Record<string, boolean>>({});
  const keepTurnDetails = useRef(false);
  const [liveActivities, setLiveActivities] = useState<string[]>([]);
  const [liveReply, setLiveReply] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<{ document: SourceDocument; id: string } | null>(null);
  const [publish, setPublish] = useState(false);
  const [newDraft, setNewDraft] = useState<{ chapter: number; title: string } | null>(null);
  const [draftImport, setDraftImport] = useState<{ chapter: number; stayInMaterials?: boolean; attachToConversation?: boolean } | null>(null);
  const [actionReview, setActionReview] = useState<{ action: DraftAction; document: SourceDocument } | null>(null);
  const [draftCleanup, setDraftCleanup] = useState<SourceDocument | null>(null);
  const [workspaceReview, setWorkspaceReview] = useState<{ id: string; action: Extract<WorkspaceAction, { type: 'archive' }> } | null>(null);
  const [memoryPropose, setMemoryPropose] = useState<{ id: string; text: string; scope: string; scopes: { scope: string; label: string }[]; target: { documentId: string; sceneId: string | null; taskId: string | null } } | null>(null);
  const [memorySaving, setMemorySaving] = useState(false);
  const [applyingDraftEdit, setApplyingDraftEdit] = useState<string>();
  const applyEditLock = useRef(false);
  const [handledActions, setHandledActions] = useState<string[]>([]);
  const [draftWriteKey, setDraftWriteKey] = useState('');
  const [writingDocumentId, setWritingDocumentId] = useState<string>();
  const [images, setImages] = useState<{ name: string; mimeType: string; data: string }[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [workspaceReviewDocument, setWorkspaceReviewDocument] = useState<string>();
  const [messageEdit, setMessageEdit] = useState<{ id: string; text: string }>();
  const queuedResend = useRef('');
  const currentFiles = useRef(new Map<string, string>());
  const conversationKey = task?.id || 'new';
  function rememberFile(key: string, id: string) {
    currentFiles.current.set(key, id);
    if (key !== 'new') localStorage.setItem(`writing-file-${workId}-${key}`, id);
  }
  useEffect(() => {
    if (workspaceDocumentId) rememberFile(taskRef.current?.id || 'new', workspaceDocumentId);
  }, [workspaceDocumentId, workId]);
  const attachmentMenu = useRef<HTMLDetailsElement>(null);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [manifest, setManifest] = useState<WritingManifest | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState('');
  const [organizingMessage, setOrganizingMessage] = useState(false);
  const [linkedOutline, setLinkedOutline] = useState<WritingView | null>(null);
  const [selectedAnnotations, setSelectedAnnotations] = useState<string[]>([]);
  const [modelAvailable, setModelAvailable] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [focus, setFocus] = useState<'split' | 'chat' | 'document'>('chat');
  const [shelf, setShelf] = useState(false);
  const visibleFileId = focus !== 'chat' && !taskPanel && !shelf
    ? workspaceDocumentId || (!tool && tab === 'document' && !planning ? document?.id : undefined) : undefined;
  const visibleFile = ctx.work.documents.find(doc => doc.id === visibleFileId && !doc.historical && !doc.error && !hiddenMaterials.includes(doc.id));
  const pinnedDrafts = references.flatMap(item => item.kind === 'document'
    ? ctx.work.documents.filter(doc => doc.id === item.id && doc.kind === 'draft') : []);
  const writable = (visibleFile ? (visibleFile.kind === 'draft' ? visibleFile : undefined)
    : pinnedDrafts.length === 1 ? pinnedDrafts[0] : !references.length && scope === 'draft' ? document : undefined);
  const writableDraft = writable && !writable.readOnly && !writable.error && !hiddenMaterials.includes(writable.id) ? writable : undefined;
  const permissionKey = writableDraft ? `${targetId}/${sceneId || ''}/${task?.id || ''}/${writableDraft.id}/${writableDraft.hash}` : '';
  const navigationCapture = useRef({ toolKey: tool?.key, visibleFileId, shelf, focus, tab });
  navigationCapture.current = { toolKey: tool?.key, visibleFileId, shelf, focus, tab };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [chatWidth, setChatWidth] = useState(() => Math.max(34, Math.min(70, Number(localStorage.getItem('writing-chat-width')) || 58)));
  const transcript = useRef<HTMLDivElement>(null), layout = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const fetchId = useRef(0), contextFetch = useRef(0), stopRequested = useRef(false), submitLock = useRef(false);
  const handledNavigation = useRef(navigationRequestId);
  const restoredInput = useRef('');
  const [loadedInputKey, setLoadedInputKey] = useState('');
  const inputQueue = useRef(Promise.resolve());
  const inputKey = `${targetId}|${sceneId || ''}|${task?.id || ''}`;
  const inputState = useRef({ documentId: targetId, sceneId, taskId: task?.id || null, text: message, references, enabled: false });
  inputState.current = { documentId: targetId, sceneId, taskId: task?.id || null, text: message, references,
    enabled: !!view && view.documentId === targetId && viewKey === inputKey && loadedInputKey === inputKey && !restoringTask };
  const saveInput = useCallback((input: { documentId: string; sceneId: string | null; taskId: string | null; text: string; references?: DiscussionReference[] }) => {
    const pending = inputQueue.current.catch(() => {}).then(() => call('saveCowritingInput', input)).then(() => {});
    inputQueue.current = pending; return pending;
  }, [call]);
  const running = sending || taskBusy || restoringTask || !!view?.running || !!stage;
  const assignTask = useCallback((next: CreativeTask | null) => {
    taskRef.current = next; setTask(next);
    if (next) localStorage.setItem(`writing-task-${workId}`, next.id);
    else localStorage.removeItem(`writing-task-${workId}`);
  }, [workId]);
  useEffect(() => {
    const unavailable = (id: string) => hiddenMaterials.includes(id) || !!ctx.work.sourceHistory?.retired[id];
    if (task && unavailable(task.documentId)) assignTask(null);
    setReferences(items => items.some(item => item.kind === 'document' && unavailable(item.id))
      ? items.filter(item => item.kind !== 'document' || !unavailable(item.id)) : items);
  }, [ctx.work.hiddenChapterMaterials, ctx.work.sourceHistory, task, assignTask]);
  useEffect(() => {
    setReferences(items => {
      let updated = false;
      const next = items.map(item => {
        if (item.kind !== 'document') return item;
        const current = ctx.work.documents.find(doc => doc.id === item.id && !doc.error && !doc.historical);
        if (!current?.hash || current.hash === item.hash) return item;
        updated = true;
        return { ...item, hash: current.hash, title: current.title.slice(0, 240), selection: undefined };
      });
      return updated ? next : items;
    });
  }, [ctx.work.documents]);
  const listTasks = useCallback(async () => setTasks(await call('listCreativeTasks')), [call]);
  const reload = useCallback(async () => {
    if (!targetId || restoringTask) return;
    const request = ++fetchId.current;
    const requestedTaskId = taskRef.current?.id || null;
    try {
      const result: WritingView = await call('getCowriting', { documentId: targetId, sceneId, taskId: requestedTaskId });
      const read = planning ? null : await call('readDocument', { documentId: targetId });
      if (fetchId.current === request) { setView(result); setViewKey(`${targetId}|${sceneId || ''}|${requestedTaskId || ''}`); setSource(read); }
    } catch (e) { if (fetchId.current === request) setError((e as Error).message); }
  }, [call, targetId, sceneId, task?.id, planning, restoringTask]);
  const refreshContext = useCallback(async () => {
    if (!targetId || restoringTask) return;
    const request = ++contextFetch.current;
    setContextLoading(true); setContextError('');
    try {
      const result = await call('getWritingContext', { documentId: targetId, sceneId, taskId: taskRef.current?.id || null, message, reference: references.length ? references : null });
      if (contextFetch.current === request) setManifest(result);
    } catch (e) { if (contextFetch.current === request) setContextError((e as Error).message); }
    finally { if (contextFetch.current === request) setContextLoading(false); }
  }, [call, targetId, sceneId, task?.id, task?.taskHash, message, references, restoringTask]);
  async function persistTask(patch: object) {
    const pending = taskQueue.current.catch(() => {}).then(async () => {
      const current = taskRef.current;
      if (!current) throw new Error('请先建立创作任务');
      const saved = await call('saveCreativeTask', { id: current.id, expectedHash: current.taskHash, ...patch });
      assignTask(saved); await listTasks();
    });
    taskQueue.current = pending; await pending;
  }
  async function openTask(id: string) {
    setTaskBusy(true);
    try {
      if (!await ctx.confirmDocumentLeave()) return;
      await window.storyDesk.flushNow(); await taskQueue.current;
      const loaded: CreativeTask = await call('getCreativeTask', { id });
      if (loaded.status === 'deleted') return;
      if (hiddenMaterials.includes(loaded.documentId)) throw new Error('此任务的稿件已移出，可以从资料库恢复后继续。');
      if (loaded.kind === 'chapter') { setDocumentId(loaded.documentId); setScene(loaded.sceneId || ''); }
      else if (loaded.kind === 'next') setChapterNumber(loaded.documentId.split('_').at(-1)!);
      else if (loaded.kind === 'volume') setVolumeNumber(loaded.documentId.split('_').at(-1)!);
      setScope(loaded.kind === 'chapter' ? manuscriptScope(loaded.documentId) : loaded.kind); assignTask(loaded); setReference(null);
      setFreshConversation(false); preserveNewInput.current = false;
      setTab(loaded.kind === 'stage' ? 'stages' : loaded.phase === 'review' ? 'review' : loaded.kind === 'chapter' ? 'document' : 'outline');
      setSelectedAnnotations([]); setMessage(''); setTaskPanel(loaded.status === 'archived'); setError('');
      setImages([]); setShowHidden(false); setMessageEdit(undefined);
      if (tool && taskRef.current?.id === loaded.id) onCloseTool?.();
    } catch (e) { setError((e as Error).message); } finally { setTaskBusy(false); }
  }
  async function createTask(goal = '', title = '', initialMessage = '', purpose: 'writing' | 'character' | 'book' = bookGuide ? 'book' : 'writing') {
    if (!targetId) throw new Error('请先选择有效的创作范围');
    if (creatingTask.current) return creatingTask.current;
    setTaskBusy(true);
    const pending = (async () => {
      await window.storyDesk.flushNow();
      const created: CreativeTask = await call('createCreativeTask', {
        kind: planning ? scope : 'chapter', documentId: targetId, sceneId, goal, title, purpose,
      });
      const initialFile = currentFiles.current.get('new');
      if (initialFile) rememberFile(created.id, initialFile);
      if (initialMessage) await saveInput({ documentId: targetId, sceneId, taskId: created.id, text: initialMessage });
      assignTask(created); await listTasks(); setSelectedAnnotations([]); setTaskPanel(false); return created;
    })();
    creatingTask.current = pending;
    try { return await pending; } finally { creatingTask.current = null; setTaskBusy(false); }
  }
  async function ensureTask(goal = '') {
    const subject = bookGuide ? '构思新书' : scope === 'stage' ? '阶段规划' : references[0]?.title || visibleFile?.title || targetTitle;
    const topic = [subject, goal.split(/[。！？\n]/u, 1)[0].slice(0, 28)].filter(Boolean).join(' · ');
    return taskRef.current || createTask(goal, topic.slice(0, 96));
  }
  async function startConversation(flush = true, startScope: 'next' | 'stage' | 'work' = emptyBook ? 'work' : 'next') {
    try {
      if (flush) {
        if (!await ctx.confirmDocumentLeave()) return;
        await window.storyDesk.flushNow();
      }
      inputState.current.enabled = false;
      currentFiles.current.delete('new');
      assignTask(null); setScope(startScope); setChapterNumber(String(nextChapter)); setScene('');
      setImages([]); setShowHidden(false); setMessageEdit(undefined);
      setReference(null); setMessage(''); setError(''); setSelectedAnnotations([]);
      setTaskPanel(false); setShelf(false); setTab(startScope === 'stage' ? 'stages' : 'outline'); setFocus('chat');
      setFreshConversation(true); preserveNewInput.current = true;
      if (tool || returnToConversation) onCloseTool?.();
    } catch (e) { setError((e as Error).message); }
  }
  function attachReference(item: DiscussionReference) {
    if (references.length >= 8 && !references.some(row => row.id === item.id && row.kind === item.kind)) {
      setError('一次最多引用八份资料。'); return;
    }
    setReferences(items => [...items.filter(row => row.id !== item.id || row.kind !== item.kind), item]);
    if (item.kind === 'document') rememberFile(conversationKey, item.id);
    focusComposer();
  }
  function replaceDocument(id: string, item: Extract<DiscussionReference, { kind: 'document' }>) {
    if (currentFiles.current.get(conversationKey) === id) rememberFile(conversationKey, item.id);
    setReferences(rows => rows.some(row => row.kind === 'document' && row.id === id)
      ? rows.flatMap(row => row.kind !== 'document' || row.id !== id ? [row] :
        id !== item.id && rows.some(other => other.kind === 'document' && other.id === item.id) ? [] : [item])
      : rows);
  }
  async function attachImported(files: Pick<SourceDocument, 'id' | 'hash' | 'title'>[]) {
    const current = inputState.current;
    if (!current.enabled || current.documentId !== targetId || current.sceneId !== sceneId ||
        current.taskId !== (task?.id || null) || current.references.length + files.length > 8) {
      ctx.notify('文件已保存，可以从本章资料或资料库打开。');
      return;
    }
    const next = [...current.references];
    for (const { id, hash, title } of files) {
      if (!next.some(ref => ref.kind === 'document' && ref.id === id)) next.push({ id, hash, title, kind: 'document' });
    }
    setReferences(next);
    try { await saveInput({ ...current, references: next }); }
    catch (error) { ctx.notify((error as Error).message, true); }
    if (attachmentMenu.current) attachmentMenu.current.open = false;
    ctx.navigate({ page: 'reader', documentId: files[0].id });
  }
  async function openDraftAction(action: DraftAction) {
    try {
      await window.storyDesk.flushNow();
      const current: SourceDocument = await call('readDocument', { documentId: action.documentId });
      if (current.hash !== action.sourceHash || hiddenMaterials.includes(current.id))
        throw new Error('稿件版本或状态已变化，请打开现行稿件重新核对。');
      if (isImportedLibraryText(current) || current.kind === 'draft' && action.publish) {
        setActionReview({ action, document: current });
      } else if (action.cleanup && ['draft', 'chapter'].includes(current.kind)) {
        setDraftCleanup(current);
      } else if (current.kind === 'chapter') {
        ctx.navigate({ page: 'reader', documentId: current.id });
      }
    } catch (problem) { ctx.notify((problem as Error).message, true); }
  }
  function openReference(item: DiscussionReference) {
    if (item.kind === 'character') ctx.navigate({ page: 'characters', characterId: item.id });
    else if (item.kind === 'map') ctx.navigate({ page: 'attachment', documentId: item.documentId });
    else if (item.kind === 'stage') ctx.navigate({ page: 'plot', tab: 'plot_arc' });
    else ctx.navigate({ page: 'reader', documentId: item.id });
  }
  function selectConversationSource(item: DiscussionReference) {
    if (item.kind === 'stage' && !task && scope !== 'stage') {
      void selectPlanningScope('stage', item);
      return;
    }
    if (!references.length && !task && item.kind === 'document') {
      const picked = ctx.work.documents.find(row => row.id === item.id);
      if (picked?.kind === 'chapter' || picked?.kind === 'draft') {
        preserveNewInput.current = true;
        setDocumentId(item.id); setScope(manuscriptScope(item.id)); setScene('whole'); setTab('document');
      }
    }
    attachReference(item);
  }
  async function selectPlanningScope(value: WritingScope, item?: DiscussionReference) {
    try {
      await window.storyDesk.flushNow();
      if (value !== scope) {
        preserveNewInput.current = true;
        assignTask(null); setScope(value); setScene(''); setTab(value === 'stage' ? 'stages' : 'outline');
        if (value === 'next') setChapterNumber(String(nextChapter));
      }
      if (item) attachReference(item);
    } catch (e) { setError((e as Error).message); }
  }
  async function changeScope(next: WritingScope) {
    try {
      await window.storyDesk.flushNow();
      if (next !== scope || next === 'next' && chapterNumber !== String(nextChapter)) {
        assignTask(null); setScope(next); setMessage(''); setReference(null); setSelectedAnnotations([]); setError('');
        if (next === 'next') setChapterNumber(String(nextChapter));
      }
      if (tool) onCloseTool?.();
      setTaskPanel(false);
      setTab(next === 'stage' ? 'stages' : next === 'chapter' || next === 'draft' ? 'document' : 'outline'); }
    catch (e) { setError((e as Error).message); }
  }
  async function discussChapterOutline(chapter: number, design?: SourceDocument) {
    try {
      await window.storyDesk.flushNow();
      if (scope !== 'next' || Number(chapterNumber) !== chapter) {
        assignTask(null); setMessage(''); setScope('next'); setChapterNumber(String(chapter));
      }
      setReference(design ? { kind: 'document', id: design.id, title: design.title, hash: design.hash } : null);
      setTab('outline');
      if (tool) onCloseTool?.();
      if (design) focusComposer();
    } catch (error) { setError((error as Error).message); }
  }
  useEffect(() => {
    void listTasks().catch(e => setError((e as Error).message));
    const previous = localStorage.getItem(`writing-task-${workId}`);
    if (previous && !initialDocumentId && !initialChapterNumber) void openTask(previous).finally(() => setRestoringTask(false));
  }, [workId]);
  useEffect(() => {
    if (navigationRequestId === undefined || handledNavigation.current === navigationRequestId) return;
    handledNavigation.current = navigationRequestId;
    if (initialDocumentId === targetId && !planning) { setTab('document'); return; }
    const requestedId = initialDocumentId || `outline_chapter_${initialChapterNumber}`;
    setFreshConversation(false); preserveNewInput.current = false;
    const existing = tasks.find(row => row.documentId === requestedId && !row.sceneId && row.status === 'active');
    if (existing) { void openTask(existing.id); return; }
    assignTask(null); setScene(''); setReference(null); setSelectedAnnotations([]); setMessage('');
    if (initialDocumentId) { setDocumentId(initialDocumentId); setScope(manuscriptScope(initialDocumentId)); setTab('document'); }
    else if (initialChapterNumber) { setChapterNumber(String(initialChapterNumber)); setScope('next'); setTab('outline'); }
    setError('');
  }, [navigationRequestId]);
  useEffect(() => {
    if (tool) { setTaskPanel(false); setShelf(false); setFocus(current => window.innerWidth <= 900 ? 'document' : current === 'chat' ? 'split' : current); }
  }, [tool?.key]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)');
    const resize = () => { if (narrow.matches) setFocus(current => current === 'split' ? 'document' : current); };
    narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    if (!view || viewKey !== inputKey || view.documentId !== targetId || view.sceneId !== sceneId || sending || restoringTask || taskBusy || restoredInput.current === inputKey) return;
    restoredInput.current = inputKey; setLoadedInputKey(inputKey);
    followUpsRef.current = view.composer?.followUps || [];
    setFollowUps(followUpsRef.current);
    setQueuePaused(true);
    setQueueEdit(undefined);
    if (!preserveNewInput.current) {
      setMessage(view.composer?.text || '');
      setReferences(view.composer?.references || []);
    }
    preserveNewInput.current = false;
  }, [view, viewKey, inputKey, sending, restoringTask, taskBusy, targetId, sceneId]);
  useEffect(() => {
    const off = window.storyDesk.onFlush(async () => { const current = inputState.current; if (current.enabled) await saveInput(current); });
    return off;
  }, [saveInput]);
  useEffect(() => {
    if (!inputState.current.enabled) return;
    const snapshot = { ...inputState.current };
    const timer = setTimeout(() => void saveInput(snapshot).catch(e => setError((e as Error).message)), 700);
    return () => clearTimeout(timer);
  }, [message, references, inputKey, sending, view?.documentId, saveInput]);
  useEffect(() => {
    if (!submitLock.current) { setView(null); setSource(null); setError(''); setStage(''); }
    setManifest(null); setDirty(false);
    void reload(); return () => { fetchId.current += 1; };
  }, [reload, document?.hash]);
  useEffect(() => { followTranscript.current = true; setLiveReply(''); }, [targetId, sceneId]);
  useEffect(() => {
    const timer = setTimeout(() => void refreshContext(), 500);
    return () => { clearTimeout(timer); contextFetch.current += 1; };
  }, [refreshContext, document?.hash, ctx.work.approvals, ctx.work.records, ctx.work.events, ctx.work.hiddenChapterMaterials]);
  useEffect(() => {
    if (planning || tab !== 'outline' || !document?.chapter) return;
    let live = true;
    call('getCowriting', { documentId: `outline_chapter_${document.chapter}` }).then(result => { if (live) setLinkedOutline(result); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [call, planning, tab, document?.chapter]);
  useEffect(() => window.storyDesk.subscribe(event => {
    if (event.type !== 'cowriting-progress' || event.workId !== workId || event.documentId !== targetId || event.sceneId !== sceneId ||
      event.taskId !== (taskRef.current?.id || null)) return;
    if (typeof event.preview === 'string') setLiveReply(event.preview);
    if (typeof event.activity === 'string') {
      setLiveActivities(previous => previous.at(-1) === event.activity ? previous : [...previous, event.activity].slice(-64));
    }
    if (event.stage === 'finished') { setStage(''); if (!sending) void reload(); }
    else setStage(event.stage);
  }), [reload, sceneId, sending, targetId, workId]);
  useEffect(() => {
    if (turnStarted === undefined) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - turnStarted) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [turnStarted]);
  useEffect(() => {
    if (followTranscript.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [view?.messages.length, pendingMessage, liveReply, stage, liveActivities.length]);
  useEffect(() => {
    if (!view || view.documentId !== targetId) return;
    setSelectedAnnotations(ids => {
      const current = ids.filter(id => task?.annotations.some(a => a.id === id && a.sourceHash === view.sourceHash));
      return current.length === ids.length ? ids : current;
    });
  }, [view?.sourceHash, task?.taskHash, targetId]);
  const model = ctx.work.writingModel, launcherModel = model.key !== 'analysis';
  const modelReady = !!(model.enabled && model.baseUrl && model.model && modelAvailable);
  const pendingEdits = !!(dirty || viewKey === inputKey && view?.hasDraft);
  const replying = sending || !!stage || !!view?.running;
  const composerLoaded = loadedInputKey === inputKey && !restoringTask && (!taskBusy || sending);
  const canSend = !!(view?.documentId === targetId && view.sceneId === sceneId && viewKey === inputKey && !running && loadedInputKey === inputKey && !modelBusy && !importingText &&
    modelReady && !applyingDraftEdit && task?.status !== 'archived');
  const ready = canSend && voicePhase === 'idle' && !!(message.trim() || images.length);
  const canQueue = replying && composerLoaded && !!task?.id && voicePhase === 'idle' && !queueBusy &&
    task.status !== 'archived' && !!message.trim() && followUps.length < 32;
  const lastAuthor = view?.messages.filter(row => row.role === 'author').at(-1);
  const retryMessageId = (view?.error || view?.interrupted) && lastAuthor?.mode === 'discuss' &&
    lastAuthor.sourceHash === view?.sourceHash && lastAuthor.text === message.trim() ? lastAuthor.id : null;
  async function persistFollowUps(update: (rows: WritingFollowUp[]) => WritingFollowUp[], taskId = taskRef.current?.id) {
    if (!taskId) return false;
    setQueueBusy(true);
    const write = (queueWrite.current || Promise.resolve(true)).then(async () => {
      if (taskRef.current?.id !== taskId) return false;
      const next = update(followUpsRef.current);
      await call('saveCowritingQueue', { documentId: targetId, sceneId, taskId, followUps: next });
      if (taskRef.current?.id === taskId) {
        followUpsRef.current = next;
        setFollowUps(next);
      }
      return true;
    }).catch(problem => {
      setError((problem as Error).message);
      setQueuePaused(true);
      return false;
    });
    queueWrite.current = write;
    const saved = await write;
    if (queueWrite.current === write) {
      queueWrite.current = null;
      setQueueBusy(false);
    }
    return saved;
  }
  async function queueMessage() {
    if (!canQueue || queueWrite.current) return;
    const text = message.trim();
    if (await persistFollowUps(rows => [...rows, { id: 'followup_' + crypto.randomUUID(), text, references }])) {
      setMessage(current => current.trim() === text ? '' : current);
      setQueuePaused(false);
      focusComposer();
    }
  }
  async function openMemoryPropose(row: { id: string; text: string }) {
    const target = { documentId: targetId, sceneId, taskId: taskRef.current?.id || null };
    try {
      const data: any = await call('memlayerMemory', { scope: 'work' });
      setMemoryPropose({ id: row.id, text: row.text, scope: 'work', scopes: data.scopes, target });
    } catch (error: any) { ctx.notify(error?.message || '共享记忆尚未启用，请先在设置中开启', true); }
  }
  async function saveMemoryPropose() {
    if (!memoryPropose) return;
    setMemorySaving(true);
    try {
      const saved: any = await call('memlayerPropose', { ...memoryPropose.target, scope: memoryPropose.scope,
        text: memoryPropose.text, sourceId: memoryPropose.id });
      ctx.notify(saved?.duplicate ? '这条候选已存在，请在记忆中心核对' : '已提交候选，需在记忆中心确认后才会被 AI 读取');
      setMemoryPropose(null);
    } catch (error: any) { ctx.notify(error?.message || '候选提交失败', true); }
    finally { setMemorySaving(false); }
  }

  async function sendFollowUpNow(row: WritingFollowUp) {
    if (stopping || queueBusy || task?.status === 'archived') return;
    const turn = activeTurn.current;
    if (!await persistFollowUps(rows => [row, ...rows.filter(item => item.id !== row.id)])) return;
    setQueuePaused(false);
    if (replying && turn === activeTurn.current && submitLock.current) await stop(true);
  }
  async function send(mode: WritingMode, dictated?: string, queued?: WritingFollowUp, continuationMessageId?: string) {
    if (submitLock.current || !view || !canSend || (dictated === undefined && !ready && !queued && !continuationMessageId) ||
        mode !== 'discuss' && (pendingEdits || reference || task?.purpose === 'character')) return;
    submitLock.current = true;
    activeTurn.current = Symbol();
    setSendingFollowUp(queued?.id);
    const words = queued?.text || (continuationMessageId ? '从断点继续' : (dictated ?? message).trim() || '请查看这些图片。');
    const sentReferences = queued?.references || references;
    const sentReference = sentReferences.length ? sentReferences : null;
    const sentImages = queued || continuationMessageId ? [] : images;
    const consumesComposer = !queued && !continuationMessageId;
    if (consumesComposer) { setMessage(''); setImages([]); }
    const viewAtSend = navigationCapture.current;
    const grant = consumesComposer && mode === 'discuss' && !pendingEdits && writableDraft && permissionKey === draftWriteKey
      ? { documentId: writableDraft.id, sourceHash: writableDraft.hash } : undefined;
    setWritingDocumentId(grant?.documentId);
    setDraftWriteKey('');
    stopRequested.current = false; insertRequested.current = false; followTranscript.current = true;
    const retry = consumesComposer && mode === 'discuss' && dictated === undefined ? retryMessageId : null;
    setSending(true); setStopping(false); setStage('正在读取作品资料'); setElapsed(0); setTurnStarted(Date.now());
    keepTurnDetails.current = false; setLiveDetailsOpen(false); setLiveActivities([]); setError(''); setPendingMessage(retry ? '' : words); setLiveReply('');
    const restoreMessage = () => {
      if (consumesComposer && !insertRequested.current) {
        setMessage(current => current.trim() ? current : words);
        if (sentImages.length) setImages(current => current.length ? current : sentImages);
      }
    };
    try {
      await window.storyDesk.flushNow();
      if (stopRequested.current) { restoreMessage(); return; }
      const goal = words.split(`\n\n${researchQuoteHeading}\n`, 1)[0].trim();
      const currentTask = await ensureTask(goal.slice(0, 2500));
      restoredInput.current = `${targetId}|${sceneId || ''}|${currentTask.id}`;
      setLoadedInputKey(restoredInput.current);
      if (!task) await saveInput({ documentId: targetId, sceneId, taskId: currentTask.id, text: inputState.current.text, references });
      if (stopRequested.current) { restoreMessage(); return; }
      const result = await call('sendCowriting', { documentId: targetId, sceneId, taskId: currentTask.id,
        sourceHash: view.sourceHash, message: words, mode, reference: sentReference, retryMessageId: retry,
        workspaceDocumentId: visibleFile?.id, draftWrite: grant, images: sentImages,
        clientMessageId: queued?.id, continuationMessageId,
        workspaceReviewId: !shelf && !taskPanel && focus !== 'chat' ? workspaceReviewDocument : undefined,
        ...(mode === 'annotate' ? { annotationIds: selectedAnnotations } : {}),
        ...(!queued && mode !== 'annotate' && !sentReference && manifest?.documentId === targetId && manifest.taskId === currentTask.id &&
          (manifest.sceneId || null) === sceneId && manifest.request === words ? { expectedContextSignature: manifest.signature } : {}) });
      if (!mounted.current) return;
      const answer = result.messages?.at(-1);
      if (answer?.role === 'assistant' && keepTurnDetails.current) setOpenedActivities(previous => ({ ...previous, [answer.id]: true }));
      if (queued) await persistFollowUps(rows => rows.filter(row => row.id !== queued.id), currentTask.id);
      if (result.status !== 'completed') {
        if (result.messages?.at(-1)?.incomplete) setLiveReply('');
        if (!insertRequested.current) setQueuePaused(true);
        restoreMessage();
        setError(result.error || '本轮未完成，可以调整要求后重试');
      }
      else {
        setLiveReply('');
        if (!task) await saveInput({ documentId: targetId, sceneId, taskId: null, text: '' });
        const reply: WritingView['messages'][number] | undefined = result.messages?.at(-1);
        const action = reply?.workspaceAction, opened = reply?.openedWorkspaceFile;
        if (reply?.artifact || action?.type === 'edit' && action.applied) await ctx.refresh();
        if (taskRef.current?.id === currentTask.id && JSON.stringify(navigationCapture.current) === JSON.stringify(viewAtSend)) {
          if (action?.type === 'edit' && action.applied) openDraftFile(action.documentId, action.appliedHash);
          else if (opened) ctx.navigate({ page: opened.kind === 'attachment' ? 'attachment' : 'reader', documentId: opened.documentId });
        }
        if (result.latestRevisionId && mode !== 'discuss') { openDocumentPane('trials'); setSelectedAnnotations([]); }
      }
    } catch (e) { restoreMessage(); setQueuePaused(true); setError((e as Error).message); }
    finally {
      try { await reload(); }
      finally { submitLock.current = false; activeTurn.current = undefined; setSendingFollowUp(undefined); setWritingDocumentId(undefined); setPendingMessage(''); setSending(false); setStopping(false); setStage(''); setTurnStarted(undefined); }
      await refreshContext();
    }
  }
  useEffect(() => {
    const next = followUps[0];
    if (!queuePaused && !queueBusy && !queueEdit && canSend && voicePhase === 'idle' && next && task &&
        !view?.messages.some(row => row.id === next.id)) void send('discuss', undefined, next);
  }, [canSend, queuePaused, queueBusy, queueEdit, followUps, voicePhase, task?.id, view]);
  useEffect(() => {
    if (ready && task && queuedResend.current === task.id) {
      queuedResend.current = '';
      void send('discuss');
    }
  }, [ready, task?.id]);
  function openDraftFile(id: string, appliedHash?: string) {
    if (tool?.key === `reader:${id}` && !shelf && !taskPanel && !appliedHash) {
      if (focus === 'chat') showDock();
      return;
    }
    ctx.navigate({ page: 'reader', documentId: id, draftEditHash: appliedHash });
  }
  async function applyDraftChange(id: string, edit: Extract<WorkspaceAction, { type: 'edit' }>) {
    if (applyEditLock.current || running) return;
    applyEditLock.current = true;
    setApplyingDraftEdit(id);
    const conversation = taskRef.current?.id || null;
    try {
      if (!await ctx.confirmDocumentLeave()) return;
      await window.storyDesk.flushNow();
      const result = await call('applyCowritingDraftEdit', { documentId: targetId, sceneId, taskId: conversation, messageId: id });
      await ctx.refresh();
      ctx.notify('已写入草稿，可在原稿撤回本次修改。');
      if (mounted.current && conversation === (taskRef.current?.id || null)) {
        openDraftFile(edit.documentId, result.document.hash);
        await reload();
      }
    } catch (failure) { ctx.notify((failure as Error).message, true); }
    finally { applyEditLock.current = false; setApplyingDraftEdit(undefined); }
  }
  async function forkMessage(messageId: string, editedText?: string, requiresImage = false) {
    if (!task || running || applyingDraftEdit) return;
    try {
      if (!await ctx.confirmDocumentLeave()) return;
      await window.storyDesk.flushNow();
      const branch: CreativeTask = await call('forkCowriting', { documentId: targetId, sceneId, taskId: task.id, messageId, editedText });
      if (editedText !== undefined && !requiresImage) queuedResend.current = branch.id;
      await listTasks();
      await openTask(branch.id);
      if (requiresImage) ctx.notify('请重新添加原消息的图片，再发送。');
    } catch (failure) { ctx.notify((failure as Error).message, true); }
  }
  async function toggleHidden(messageId: string, hidden: boolean) {
    if (!task || running || applyingDraftEdit) return;
    try {
      await call('setCowritingMessageVisibility', { documentId: targetId, sceneId, taskId: task.id, messageId, hidden });
      await reload();
      ctx.notify(hidden ? '已移出这条消息，可在本对话恢复。' : '已恢复消息。');
    } catch (failure) { ctx.notify((failure as Error).message, true); }
  }
  async function pickImages() {
    try {
      const picked = await call('pickConversationImages', { limit: 4 - images.length });
      setImages(current => [...current, ...picked].slice(0, 4));
      if (attachmentMenu.current) attachmentMenu.current.open = false;
    } catch (failure) { ctx.notify((failure as Error).message, true); }
  }
  async function openReview(id = view?.latestRevisionId) {
    if (!id || planning) return;
    try { await window.storyDesk.flushNow(); const selected = await call('readDocument', { documentId: targetId }); setReview({ document: selected, id }); }
    catch (e) { setError((e as Error).message); }
  }
  async function stop(insert = false) {
    stopRequested.current = true;
    insertRequested.current = insert;
    if (!insert) setQueuePaused(true);
    setStopping(true);
    try { await call('cancelCowriting', { documentId: targetId, sceneId, taskId: taskRef.current?.id || null }); }
    catch (e) { setError((e as Error).message); }
  }
  const recover = useCallback(async (text: string, baseHash: string) => { await call('setWritingRecovery', { documentId: targetId, text, baseHash }); }, [call, targetId]);
  const recoverOutline = useCallback(async (text: string, baseHash: string) => {
    if (document?.chapter) await call('setWritingRecovery', { documentId: `outline_chapter_${document.chapter}`, text, baseHash });
  }, [call, document?.chapter]);
  async function saveText(text: string, expectedHash: string, outlineId?: string) {
    const plan = planning || !!outlineId, id = outlineId || targetId;
    const result = await call(plan ? 'saveWritingOutline' : 'saveDocument', { documentId: id, expectedHash, text });
    await ctx.refresh();
    if (outlineId) setLinkedOutline(await call('getCowriting', { documentId: outlineId })); else await reload();
    await refreshContext(); ctx.notify(plan ? '大纲已保存到本地资料' :
      scope === 'draft' ? '草稿已保存，可以继续修改或核对发布' : '正文修订已保存，等待确认');
    const saved = result.document || result; return { hash: saved.hash, text: saved.text ?? text };
  }
  async function annotate(selection: WritingSelection, note: string) {
    const current = await ensureTask(), id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await persistTask({ annotations: [...current.annotations, { id, ...selection, note }] });
    const saved = taskRef.current!.annotations.at(-1)!;
    setSelectedAnnotations(ids => [...ids, saved.id]); ctx.notify('批注已保存，可以继续选段，或提交给 AI');
  }
  function quote(text: string) {
    const quoted = `请结合上下文讨论这段：\n「${text.slice(0, 1800)}」\n`;
    setMessage(current => (current ? current + '\n' + quoted : quoted).slice(0, promptLimit)); setFocus('split');
  }
  function focusComposer() {
    setFocus(current => current === 'document' ? (window.innerWidth <= 900 ? 'chat' : 'split') : current);
    requestAnimationFrame(() => composerInput.current?.focus());
  }
  async function startCharacterTask(name: string) {
    if (running) return false;
    const candidate = name.slice(0, 80);
    const title = candidate ? `人物构思 · ${candidate}` : '人物构思 · 新人物';
    const goal = candidate ? `先讨论新人物「${candidate}」的身份、动机和与现有人物的联系。` : '先讨论一个新人物的身份、动机和与现有人物的联系。';
    try {
      await createTask(goal, title, goal, 'character');
      setReference(null);
      focusComposer();
      return true;
    } catch (problem) { setError((problem as Error).message); return false; }
  }
  function citeSearchResults(sources: WebSource[]) {
    const links = new Set(message.split(/\s+/u));
    const additions = sources.filter(source => !links.has(source.url));
    if (!additions.length) { ctx.notify('所选出处已在写作要求中。'); return false; }
    const request = message.trim() || '请结合这些网络线索讨论写法，区分史料依据和可用于小说的设想。';
    const citations = additions.map(source => [source.title, source.url, source.excerpt].filter(Boolean).join('\n'));
    const heading = request.includes(`\n\n${researchQuoteHeading}\n`) ? '' : researchQuoteHeading;
    const next = [request, heading, ...citations].filter(Boolean).join('\n\n');
    if (next.length > promptLimit) { ctx.notify(`写作要求和选中的出处超过 ${promptLimit} 字，请少选几条出处或缩短现有文字。`, true); return false; }
    setMessage(next);
    setFocus(window.innerWidth <= 900 ? 'chat' : 'split');
    ctx.notify('出处已带到写作要求，可以继续编辑后发送。');
    return true;
  }
  async function organizeMessage(messageId: string) {
    setOrganizingMessage(true);
    try {
      const saved = await call('createResearchCandidate', {
        discussion: { documentId: targetId, sceneId, taskId: task?.id || null, messageId },
      });
      ctx.navigate({ page: 'research', researchId: saved.id });
    } catch (error) {
      ctx.notify((error as Error).message, true);
    } finally { setOrganizingMessage(false); }
  }
  function openChapter() {
    const chapter = Number(chapterNumber), existing = chapterFormal || chapterDrafts[0];
    if (existing) ctx.navigate({ page: 'cowriting', documentId: existing.id });
    else setNewDraft({ chapter, title: '' });
  }
  async function createDraft() {
    if (!newDraft || creatingDraft) return;
    setCreatingDraft(true);
    try {
      const doc = await ctx.act(() => call('createChapterDraft', { chapter: newDraft.chapter, title: newDraft.title }), '章节草稿已保存');
      if (doc) { setNewDraft(null); ctx.navigate({ page: 'cowriting', documentId: doc.id }); }
    } finally { setCreatingDraft(false); }
  }
  function resize(value: number) {
    const width = Math.max(34, Math.min(70, value)); setChatWidth(width); localStorage.setItem('writing-chat-width', String(width));
  }
  const currentView = viewKey === inputKey ? view : null;
  const targetTitle = planning ? (scope === 'stage' ? '阶段规划' : scope === 'work' ? '全书大纲' : scope === 'volume' ? '第' + number + '卷大纲' : '第' + number + '章章纲') : document?.title;
  const selectedScope = writingScopes.find(item => item.id === scope);
  const title = task?.documentId === targetId ? task.title : targetTitle || '开始一项创作任务';
  const currentText = planning ? view?.outlineText || '' : source?.text || '';
  const annotations = task?.annotations || [];
  const contextManifest = manifest?.documentId === targetId && manifest.taskId === (task?.id || null)
    && (manifest.sceneId || null) === sceneId ? manifest : null;
  const lastManifest = currentView?.manifest?.documentId === targetId ? currentView.manifest : undefined;
  const tabs: { id: WorkTab; label: string }[] = [
    ...(scope !== 'stage' ? [{ id: 'outline' as const, label: scope === 'volume' ? '卷纲' : scope === 'work' ? '全书大纲' : '章纲' }] : []),
    ...(!planning || scope === 'next' ? [{ id: 'materials' as const, label: '本章资料' }] : []),
    ...(!planning ? [{ id: 'document' as const, label: scope === 'draft' ? '草稿' : '正文' },
      { id: 'trials' as const, label: '试写比较' }, { id: 'review' as const, label: '批注修改' }] : []),
    { id: 'stages', label: '阶段计划' }, { id: 'reference', label: '本次依据' }];
  const preferredDraft = scope === 'next' && !chapterFormal ? chapterDrafts.find(d =>
    !d.error && !d.readOnly && !ctx.work.hiddenChapterMaterials?.includes(d.id)) : null;
  const chapterDesigns = scope === 'next' && validMaterialChapter ? ctx.work.documents.filter(d => d.kind === 'plan' && !d.error &&
    d.chapterMaterial?.role === 'design' && d.chapterMaterial.chapter === validMaterialChapter && !hiddenMaterials.includes(d.id) &&
    d.path !== `_创作管理/大纲/第${validMaterialChapter}章章纲.md`) : [];
  const storedRows = freshConversation && !task || !currentView ? [] : currentView.messages;
  const threadRows = storedRows.filter(row => !row.hiddenAt || showHidden);
  const latestUsableAnswer = threadRows.filter(row => row.role === 'assistant' && !row.incomplete && !row.sourceStale && !row.hiddenAt).at(-1)?.text;
  const waitingFollowUps = loadedInputKey === inputKey ? followUps.filter(row => row.id !== sendingFollowUp) : [];
  const emptyConversation = !threadRows.length && !pendingMessage && !restoringTask;
  const showDock = () => setFocus(window.innerWidth <= 900 ? 'document' : 'split');
  async function openWorkspaceShelf() {
    if (!await ctx.confirmDocumentLeave()) return;
    setTaskPanel(false); setShelf(true); showDock();
  }
  function openDocumentPane(which?: WorkTab) {
    setTaskPanel(false); setShelf(false);
    if (!which) {
      const lastUsed = currentView?.messages.filter(row => row.openedWorkspaceFile || row.workspaceAction?.type === 'edit').at(-1);
      const lastId = lastUsed?.workspaceAction?.type === 'edit' ? lastUsed.workspaceAction.documentId : lastUsed?.openedWorkspaceFile?.documentId;
      const ids = [currentFiles.current.get(conversationKey), localStorage.getItem(`writing-file-${workId}-${conversationKey}`),
        lastId, references.filter(item => item.kind === 'document').at(-1)?.id, !planning ? document?.id : undefined];
      const current = ids.map(id => ctx.work.documents.find(doc => doc.id === id && !doc.error && !doc.historical && !hiddenMaterials.includes(doc.id)))
        .find(Boolean);
      if (current) {
        if (workspaceDocumentId !== current.id || tool?.key !== `reader:${current.id}`) {
          ctx.navigate({ page: current.kind === 'attachment' ? 'attachment' : 'reader', documentId: current.id });
        }
        showDock();
        return;
      }
    }
    if (tool) onCloseTool?.();
    if (which) setTab(which);
    showDock();
  }
  async function changeConversationStatus(row: CreativeTask, status: 'active' | 'deleted') {
    if (status === 'deleted' &&
        !window.confirm(`删除对话《${row.title}》？可以在「已删除对话」恢复。`)) return;
    try {
      if (row.id === taskRef.current?.id && !await ctx.confirmDocumentLeave()) return;
      await window.storyDesk.flushNow();
      const record: CreativeTask = await call('getCreativeTask', { id: row.id });
      await call('saveCreativeTask', { id: row.id, expectedHash: record.taskHash, status });
      if (status === 'deleted' && row.id === taskRef.current?.id) await startConversation(false);
      await listTasks();
      ctx.notify(status === 'deleted' ? '对话已移入「已删除对话」' : '对话已恢复');
    } catch (failure) { ctx.notify((failure as Error).message, true); }
  }
  const bookDecisions = view?.bookDecisions || [];
  const bookProgress = <BookDesignProgress decisions={bookDecisions} disabled={running || !task || task.status === 'archived'}
    onOpen={documentId => ctx.navigate({ page: 'reader', documentId })}
    onSave={async (decision, input) => {
      const saved = await ctx.act(() => call('reviseBookDecision', { taskId: task?.id, decisionId: decision.id,
        expectedVersion: decision.version, ...input }), '构思已保存');
      if (!saved) return false;
      await reload();
      return true;
    }}/>;
  return <div className={`cowriting-page writing-studio focus-${focus} ${emptyConversation ? 'chat-empty' : ''}`} data-task-restoring={restoringTask ? 'true' : 'false'} aria-busy={restoringTask}>
    {sidebarHost && createPortal(<>
      <button className="studio-new-conversation" disabled={running} onClick={() => void startConversation()}><Icon name="edit" size={16}/>新对话</button>
      <div className="studio-recent-label">近期对话</div>
      <nav className="studio-recent" aria-label="近期对话">
        {tasks.filter(row => row.status === 'active' && !hiddenMaterials.includes(row.documentId)).map(row =>
          <div key={row.id} className="studio-conversation-row"><button title={row.title} aria-current={row.id === task?.id ? 'true' : undefined} disabled={running}
            onClick={() => { void openTask(row.id).then(() => returnToConversation?.()); }}>
            <span>{row.title}</span>{sending && row.id === task?.id && <small>回复中</small>}</button>
            <button className="studio-conversation-delete" aria-label="删除对话" title="删除对话" disabled={running}
              onClick={() => void changeConversationStatus(row, 'deleted')}><Icon name="close" size={14}/></button></div>)}
      </nav>
      {tasks.some(row => row.status === 'deleted') && <details className="studio-deleted-conversations">
        <summary>已删除对话</summary>
        {tasks.filter(row => row.status === 'deleted').map(row => <div key={row.id}>
          <span title={row.title}>{row.title}</span><button disabled={running} onClick={() => void changeConversationStatus(row, 'active')}>恢复</button>
        </div>)}
      </details>}
    </>, sidebarHost)}
    <div className="studio-heading"><div><h1 title={task?.goal || title}>{freshConversation && !task ? '新对话' : title}</h1></div>
      <div className="studio-actions">
        {task?.purpose === 'book' && !emptyConversation && <button disabled={running} onClick={() => void startConversation(true, 'next')}>构思第一章</button>}
        <button disabled={running} onClick={() => { setShelf(false); setTaskPanel(value => !value); showDock(); }}
          aria-expanded={taskPanel}>创作任务</button>
        <button type="button" aria-expanded={focus !== 'chat'} onClick={() => focus === 'chat' ? openWorkspaceShelf() : setFocus('chat')}>
          <Icon name="folder" size={15}/>{focus === 'chat' ? '打开工作区' : '收起工作区'}</button>
      </div></div>
    <details className="writing-scope-menu">
      <summary>范围 <strong>{selectedScope?.label}</strong></summary>
      <div className="writing-scope-tabs" aria-label="创作范围">{writingScopes.map(item => <button key={item.id} className={scope === item.id ? 'selected' : ''}
      aria-pressed={scope === item.id} disabled={running || (item.id === 'chapter' && !formal.length)} onClick={() => void changeScope(item.id)}>{item.label}</button>)}
      <div className="writing-target-fields">{planning ? (scope === 'next' || scope === 'volume') && <label>{scope === 'next' ? '章号' : '卷号'}<input aria-label={scope === 'next' ? '章号' : '卷号'} type="number" min="1" max="99999"
        value={number} disabled={running} onChange={async e => { const value = e.target.value;
          try { await window.storyDesk.flushNow(); assignTask(null); setReference(null); (scope === 'next' ? setChapterNumber : setVolumeNumber)(value); }
          catch (err) { setError((err as Error).message); } }}/></label>
        : <><label>章节<select aria-label="章节" value={document?.id || ''} disabled={running || !chapters.length} onChange={async e => { const value = e.target.value;
          try { await window.storyDesk.flushNow(); assignTask(null); setReference(null); setDocumentId(value); setScene(''); } catch (err) { setError((err as Error).message); } }}>{chapters.map(d => <option key={d.id} value={d.id}>{d.title}{d.kind === 'draft' ? ` · ${d.chapterMaterial?.label || d.path.split('/').at(-1)}` : ''}</option>)}</select></label>
          {scope === 'draft' && <div className="studio-actions">
            <button disabled={running} onClick={() => setNewDraft({ chapter: validMaterialChapter || nextChapter, title: '' })}>新建草稿</button>
            <button disabled={running} onClick={() => setDraftImport({ chapter: validMaterialChapter || nextChapter })}>导入草稿</button>
          </div>}
          <label title={sceneId === 'whole' ? '读取本章开头最多 6500 字符供讨论，长稿可引用选段。' : '用于指定 Agent 阅读和起草的范围，右侧编辑仍操作整份文件。'}>AI 读取范围<select aria-label="AI 读取范围" value={sceneId || ''} disabled={running} onChange={async e => { const value = e.target.value;
            try { await window.storyDesk.flushNow(); assignTask(null); setReference(null); setScene(value); } catch (err) { setError((err as Error).message); } }}><option value="">从章末接写</option><option value="whole">讨论本章</option>
            {scenes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></>}</div>
      {!planning && <small className="writing-scope-explanation">
        {sceneId === 'whole' ? '读取本章前 6500 字供讨论。也可以从右侧引用选段。' : sceneId ?
          '以所选场景讨论或生成候选稿。' : '参考章末，候选稿接在当前章后。'} 编辑请用右侧文稿。
      </small>}
      </div>
    </details>
    {bookGuide && !emptyConversation && <details className="book-progress-details"><summary>新书设计进度
      {bookDecisions.some(row => row.review.length) && <small> · 有构思待复核</small>}
    </summary>{bookProgress}</details>}
    <div ref={layout} className="cowriting-layout" style={{ '--chat-width': `${chatWidth}%` } as React.CSSProperties}>
      <section className="cowriting-chat" aria-labelledby="cowriting-chat-heading"><h2 className="studio-visually-hidden" id="cowriting-chat-heading">写作对话</h2>
        <div className="cowriting-transcript" ref={transcript} aria-label="创作对话记录" tabIndex={0} onScroll={event => {
          const panel = event.currentTarget;
          followTranscript.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
        }}>
          {emptyConversation && <div className="cowriting-empty"><h3>{bookGuide ? '从一个点子开始' : task?.purpose === 'character' ? '讨论这个人物的人设' :
            scope === 'next' ? '这一章，要往哪里推进？' : scope === 'stage' ? '这段剧情要推进到哪里？' : scope === 'volume' ? '这一卷要完成什么？' : scope === 'work' ? '从哪条主线开始梳理？' : '想怎么改，或怎么接着写？'}</h3>
            <p>{bookGuide ? '说一个画面、一个人物，或一句你想写的故事。助手会帮你整理，并问下一步最值得想清的事。' : task?.purpose === 'character' ? '可以讨论身份、动机或关系，把合适的思路整理为候选。' :
              `${selectedScope?.description}。讨论结果由你决定采用。`}</p>
            {bookGuide && <>{bookProgress}
              <button className="text-button" onClick={() => void startConversation(true, 'next')}>直接构思第一章</button></>}
            {task?.purpose !== 'character' && <><ConversationSources key={freshConversation ? 'new' : task?.id || 'initial'} ctx={ctx} disabled={running} references={references} scope={scope}
              onSelect={selectConversationSource} onScope={value => void selectPlanningScope(value)}/>
              {preferredDraft && <button className="text-button" disabled={running}
                onClick={() => ctx.navigate({ page: 'cowriting', documentId: preferredDraft.id })}>继续第{validMaterialChapter}章草稿</button>}</>}</div>}
          {threadRows.map(row => {
            const original = row.role === 'assistant' && row.mode === 'discuss'
              ? storedRows.slice(0, storedRows.indexOf(row)).filter(item => item.role === 'author').at(-1) : undefined;
            const draftEdit = row.workspaceAction?.type === 'edit' ? row.workspaceAction : null;
            const latestEdit = draftEdit?.appliedHash && ctx.work.documents.some(file =>
              file.id === draftEdit.documentId && file.hash === draftEdit.appliedHash);
            return <article key={row.id} className={`cowriting-message ${row.role}`}>
            {row.role === 'assistant' && <div className="cowriting-message-heading">
              <small>{row.toolFailure ? '创作助手 · 查询未完成' : row.incomplete ? '创作助手 · 未完成的回复' : row.sourceStale ? '创作助手 · 依据已更新' : '创作助手'}</small>
              {row.hiddenAt && <small>已删除</small>}</div>}
            {row.role === 'assistant' && row.elapsedMs !== undefined && <ReplyActivity
              seconds={Math.round(row.elapsedMs / 1000)} activity={row.activity || []} expanded={!!openedActivities[row.id]}
              onToggle={expanded => setOpenedActivities(previous => ({ ...previous, [row.id]: expanded }))}/>}
            {row.draftAction && <button type="button" disabled={running}
              onClick={() => void openDraftAction(row.draftAction!)}>{row.draftAction.publish ? '核对发布' : '核对草稿整理'}</button>}
            {row.workspaceAction?.type === 'archive' && !handledActions.includes(row.id) && <button type="button" disabled={running}
              onClick={() => { if (row.workspaceAction?.type === 'archive') setWorkspaceReview({ id: row.id, action: row.workspaceAction }); }}>核对归档文件</button>}
            {row.role === 'author' ? <div className="author-message-bubble">
              {row.referenceTitle && <small>引用 {row.referenceTitle}</small>}{row.hiddenAt && <small>已删除</small>}
              {messageEdit?.id === row.id ? <div className="author-edit-body">
              <textarea aria-label="编辑历史消息" rows={4} maxLength={promptLimit} value={messageEdit.text}
                onChange={event => setMessageEdit({ id: row.id, text: event.target.value })}/>
              <div className="studio-actions author-edit-actions"><button onClick={() => setMessageEdit(undefined)}>取消</button>
                <button className="primary" disabled={!messageEdit.text.trim() || running}
                  aria-label="发送编辑后的消息" title="发送编辑后的消息"
                  onClick={() => void forkMessage(row.id, messageEdit.text, !!row.imageNames?.length)}><Icon name="send" size={16}/></button></div>
            </div> : <AuthorMessageText text={row.text}/>}
            {!!row.imageNames?.length && <small>{row.imageNames.join('、')}</small>}
            </div> : <Markdown text={row.text}/>}
            {row.memorySuggestion && !row.hiddenAt && <div className="panel memory-propose">
              <h4>长期记忆建议</h4>
              <p className="memory-content">{row.memorySuggestion.text}</p>
              <p className="muted small-text">本作品 · 依据「{row.memorySuggestion.quote}」</p>
              {row.memorySuggestion.id
                ? <button type="button" onClick={() => ctx.navigate({ page: 'memory', quote: 'candidate:' + row.memorySuggestion!.id })}>核对记忆建议</button>
                : <button type="button" disabled={memorySaving || running} onClick={async () => {
                  const suggestion = row.memorySuggestion!;
                  setMemorySaving(true);
                  try {
                    const saved = await call('memlayerPropose', { documentId: targetId, sceneId, taskId: taskRef.current?.id || null,
                      scope: 'work', text: suggestion.text, sourceId: suggestion.sourceId });
                    ctx.navigate({ page: 'memory', quote: 'candidate:' + saved.id });
                  } catch (error: any) {
                    ctx.notify(error?.message || '暂时无法提交候选', true);
                  } finally { setMemorySaving(false); }
                }}>重试提交候选</button>}
            </div>}
            {memoryPropose?.id === row.id && <div className="panel memory-propose">
              <h4>存为共享记忆（候选，待核对）</h4>
              <p className="muted small-text">来源：本条原话（{row.id}）。提交后只是候选，只有你在「记忆与规则 → 共享记忆」里确认，才会被后续对话读取。</p>
              <textarea aria-label="候选原话" rows={4} maxLength={2000} value={memoryPropose.text}
                onChange={event => setMemoryPropose({ ...memoryPropose, text: event.target.value })}/>
              <div className="studio-actions">
                <select aria-label="记忆范围" value={memoryPropose.scope}
                  onChange={event => setMemoryPropose({ ...memoryPropose, scope: event.target.value })}>
                  {memoryPropose.scopes.map(item => <option key={item.scope} value={item.scope}>{item.label}</option>)}
                </select>
                <button type="button" onClick={() => setMemoryPropose(null)}>取消</button>
                <button type="button" className="primary" disabled={memorySaving || !memoryPropose.text.trim()}
                  onClick={() => void saveMemoryPropose()}>{memorySaving ? '提交中…' : '提交候选'}</button>
              </div>
            </div>}
            {draftEdit && <ReplyFileCard name={draftEdit.title} path={draftEdit.path}
              caption={`${draftEdit.appliedHash && !latestEdit ? '已写入，之后有修订' : draftEdit.applied ? '已写入' : '待应用'} · ${draftEdit.edits.length} 处修改`}
              onOpen={() => openDraftFile(draftEdit.documentId)}
              action={{
                label: applyingDraftEdit === row.id ? '正在写入…' : draftEdit.appliedHash && !latestEdit ? '打开现稿' : draftEdit.applied ? '查看修改' : '核对修改',
                title: draftEdit.applied ? '在原稿中查看' : '应用本条建议并打开原稿',
                primary: !draftEdit.applied, disabled: !draftEdit.applied && (running || !!applyingDraftEdit),
                onClick: () => draftEdit.applied ? openDraftFile(draftEdit.documentId, latestEdit ? draftEdit.appliedHash : undefined) : void applyDraftChange(row.id, draftEdit),
              }}/>}
            {row.artifact && <ReplyFileCard name={row.artifact.title} path={row.artifact.path}
              caption={row.artifact.kind === 'draft' ? '章节草稿' : '剧情设计'} onOpen={() => {
                const doc = ctx.work.documents.find(item => item.path === row.artifact!.path && !item.historical);
                if (doc) ctx.navigate({ page: 'reader', documentId: doc.id });
                else ctx.notify('文件当前不可用，请检查本地路径。', true);
              }}/>}
            {row.bookDesign?.length && !row.hiddenAt ? <BookDesignCard items={row.bookDesign} disabled={running || task?.status === 'archived'}
              onOpen={path => {
                const doc = ctx.work.documents.find(item => item.path === path);
                if (!doc) { ctx.notify('文件当前不可用，请检查本地路径。', true); return; }
                ctx.navigate(doc.kind === 'character'
                  ? { page: 'characters', characterId: ctx.work.characters.find(person => person.primarySourceId === doc.id)?.id }
                  : { page: 'reader', documentId: doc.id });
              }}
              onSave={async (itemId, text) => {
                const saved = await ctx.act(() => call('applyBookDesign', { taskId: task?.id, messageId: row.id, itemId, text }), '设计已保存到本作品');
                if (!saved) return false;
                await reload();
                return true;
              }}/> : null}
            {row.bookDecisionProposals?.length && !row.hiddenAt ? <BookDecisionProposals items={row.bookDecisionProposals}
              decisions={bookDecisions} disabled={running || task?.status === 'archived'}
              onSave={async (itemId, input) => {
                const saved = await ctx.act(() => call('applyBookDecision', { taskId: task?.id, messageId: row.id, itemId, ...input }),
                  '构思已记录');
                if (!saved) return false;
                await reload();
                return true;
              }}/> : null}
            {row.stagePlan && !row.hiddenAt && <StagePlanCard proposal={row.stagePlan} disabled={running || task?.status === 'archived'}
              onOpen={() => ctx.navigate({ page: 'plot', tab: 'plot_arc' })}
              onSave={async () => {
                const saved = await ctx.act(() => call('applyCowritingStagePlan', { documentId: targetId, sceneId, taskId: task?.id ?? null, messageId: row.id }),
                  '已保存到阶段计划');
                if (!saved) return false;
                await reload();
                return true;
              }}/>}
            {row.reviewAction && <button type="button" onClick={() => ctx.navigate({ page: 'manuscript',
              documentId: row.reviewAction!.documentId, reviewBatch: row.reviewAction })}>打开稿件处理清单</button>}
            <div className="cowriting-message-actions">
              <button type="button" aria-label="复制消息" title="复制消息" onClick={() => void navigator.clipboard.writeText(row.text)
                .then(() => ctx.notify('已复制')).catch(() => ctx.notify('复制未完成', true))}><Icon name="copy" size={15}/></button>
              {row.role === 'author' && !row.hiddenAt && task && <button type="button" aria-label="编辑消息" title="编辑消息"
                disabled={running} onClick={() => setMessageEdit({ id: row.id, text: row.text })}><Icon name="edit" size={15}/></button>}
              {row.role === 'author' && !row.hiddenAt && <button type="button" aria-label="存为共享记忆" title="存为共享记忆（先提交候选）"
                disabled={running || memorySaving} onClick={() => void openMemoryPropose(row)}><Icon name="save" size={15}/></button>}
              {row.role === 'assistant' && task && !row.hiddenAt && <button type="button" aria-label="从这里新建分支" title="从这里新建分支"
                disabled={running || voicePhase !== 'idle'} onClick={() => void forkMessage(row.id)}><Icon name="branch" size={15}/></button>}
              {task && !row.hiddenAt && original && !original.hiddenAt && <button type="button"
                aria-label="重新生成回复" title="在新分支重新生成，保留现有回复" disabled={running || voicePhase !== 'idle' || !modelReady}
                onClick={() => void forkMessage(original.id, original.text, !!original.imageNames?.length)}><Icon name="refresh" size={15}/></button>}
              {row.role === 'assistant' && row.incomplete && !row.toolFailure && !row.hiddenAt && row.mode === 'discuss' &&
                row.id === storedRows.at(-1)?.id && row.sourceHash === currentView?.sourceHash && currentView?.failure?.code !== 'AI_CONTENT_FILTER' && <button type="button"
                  disabled={!canSend || voicePhase !== 'idle'} onClick={() => void send('discuss', undefined, undefined, row.id)}>从断点继续</button>}
              {task && row.role === 'author' && row.hiddenAt && <button disabled={running} onClick={() => void toggleHidden(row.id, false)}>恢复消息</button>}
              {task && row.role === 'assistant' && <details className="cowriting-message-menu"><summary aria-label="消息更多操作" title="消息更多操作"><Icon name="dots" size={16}/></summary>
                <div>
                  {row.role === 'assistant' && !row.incomplete && !row.sourceStale && row.mode === 'discuss' && !row.hiddenAt && <button
                    disabled={running || organizingMessage || viewKey !== inputKey} onClick={() => void organizeMessage(row.id)}>整理为候选设定</button>}
                  <button disabled={running} onClick={() => void toggleHidden(row.id, !row.hiddenAt)}>{row.hiddenAt ? '恢复消息' : '删除消息'}</button>
                </div></details>}
              {row.role === 'assistant' && row.at && <time dateTime={row.at}>{dateText(row.at)}</time>}
            </div>
          </article>; })}
          {storedRows.some(row => row.hiddenAt) && <button className="text-button" onClick={() => setShowHidden(value => !value)}>
            {showHidden ? '收起已删除消息' : '查看已删除消息'}</button>}
          {pendingMessage && <article className="cowriting-message author"><div className="author-message-bubble"><AuthorMessageText text={pendingMessage}/></div></article>}
          {(sending || stage || liveReply) && <article className="cowriting-message assistant cowriting-live-reply"
            aria-label={sending || stage ? '正在输出的回复' : '未完成的回复'}>
            <div className="cowriting-message-heading"><small>创作助手</small></div>
            {(sending || stage) && <><span className="studio-visually-hidden" role="status">{stage || '正在完成本轮'}</span>
              <ReplyActivity stage={stopping ? '正在停止回复' : stage || '正在完成本轮'} seconds={elapsed} activity={liveActivities}
                expanded={liveDetailsOpen} onToggle={expanded => { keepTurnDetails.current = expanded; setLiveDetailsOpen(expanded); }}/></>}
            {liveReply && <p>{liveReply}</p>}
          </article>}</div>
        <div className="cowriting-composer" aria-busy={running}>
          {error && <div className="notice danger" role="alert">{error}</div>}
          {!error && !running && currentView?.error && <div className="notice" role="status">{currentView.error}</div>}
          {!running && currentView?.failure && currentView.failure.code !== 'CANCELLED' && <details className="cowriting-failure">
            <summary>查看中断详情</summary><span>{currentView.failure.activity} · {currentView.failure.code} · 已请求 {currentView.failure.requests} 次</span>
          </details>}
          {!running && view?.interrupted && <div className="notice">上轮中断，你的要求已保留，可以重试。</div>}
          {pendingEdits && <div className="notice">讨论使用已保存的版本。保存编辑稿后，助手才能读到改动。
            <button className="text-button" disabled={running} onClick={() => openDocumentPane(planning || tab === 'outline' ? 'outline' : 'document')}>
              查看编辑稿
            </button>
          </div>}
          {task?.status === 'archived' && <div className="notice">此任务已归档，可在创作任务中恢复后继续。</div>}
          {!modelReady && !modelBusy && <div className="notice">{launcherModel && model.enabled
            ? `${model.title || model.model} 尚未就绪，可在下方模型菜单启动。` : '请在下方选择写作模型。'}</div>}
          {!!waitingFollowUps.length && <section className="cowriting-follow-ups" aria-label="待发送消息">
            <div className="cowriting-queue-heading" role="status">{queuePaused ? '发送已暂停' : replying ? '当前回复结束后发送' : '待发送'} · {waitingFollowUps.length} 条</div>
            <ol>
              {waitingFollowUps.map((row, index) => <li key={row.id}>
                {queueEdit?.id === row.id ? <>
                  <textarea aria-label={`编辑待发送消息 ${index + 1}`} rows={3} maxLength={promptLimit}
                    value={queueEdit.text} onChange={e => setQueueEdit({ id: row.id, text: e.target.value })}/>
                  <div className="studio-actions">
                    <button type="button" disabled={queueBusy || !queueEdit.text.trim()} onClick={async () => {
                      const text = queueEdit.text.trim();
                      if (await persistFollowUps(rows => rows.map(item => item.id === row.id ? { ...item, text } : item))) setQueueEdit(undefined);
                    }}>保存编辑</button>
                    <button type="button" disabled={queueBusy} onClick={() => setQueueEdit(undefined)}>取消编辑</button>
                  </div>
                </> : <>
                  <p>{row.text}</p>
                  <div className="studio-actions">
                    {(replying || queuePaused) && <button type="button" disabled={queueBusy || stopping || !replying && !canSend}
                      title={replying ? '中断本轮回复，立即发送这条' : '立即发送这条待发送消息'}
                      onClick={() => void sendFollowUpNow(row)}>{replying ? '立即插入' : '立即发送'}</button>}
                    <button type="button" disabled={queueBusy} onClick={() => setQueueEdit({ id: row.id, text: row.text })}>编辑</button>
                    <button type="button" disabled={queueBusy} onClick={() => void persistFollowUps(rows => rows.filter(item => item.id !== row.id))}>撤销</button>
                  </div>
                </>}
              </li>)}
            </ol>
          </section>}
          <div className="studio-composer-input">
          {!sending && visibleFile && <div className="studio-ambient-file" title={visibleFile.path}>
            <Icon name="book" size={14}/><span>右侧 · {visibleFile.title}</span></div>}
          {!sending && references.length > 0 && <div className="studio-reference-chips" aria-label="本轮引用">{references.map(item => <span className="studio-reference-chip" key={item.kind + item.id}>
            <button type="button" title={item.kind === 'document' && item.selection ? item.selection.text : item.title}
              onClick={() => openReference(item)}><span>@{item.title}{item.kind === 'document' && item.selection ? ` · 「${item.selection.text.slice(0, 24)}」` : ''}</span></button>
            <button type="button" aria-label={`移除引用 ${item.title}`} disabled={running}
              onClick={() => setReferences(rows => rows.filter(row => row.id !== item.id || row.kind !== item.kind))}><Icon name="close" size={13}/></button></span>)}</div>}
          {!!images.length && <div className="studio-reference-chips" aria-label="本轮图片">{images.map((image, index) => <span className="studio-reference-chip" key={`${image.name}-${index}`}>
            <img src={`data:${image.mimeType};base64,${image.data}`} alt=""/><span>{image.name}</span>
            <button type="button" aria-label={`移除图片 ${image.name}`} disabled={running}
              onClick={() => setImages(current => current.filter((_, i) => index !== i))}><Icon name="close" size={13}/></button>
          </span>)}</div>}
          <label className="studio-visually-hidden" htmlFor="cowriting-message">{reference ? '讨论要求' : '写作要求'}</label>
          <textarea ref={composerInput} id="cowriting-message" value={message} maxLength={promptLimit} rows={1} disabled={!composerLoaded}
            onChange={e => setMessage(e.target.value)} onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
                && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault();
                if (replying) void queueMessage();
                else if (ready) void send('discuss');
              }
            }}
            placeholder={replying ? '继续输入，发送后排队' : '写下问题、构思或修改要求'}/>
          <div className="cowriting-compose-footer">
            <div className="studio-model-line">
            <details className="composer-attachment-menu" ref={attachmentMenu}
              onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
              <summary aria-label="添加附件" title="添加附件"><Icon name="plus" size={17}/></summary>
              <div className="composer-attachment-options">
              <ImportTextButton ctx={ctx} maxFiles={8 - references.length} onBusy={setImportingText}
              disabled={running || loadedInputKey !== inputKey || references.length >= 8 || task?.status === 'archived'}
              onImported={attachImported}/>
              <button type="button" disabled={running || loadedInputKey !== inputKey || references.length >= 8 || task?.status === 'archived'} onClick={() => {
                if (attachmentMenu.current) attachmentMenu.current.open = false;
                setDraftImport({ chapter: validMaterialChapter || nextChapter, attachToConversation: true });
              }}>导入到章节草稿</button>
              <button type="button" disabled={running || images.length >= 4} onClick={() => void pickImages()}>添加图片</button>
              </div>
            </details>
            <details className="composer-attachment-menu composer-permission"
              onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
              <summary aria-label={!pendingEdits && permissionKey && draftWriteKey === permissionKey ? '本轮权限：可写草稿' : '本轮权限：只读'}
                title={!pendingEdits && permissionKey && draftWriteKey === permissionKey ? '本轮可写草稿' : '本轮只读'}>
                <Icon name={!pendingEdits && permissionKey && draftWriteKey === permissionKey ? 'edit' : 'shield'} size={17}/>
              </summary>
              <div className="composer-attachment-options" aria-label="本轮文件权限">
                <button type="button" aria-pressed={pendingEdits || !permissionKey || draftWriteKey !== permissionKey} disabled={running}
                  onClick={event => { setDraftWriteKey(''); event.currentTarget.closest('details')?.removeAttribute('open'); }}>只读</button>
                <button type="button" aria-pressed={!pendingEdits && !!permissionKey && draftWriteKey === permissionKey}
                  disabled={running || pendingEdits || !writableDraft || task?.purpose === 'character'}
                  onClick={event => { setDraftWriteKey(permissionKey); event.currentTarget.closest('details')?.removeAttribute('open'); }}>
                  允许本轮写入草稿
                </button>
                {writableDraft && <small title={writableDraft.path}>{writableDraft.title}</small>}
              </div>
            </details></div>
            <div className="studio-actions studio-composer-controls">
              {!running && !planning && !reference && task?.purpose !== 'character' && sceneId !== 'whole' && <button
                className="text-button studio-candidate-submit" disabled={!ready || pendingEdits || document?.readOnly}
                onClick={() => void send('draft')}>生成候选稿</button>}
              <WritingModels ctx={ctx} running={running || voicePhase !== 'idle'} onBusy={setModelBusy} onReady={setModelAvailable}/>
              <VoiceInput key={inputKey} ctx={ctx} disabled={running || loadedInputKey !== inputKey} phase={voicePhase}
                onPhase={setVoicePhase} sendRecording={sendRecording} onText={(text, sendAfter) => {
                  const words = [message.trimEnd(), text].filter(Boolean).join('\n');
                  if (words.length > promptLimit) {
                    setMessage(words.slice(0, promptLimit));
                    ctx.notify(`转写后超过 ${promptLimit} 字符，已保留输入区上限内的文字，请核对后发送。`, true);
                    return;
                  }
                  setMessage(words);
                  if (sendAfter) void send('discuss', words);
                  else focusComposer();
                }}/>
              {replying && <button type="button" className="studio-arrow-send studio-stop-reply"
                aria-label="停止回复" title="停止回复" disabled={stopping} onClick={() => void stop()}><Icon name="stop" size={17}/></button>}
              <button type="button" className="primary studio-arrow-send" aria-label={replying ? '加入待发送' : voicePhase === 'recording' ? '转写并发送' : retryMessageId ? '继续回答这条' : '发送讨论'}
                title={replying ? (followUps.length >= 32 ? '待发送队列已满' : '排队发送 · Enter') : voicePhase === 'recording' ? '转写并发送' : '发送 · Enter'}
                disabled={replying ? !canQueue : voicePhase === 'recording' ? !canSend : !ready}
                onClick={() => replying ? void queueMessage() : voicePhase === 'recording' ? sendRecording.current?.() : void send('discuss')}><Icon name="send" size={18}/></button>
            </div>
          </div>
          </div>
        </div></section>
      <div className="writing-resizer" role="separator" aria-label="调整对话宽度" aria-orientation="vertical" aria-valuemin={34} aria-valuemax={70} aria-valuenow={Math.round(chatWidth)} tabIndex={0}
        onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); resize(e.key === 'Home' ? 34 : e.key === 'End' ? 70 : chatWidth + (e.key === 'ArrowRight' ? 2 : -2)); } }}
        onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId) && layout.current) {
          const box = layout.current.getBoundingClientRect(); resize((e.clientX - box.left) / box.width * 100); } }}/>
      <section className="writing-workarea" aria-label="右侧工作区">
        <div className="dock-tab-bar" aria-label="工作区标签">
          <button type="button" className="dock-open-tab" title="新建工作区标签" aria-label="新建工作区标签" aria-pressed={shelf} onClick={openWorkspaceShelf}><Icon name="plus" size={16}/></button>
          <button type="button" aria-pressed={!shelf && !tool && !taskPanel} onClick={() => openDocumentPane()}>当前文稿</button>
          {dockTabs.map(item => {
            const active = !shelf && !taskPanel && tool?.key === item.id;
            return <div className="dock-tab" data-active={active || undefined} key={item.id}>
              <button type="button" title={item.label} aria-pressed={active}
                onClick={() => { setShelf(false); setTaskPanel(false); item.onSelect(); }}>{item.label}</button>
              {active && <button type="button" className="dock-close-tab" title="关闭标签"
                aria-label={`关闭标签 ${item.label}`} onClick={item.onClose}><Icon name="close" size={13}/></button>}
            </div>;
          })}
        </div>
        {shelf && <WorkspaceShelf onNavigate={nav => { setShelf(false); ctx.navigate(nav); }} onDocument={() => openDocumentPane()} onEvidence={() => openDocumentPane('reference')}/>}
        <div className="studio-pane-heading" hidden={shelf}>
        {taskPanel ? <div className="workspace-active-title">创作任务</div> :
          tool ? <div id="writing-tab-tool" className="workspace-active-title">{tool.label}</div>
          : <div className="writing-work-tabs" role="tablist" aria-label="创作工作区">
            {tabs.map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} aria-controls="writing-work-content" id={`writing-tab-${item.id}`}
              disabled={item.id === 'materials' && !validMaterialChapter} onClick={async () => { try { await window.storyDesk.flushNow(); setTaskPanel(false); setTab(item.id); } catch (e) { setError((e as Error).message); } }}>{item.label}</button>)}
          </div>}
        <div className="studio-actions">{!taskPanel && tool && onBackTool && <button onClick={onBackTool}>上一步</button>}
          {!taskPanel && tool && <button aria-label="关闭工具，返回当前文稿" onClick={onCloseTool}>{tab === 'materials' ? '返回本章资料' : '返回文稿'}</button>}
          <button className="writing-focus-document" aria-pressed={focus === 'document'} onClick={() => setFocus(focus === 'document' ? 'split' : 'document')}>{focus === 'document' ? '恢复并排' : tool ? '专注工具' : '专注文稿'}</button></div></div>
        {taskPanel && <div className="writing-work-content content-tasks">
          <CreativeTasks key={task?.id || 'new'} tasks={tasks} task={task} disabled={running} onOpen={openTask}
            scopeLabel={row => writingScopes.find(item => item.id === (row.kind === 'chapter' ? manuscriptScope(row.documentId) : row.kind))?.label || row.kind}
            onCreate={async goal => { try { await createTask(goal); } catch (e) { setError((e as Error).message); } }}
            onSave={async patch => { try { await persistTask(patch); ctx.notify('任务记录已保存'); } catch (e) { setError((e as Error).message); } }}
            onClose={() => setTaskPanel(false)}/>
        </div>}
        <div id="writing-work-content" role="tabpanel" aria-labelledby={`writing-tab-${tab}`} hidden={!!tool || taskPanel || shelf} className={`writing-work-content content-${tab}`}>
          {tab === 'materials' && validMaterialChapter && <ChapterMaterials key={validMaterialChapter} ctx={ctx}
            chapter={validMaterialChapter} drafts={allDrafts.filter(draft => draft.chapter === validMaterialChapter)} formal={chapterFormal} disabled={running || dirty}
            onOutline={design => void discussChapterOutline(validMaterialChapter, design)}
            onCreateDraft={() => setNewDraft({ chapter: validMaterialChapter, title: '' })}
            onImportDraft={() => setDraftImport({ chapter: validMaterialChapter, stayInMaterials: true })}
            onHideDraft={id => { if (id === targetId) ctx.navigate({ page: 'cowriting', newChapterNumber: validMaterialChapter }); }}/>}
          {tab === 'outline' && validMaterialChapter && chapterDesigns.length > 0 && <section className="chapter-materials" aria-label="已有剧情设计">
            <h3>第{validMaterialChapter}章已有剧情设计</h3>
            <ul>{chapterDesigns.map(design => <li key={design.id} className="chapter-material-row">
              <div><strong>{design.title}</strong><small className="studio-path">{design.path.split('/').at(-1)}</small></div>
              <div className="studio-actions"><button onClick={() => ctx.navigate({ page: 'reader', documentId: design.id })}>查看原稿</button>
                <button disabled={running} onClick={() => void discussChapterOutline(validMaterialChapter, design)}>引用这份设计</button></div>
            </li>)}</ul>
          </section>}
          {(tab === 'document' && !planning || tab === 'outline' && planning) && currentView?.documentId === targetId &&
            (planning || source?.id === targetId && source.hash === currentView.sourceHash) && <WritingCanvas key={targetId} documentId={targetId} sourceHash={currentView.sourceHash}
            sourceText={currentText} title={planning ? currentView.range.label : source?.title || title} planning={planning} readOnly={!!document?.readOnly && !planning} disabled={running}
            recovery={currentView.recoveryDraft} onSave={saveText} onRecover={recover} onClearRecovery={async () => { await call('clearDraft', { documentId: targetId }); await reload(); }}
            onQuote={quote} onAnnotate={annotate} onDirty={setDirty} onLoadReply={() => latestUsableAnswer || ''}
            canLoadReply={!!latestUsableAnswer} onOpenChapter={scope === 'next' ? openChapter : undefined}
            openChapterLabel={chapterFormal ? '打开本章正文' : undefined}
            draft={scope === 'draft'} sourcePath={source?.path} onPublish={scope === 'draft' ? () => setPublish(true) : undefined}
            fileAction={source ? <RevealSourceButton ctx={ctx} documentId={source.id} compact/> : currentView.outlineDocumentId ?
              <RevealSourceButton ctx={ctx} documentId={currentView.outlineDocumentId} compact/> : undefined}
            onCheck={!planning && source ? () => ctx.navigate({ page: 'manuscript', documentId: source.id, reviewRequestId: crypto.randomUUID() }) : undefined}/>}
          {tab === 'document' && scope === 'draft' && !document && <div className="cowriting-empty">
            <p>这里存放准备编辑、核对和发布的章节草稿。</p>
            <button onClick={() => setNewDraft({ chapter: nextChapter, title: '' })}>新建章节草稿</button>
            <button onClick={() => setDraftImport({ chapter: validMaterialChapter || nextChapter })}>导入草稿</button>
          </div>}
          {tab === 'outline' && !planning && linkedOutline?.documentId === `outline_chapter_${document?.chapter}` && <WritingCanvas key={`outline-${document?.chapter}`} documentId={linkedOutline.documentId} sourceHash={linkedOutline.sourceHash}
            sourceText={linkedOutline.outlineText || ''} title={linkedOutline.range.label} planning readOnly={false} disabled={running} recovery={linkedOutline.recoveryDraft}
            onSave={(text, expectedHash) => saveText(text, expectedHash, linkedOutline.documentId)} onRecover={recoverOutline}
            onClearRecovery={async () => { await call('clearDraft', { documentId: linkedOutline.documentId }); setLinkedOutline(await call('getCowriting', { documentId: linkedOutline.documentId })); }}
            fileAction={linkedOutline.outlineDocumentId && <RevealSourceButton ctx={ctx} documentId={linkedOutline.outlineDocumentId} compact/>}
            onQuote={quote} onAnnotate={annotate} onDirty={setDirty} onLoadReply={() => latestUsableAnswer || ''}
            canLoadReply={!!latestUsableAnswer}/>}
          {tab === 'trials' && <TrialCompare key={`${targetId}-${task?.id || 'legacy'}-${view?.revisions?.length || 0}`} ctx={ctx} revisions={view?.revisions || []}
            original={currentText} disabled={running} onReview={id => void openReview(id)} onQuote={quote}
            onTryAgain={() => { setMessage('按已定情节另试一种写法，保留当前原稿和已有候选稿。希望这次：'); setFocus('split'); }}/>}
          {tab === 'reference' && <WritingContext key={inputKey} ctx={ctx} manifest={contextManifest} lastManifest={lastManifest} loading={contextLoading} error={contextError} task={task}
            disabled={running} onRefresh={() => void refreshContext()} onReferences={async ids => { try { await persistTask({ referenceIds: ids }); } catch (e) { setError((e as Error).message); } }}/>}
          {tab === 'stages' && <StageProgress ctx={ctx} chapter={scope === 'next' ? Number(chapterNumber) || null : planning ? null : document?.chapter ?? null}
            disabled={running} onPlan={scope !== 'stage' ? () => void selectPlanningScope('stage').then(focusComposer) : undefined}
            onDiscuss={() => { setMessage((scope === 'stage' ? '核对阶段计划。' : '核对当前章适用的阶段计划。') +
              '按节点列出已完成、未完成、已改序和有内容冲突的部分，指出对应的确认事件，并提出可由我核对的调整。'); setFocus('split'); }}/>}
          {tab === 'review' && <section className="writing-review"><div className="studio-section-heading"><div><h2>选段批注</h2></div></div>
            {!planning && <>
              {!annotations.length && <p className="studio-muted">进入正文编辑，选中原文并填写批注，可以积累多处后一次交给 AI。</p>}
              {annotations.map(annotation => <article className="writing-annotation" key={annotation.id}><label className="studio-check"><input type="checkbox"
                checked={selectedAnnotations.includes(annotation.id)} disabled={running || annotation.sourceHash !== view?.sourceHash}
                onChange={e => setSelectedAnnotations(ids => e.target.checked ? [...ids, annotation.id] : ids.filter(id => id !== annotation.id))}/>
                {annotation.sourceHash === view?.sourceHash ? '本次提交' : '原稿已变，此批注仅供追溯'}</label><blockquote>{annotation.quote}</blockquote><p>{annotation.note}</p>
                <button disabled={running} onClick={() => void persistTask({ annotations: annotations.filter(row => row.id !== annotation.id) }).catch(e => setError((e as Error).message))}>移除批注</button></article>)}
              <div className="studio-actions"><button disabled={running || !selectedAnnotations.length} onClick={() => { setMessage('请逐项处理所选批注，保持其他情节和文字不变。'); setFocus('split'); }}>准备批注要求</button>
                <button className="primary" disabled={!ready || pendingEdits || !!reference || task?.purpose === 'character' || !selectedAnnotations.length || document?.readOnly} onClick={() => void send('annotate')}>按所选批注生成修改</button></div></>}
            {planning && <p className="studio-muted">{scope === 'stage' ? '阶段计划由你核对后保存到剧情线。' : '卷纲定案可在剧情规划中设置适用章序。'}</p>}
          </section>}
        </div>
        <ResearchCitation.Provider value={{ ready: !running && loadedInputKey === inputKey, insert: citeSearchResults }}>
          <DiscussionComposer.Provider value={{
            ready: !running && loadedInputKey === inputKey, writingDocumentId, onManuscript: setWorkspaceReviewDocument,
            references, attach: attachReference, replaceDocument, onDraftEdit: () => { void reload(); }, startCharacter: startCharacterTask,
            startStage: () => startConversation(true, 'stage'),
            latestAnswer: latestUsableAnswer || '',
            preparePrompt: prompt => { setMessage(value => [value.trimEnd(), prompt].filter(Boolean).join('\n\n').slice(0, promptLimit)); focusComposer(); },
          }}>
            {dockTabs.map(item => {
              const active = tool?.key === item.id && !taskPanel && !shelf;
              return <div key={item.id} id={active ? 'workspace-tool-content' : undefined}
                aria-label={item.label} hidden={!active} tabIndex={0} className="workspace-tool-content">{item.content}</div>;
            })}
          </DiscussionComposer.Provider>
        </ResearchCitation.Provider>
      </section></div>
    <div className="studio-statusbar"><span>{dirty ? '有未保存编辑' : view?.hasDraft ? '有恢复草稿待处理' : '文稿与对话各自保留位置'}</span><span>{task ? '任务记录保存在本作品目录' : '发送时建立创作任务'}</span></div>
    {draftImport && <DraftImport ctx={ctx} chapter={draftImport.chapter} onClose={() => setDraftImport(null)}
      onSaved={draft => {
        const stay = draftImport.stayInMaterials && draft.chapter === validMaterialChapter;
        setDraftImport(null);
        if (draftImport.attachToConversation) void attachImported([draft]);
        else if (!stay) { ctx.navigate({ page: 'cowriting', documentId: draft.id }); showDock(); }
      }}/>}
    {newDraft && <Modal title="新建章节草稿" onClose={() => setNewDraft(null)}>
      <div className="form-grid"><label>草稿章号<input type="number" min={1} max={99999} value={newDraft.chapter || ''}
        onChange={e => setNewDraft({ ...newDraft, chapter: Number(e.target.value) })}/></label>
        <label>草稿标题<input autoFocus maxLength={90} value={newDraft.title}
          onChange={e => setNewDraft({ ...newDraft, title: e.target.value })}/></label></div>
      <div className="modal-footer"><button onClick={() => setNewDraft(null)}>取消</button>
        <button className="primary" disabled={creatingDraft || !newDraft.chapter || !newDraft.title.trim()} onClick={() => void createDraft()}>创建草稿</button></div>
    </Modal>}
    {publish && source?.kind === 'draft' && source.id === targetId && <React.Suspense fallback={null}>
      <ConfirmPanel ctx={ctx} document={source} onClose={() => setPublish(false)} onUpdated={setSource}/>
    </React.Suspense>}
    {actionReview && isImportedLibraryText(actionReview.document) && <DraftImport ctx={ctx}
      chapter={actionReview.action.chapter} initialDocument={actionReview.document} onClose={() => setActionReview(null)}
      onSaved={draft => {
        const { action, document } = actionReview;
        replaceDocument(document.id, { kind: 'document', id: draft.id, hash: draft.hash, title: draft.title });
        ctx.navigate({ page: 'reader', documentId: draft.id });
        setActionReview(action.publish ? { action, document: draft } : null);
        if (!action.publish && action.cleanup) setDraftCleanup(draft);
      }}/>}
    {actionReview?.document.kind === 'draft' && <React.Suspense fallback={null}>
      <ConfirmPanel ctx={ctx} document={actionReview.document} onClose={() => setActionReview(null)}
        onPublished={() => { if (actionReview.action.cleanup) setDraftCleanup(actionReview.document); }}/>
    </React.Suspense>}
    {draftCleanup && <DraftCleanup ctx={ctx} keeper={draftCleanup} onClose={() => setDraftCleanup(null)}/>}
    {workspaceReview && <WorkspaceActionReview ctx={ctx} action={workspaceReview.action} onClose={() => setWorkspaceReview(null)}
      onApplied={() => {
        setHandledActions(ids => [...ids, workspaceReview.id]);
        const action = workspaceReview.action;
        if (action.files.some(file => file.documentId === workspaceDocumentId))
          ctx.navigate({ page: 'reader', tab: 'draft' });
        setWorkspaceReview(null);
        void reload();
      }}/>}
    {review && <RevisionPanel ctx={ctx} document={review.document} initialId={review.id} onClose={() => setReview(null)} onApplied={() => { void reload(); void refreshContext(); }}/>}
  </div>;
}
