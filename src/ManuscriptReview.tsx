import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import type { AppContext, Navigation } from './domain';
import { Badge, Empty, Icon, Modal } from './components';
import { RevisionPanel } from './RevisionPanel';
import { DiscussionComposer } from './DiscussionReference';
import { ManuscriptDifference, ManuscriptHistory, manuscriptScopes as scopes } from './ManuscriptHistory';
import type { LegacySave, ManuscriptJournal, ManuscriptScope as Scope, ReviewUndo, SaveDiff } from './ManuscriptHistory';
import './manuscript-review.css';

const categories = { wording: '用词', dialogue: '对白', behavior: '行为', style: '文风' };
type Category = keyof typeof categories;
const basisLabels = { draft: '本章原文', prior: '已确认前情', baseline: '已确认人物基座' };
type ReviewBasis = {
  documentId: string; sourceHash: string; kind: keyof typeof basisLabels;
  title: string; label: string; line: number; quote: string; start?: number;
};
type Issue = {
  id: string; category: Category; origin: 'machine' | 'ai'; severity: 'hard' | 'research' | 'reminder' | 'review';
  message: string; quote: string; line: number | null; term?: string; usage?: string; research?: boolean;
  start?: number | null;
  suggestion?: string; allowed?: boolean; decision?: { scope: Scope };
  confirmedOkay?: string; olderRelease?: { id: string; reason: string }; recheck?: 'pending' | 'not_seen' | 'previous';
  basis?: ReviewBasis[]; basisStatus?: 'located' | 'pending';
};
type Progress = { reportId: string; phase: 'machine' | 'semantic' | 'stopping'; total: number; checked: number; useAI: boolean };
type SourcePreview = { issueId: string; title: string; line: number; quote: string; before: string; after: string;
  snapshot: boolean; excerptOnly: boolean };
type Quota = { count: number; limit: number; status: 'over' | 'pending' | 'within' };
type SpecialReview = {
  chapter: Quota; scenes: (Quota & { id: string; name: string })[]; unscoped: boolean; missing: number; pending: number;
  targets: { id: string; quote: string; label: string; line: number; reply?: { verdict: string; reason: string; quote: string } }[];
  figures: { id: string; line: number; start: number; quote: string; subject: string; image: string; shared: string; dismissed: boolean }[];
};
type Report = {
  id: string; sourceHash: string; checked_at?: string; path: string; passages: number; paragraphs: number; stale: boolean; active: boolean;
  semanticStatus: string; model?: string; error?: string; issues: Issue[]; totals: Record<Category, number>;
  coverage: { id: string; line: number; checked: Category[] }[];
  gate: { status: string; output: string; gatePolicyVersion: number };
  specialReview?: SpecialReview;
};
type SearchResult = { id: string; title: string; url: string; excerpt: string };
type WordingCitation = { work: string; attribution: string; quote: string; sense: string };
type Replacement = {
  replacement: string; lookup: string; register: 'narration' | 'dialogue' | 'both'; reason: string;
  sources?: (WordingCitation & { title: string; url: string })[];
};
const registers = { narration: '叙述', dialogue: '对白', both: '叙述与对白' };
type WordingResearch = {
  issueId: string; term: string; period: string; results: SearchResult[]; meaning: string; alternatives: Replacement[];
  assessment: { status: 'same_sense' | 'different_sense' | 'later' | 'pending'; message: string;
    citations: (WordingCitation & { sourceId: string })[] };
};
const severityLabels = { hard: '硬线', research: '待考', reminder: '提醒', review: '待判断' };
const semanticLabels: Record<string, string> = {
  complete: 'AI 四项已核对', running: 'AI 正在分段核对', partial: 'AI 有未核对段落',
  not_run: 'AI 尚未核对', cancelled: 'AI 核对已停止',
};
const verdictLabels: Record<string, string> = {
  issue: '问题成立', okay: '语境成立', pending: '依据不足', simile: '比喻', inference: '推测',
};
const quotaLabel = (quota: Quota) => `${quota.count}/${quota.limit} 处${quota.status === 'over' ? ' · 超额' : quota.status === 'pending' ? ' · 待核对' : ''}`;
const plainLines = (value: string) => value.replace(/\r\n/gu, '\n');
const changedText = (value: string | null | undefined, original: string) =>
  value === null || !!value?.trim() && plainLines(value).trim() !== plainLines(original).trim();
const overlaps = (a: Issue, b: Issue) => a.start != null && b.start != null &&
  a.start < b.start + b.quote.length && b.start < a.start + a.quote.length;

export default function ManuscriptReview({ ctx, nav, activeView }: { ctx: AppContext; nav: Navigation; activeView?: boolean }) {
  const onManuscript = useContext(DiscussionComposer)?.onManuscript;
  const documentSelectId = useId();
  const manuscripts = ctx.work.documents.filter(d => ['chapter', 'draft'].includes(d.kind) && !d.error && !d.historical &&
    !ctx.work.hiddenChapterMaterials?.includes(d.id));
  const [id, setId] = useState(nav.documentId || ctx.work.reader.documentId || manuscripts.at(-1)?.id || '');
  const doc = manuscripts.find(d => d.id === id);
  const [report, setReport] = useState<Report | null>(null);
  const [fileStates, setFileStates] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let current = true;
    void ctx.call('manuscriptReviewStates').then(states => { if (current) setFileStates(states); }).catch(() => {});
    return () => { current = false; };
  }, [ctx.call, ctx.work.documents, report?.id, report?.semanticStatus, checking]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [wordingView, setWordingView] = useState<'all' | 'previous' | 'pending'>('all');
  const [expanded, setExpanded] = useState<string>();
  const [pane, setPane] = useState<'open' | 'history'>(nav.reviewPane || 'open');
  const [journal, setJournal] = useState<ManuscriptJournal>();
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalRefresh, renewJournal] = useState(0);
  const [legacyDiff, setLegacyDiff] = useState<{ entry: LegacySave; diff: SaveDiff }>();
  const [sourcePreview, setSourcePreview] = useState<SourcePreview>();
  const sourceRequest = useRef(0);
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const editsKey = doc ? `manuscript-edits:${ctx.work.id}:${doc.id}:${doc.hash}` : '';
  const [editReview, setEditReview] = useState(false);
  const [editSelection, setEditSelection] = useState<string[]>([]);
  const [batchSelection, setBatchSelection] = useState<string[]>([]);
  const [batchWording, setBatchWording] = useState(false);
  const [revision, setRevision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<{ title: string; text: string; chapter: number }>();
  const [ruling, setRuling] = useState<Issue>();
  const [carrySelection, setCarrySelection] = useState<string[]>();
  const [scope, setScope] = useState<Scope>('document');
  const [reason, setReason] = useState('');
  const [searching, setSearching] = useState<string>();
  const [suggesting, setSuggesting] = useState<string>();
  const [suggestionNote, setSuggestionNote] = useState<{ issueId: string; text: string }>();
  const [researchError, setResearchError] = useState<{ issueId: string; message: string }>();
  const [research, setResearch] = useState<WordingResearch>();
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const autoRequest = useRef<string | undefined>(undefined);
  const [showEarlier, setShowEarlier] = useState(false);
  const returnIssue = useRef<HTMLLIElement>(null);
  const valid = !!report && !report.stale && report.sourceHash === doc?.hash;
  const active = checking || !!progress || !!report?.active;
  const outstanding = (report?.issues || []).filter(issue => !issue.allowed && !issue.confirmedOkay);
  const earlier = outstanding.filter(issue => !!issue.recheck);
  const current = outstanding.filter(issue => !issue.recheck);
  const displayedIssues = showEarlier ? earlier : current;
  const olderReleases = [...new Map(outstanding.flatMap(issue => issue.olderRelease ? [[issue.olderRelease.id, issue] as const] : [])).values()];
  const staged = outstanding.filter(issue => Object.hasOwn(edits, issue.id));
  const reviewed = staged.filter(issue => changedText(edits[issue.id], issue.quote));
  const uniqueEdits = reviewed.filter((issue, i) => !reviewed.slice(0, i).some(prior =>
    prior.start === issue.start && prior.quote === issue.quote && (edits[prior.id] ?? '') === (edits[issue.id] ?? '')));
  const selectedEdits = uniqueEdits.filter(issue => editSelection.includes(issue.id));
  function openEditReview() {
    setEditSelection(uniqueEdits.filter(issue => !uniqueEdits.some(other => other !== issue && overlaps(issue, other))).map(issue => issue.id));
    setEditReview(true);
  }

  useEffect(() => {
    if (nav.documentId) setId(nav.documentId);
  }, [nav.documentId]);
  useEffect(() => {
    if (!activeView || !doc) return;
    onManuscript?.(doc.id);
    return () => onManuscript?.();
  }, [activeView, doc?.id, onManuscript]);
  useEffect(() => { setBatchSelection([]); }, [id, report?.id, report?.sourceHash]);
  useEffect(() => {
    if (!doc) { setLoading(false); return; }
    let live = true;
    setLoading(true); setExpanded(nav.reviewIssueId); setResearch(undefined); setResearchError(undefined); setSourcePreview(undefined);
    setSuggestionNote(undefined);
    try { setEdits(JSON.parse(sessionStorage.getItem(editsKey) || '{}')); }
    catch { setEdits({}); }
    Promise.all([ctx.call('getManuscriptReport', { documentId: doc.id }), ctx.call('manuscriptProgress', { documentId: doc.id })])
      .then(([result, current]) => {
        if (live) { setReport(result); setProgress(current); }
    }).catch((e: Error) => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [doc?.id, doc?.hash]);
  useEffect(() => {
    if (!doc || pane !== 'history') return;
    let live = true;
    setJournalLoading(true);
    ctx.call('getManuscriptHistory', { documentId: doc.id }).then(result => { if (live) setJournal(result); })
      .catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setJournalLoading(false); });
    return () => { live = false; };
  }, [doc?.id, doc?.hash, pane, journalRefresh]);
  useEffect(() => {
    const issue = report?.issues.find(row => row.id === nav.reviewIssueId && !row.allowed && !row.confirmedOkay);
    if (issue) setShowEarlier(!!issue.recheck);
  }, [nav.reviewIssueId, report?.id]);
  useEffect(() => {
    if (nav.reviewIssueId && report) returnIssue.current?.scrollIntoView({ block: 'nearest' });
  }, [nav.reviewIssueId, report?.id, showEarlier]);
  useEffect(() => {
    if (!doc || !active) return;
    let live = true, polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const next: Progress | null = await ctx.call('manuscriptProgress', { documentId: doc!.id });
        const result = next?.phase === 'machine' ? undefined : await ctx.call('getManuscriptReport', { documentId: doc!.id });
        if (live) {
          setProgress(next);
          if (!next) setStopping(false);
          if (result !== undefined) setReport(result);
        }
      } catch { /* A check's final response reports failures. */ }
      finally { polling = false; }
    }
    const timer = setInterval(() => void poll(), 720);
    return () => { live = false; clearInterval(timer); };
  }, [doc?.id, active]);

  async function check(useAI: boolean, restart = false, target = doc) {
    if (!target || active || suggesting) return;
    setChecking(true); setError(''); setResearch(undefined); setResearchError(undefined);
    try {
      const result = await ctx.call('checkManuscript', { documentId: target.id, sourceHash: target.hash, useAI, restart });
      setReport(result);
      await ctx.refresh();
      return result as Report;
    } catch (e) { setError((e as Error).message); }
    finally { setChecking(false); setProgress(null); setStopping(false); }
  }
  async function stopReview() {
    if (!doc || stopping) return;
    try { if (await ctx.call('cancelManuscriptReview', { documentId: doc.id })) setStopping(true); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => {
    const request = nav.reviewRequestId;
    if (!activeView || !request || !doc || nav.documentId !== doc.id || loading || active || suggesting || autoRequest.current === request) return;
    autoRequest.current = request;
    setPane('open'); setShowEarlier(false);
    void check(true, true);
  }, [activeView, nav.reviewRequestId, nav.documentId, doc?.id, doc?.hash, loading, active, suggesting]);

  async function pick() {
    setBusy(true); setError('');
    try {
      const result = await ctx.call('pickManuscript');
      if (result) setImported({ ...result, chapter: doc?.chapter || ctx.work.stats.latestFile + 1 });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function importDraft() {
    if (!imported) return;
    setBusy(true); setError('');
    try {
      const draft = await ctx.call('createChapterDraft', { chapter: imported.chapter, title: imported.title, importedText: imported.text });
      await ctx.refresh();
      setImported(undefined);
      setId(draft.id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function openManuscript() {
    if (!doc) return;
    ctx.navigate({ page: 'reader', documentId: doc.id });
  }
  async function previewSource(issueId: string, documentId: string, sourceHash: string, line: number, quote: string, title: string, offset?: number | null) {
    const request = ++sourceRequest.current;
    let snapshot = false, text: string | undefined;
    try {
      const current = await ctx.call('readDocument', { documentId });
      snapshot = current.hash !== sourceHash;
      text = snapshot ? await ctx.call('versionText', { documentId, hash: sourceHash }) : current.text;
    } catch { snapshot = true; }
    if (request !== sourceRequest.current) return;
    const lines = text?.split('\n') || [];
    const body = lines.slice(line - 1, line + quote.split('\n').length - 1).join('\n');
    const exact = offset == null ? -1 : offset - lines.slice(0, line - 1).reduce((size, row) => size + row.length + 1, 0);
    const first = body.indexOf(quote);
    const start = exact >= 0 && body.startsWith(quote, exact) ? exact : first >= 0 && body.indexOf(quote, first + 1) < 0 ? first : -1;
    setSourcePreview({ issueId, title, line, quote, snapshot, excerptOnly: start < 0,
      before: start < 0 ? '' : (lines.slice(Math.max(0, line - 3), line - 1).join('\n') + '\n' + body.slice(0, start)).slice(-460),
      after: start < 0 ? '' : (body.slice(start + quote.length) + '\n' + lines.slice(line - 1 + quote.split('\n').length, line + quote.split('\n').length + 1).join('\n')).slice(0, 460),
    });
  }
  const issueInput = (issue: Issue) => ({ documentId: id, reportId: report!.id, sourceHash: report!.sourceHash, issueId: issue.id });
  function updateEdit(issueId: string, value?: string | null, onlyIfEmpty = false) {
    setEdits(previous => {
      if (onlyIfEmpty && previous[issueId] !== '') return previous;
      const next = { ...previous };
      if (value === undefined) delete next[issueId];
      else next[issueId] = value;
      try { sessionStorage.setItem(editsKey, JSON.stringify(next)); } catch { /* Keep the edit in the current view. */ }
      return next;
    });
  }
  function prepareEdit(issue: Issue) {
    const alternatives = research?.issueId === issue.id ? research.alternatives : [];
    const choice = alternatives.find(row => row.sources?.length) || alternatives[0];
    const candidate = choice?.replacement || (!issue.recheck &&
      (issue.origin === 'machine' || issue.basisStatus === 'located' || issue.category === 'wording') ? issue.suggestion : '') || '';
    const usable = changedText(candidate, issue.quote);
    updateEdit(issue.id, usable ? candidate : '');
    if (!usable && ctx.work.writingModel.enabled) void suggestEdit(issue);
  }
  async function prepareBatch(issues: Issue[]) {
    if (!valid || active || !issues.length) return;
    setBusy(true);
    try {
      for (const issue of issues) {
        if (Object.hasOwn(edits, issue.id)) continue;
        const prior = !issue.recheck && (issue.origin === 'machine' || issue.basisStatus === 'located' || issue.category === 'wording') ? issue.suggestion : '';
        if (issue.category === 'wording' && ctx.work.writingModel.enabled) {
          updateEdit(issue.id, '');
          await suggestEdit(issue);
        } else if (changedText(prior, issue.quote)) updateEdit(issue.id, prior);
        else {
          updateEdit(issue.id, '');
          if (ctx.work.writingModel.enabled) await suggestEdit(issue);
        }
      }
      setBatchSelection([]);
    } finally { setBusy(false); }
  }
  async function allowBatch() {
    if (!report || !valid || !batchSelection.length) return;
    setBusy(true); setError('');
    try {
      setReport(await ctx.call('batchManuscriptWording', { documentId: id, reportId: report.id, sourceHash: report.sourceHash,
        issueIds: batchSelection, scope, confirmed: true }));
      for (const issueId of batchSelection) updateEdit(issueId);
      setBatchSelection([]); setBatchWording(false); renewJournal(value => value + 1);
      await ctx.refresh();
      ctx.notify('所选用词已放行，可在「已处理」撤回。');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function suggestEdit(issue: Issue) {
    setSuggesting(issue.id); setSuggestionNote(undefined);
    try {
      const suggestion = await ctx.call('suggestManuscriptEdit', issueInput(issue));
      if (changedText(suggestion.replacement, issue.quote)) updateEdit(issue.id, suggestion.replacement, true);
      setSuggestionNote({ issueId: issue.id, text: suggestion.reason });
    } catch (error) { setSuggestionNote({ issueId: issue.id, text: (error as Error).message }); }
    finally { setSuggesting(undefined); }
  }
  async function researchWord(issue: Issue) {
    setSearching(issue.id); setResearchError(undefined); setResearch(undefined); setSelectedSources([]);
    try {
      const found = await ctx.call('searchManuscriptWording', issueInput(issue));
      setResearch({ ...found, issueId: issue.id });
    } catch (e) { setResearchError({ issueId: issue.id, message: (e as Error).message }); }
    finally { setSearching(undefined); }
  }
  async function allow() {
    if (!ruling || !valid) return;
    setBusy(true); setError('');
    try {
      const result = await ctx.call('decideManuscriptWording', { ...issueInput(ruling), scope, reason, confirmed: true,
        previousDecisionId: ruling.olderRelease?.id,
        sourceIds: research?.issueId === ruling.id ? selectedSources : [] });
      setReport(result); setRuling(undefined);
      updateEdit(ruling.id); renewJournal(value => value + 1);
      ctx.notify('已放行，可在「已处理」查看或撤销');
      await ctx.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function keep(issue: Issue) {
    setBusy(true); setError('');
    try {
      setReport(await ctx.call('confirmManuscriptIssue', { ...issueInput(issue), confirmed: true }));
      updateEdit(issue.id); renewJournal(value => value + 1);
      ctx.notify('已确认无问题，原段保持不变时复检继续沿用。可在「已处理」撤回。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function carryReleases() {
    if (!report || !valid || !carrySelection?.length) return;
    setBusy(true); setError('');
    try {
      setReport(await ctx.call('carryManuscriptWording', { documentId: id, reportId: report.id,
        sourceHash: report.sourceHash, decisionIds: carrySelection, confirmed: true }));
      setCarrySelection(undefined); renewJournal(value => value + 1);
      ctx.notify(`已沿用 ${carrySelection.length} 条放行，适用于本章及后续修订。`);
      await ctx.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!report || !valid || active || suggesting || !selectedEdits.length) return;
    const reviewed = selectedEdits;
    setBusy(true); setError('');
    try {
      const result = await ctx.call('applyManuscriptEdits', { documentId: id, reportId: report.id, sourceHash: report.sourceHash,
        edits: reviewed.map(issue => ({ id: issue.id, after: edits[issue.id] ?? '' })), confirmed: true });
      setEditReview(false); setEdits({});
      try { sessionStorage.removeItem(editsKey); } catch { /* The next revision has a different key. */ }
      renewJournal(value => value + 1);
      ctx.notify('已写回稿件。修改前后和撤回入口在「已处理」');
      const refreshed = await check(false, false, result.document);
      if (refreshed && staged.length > reviewed.length) {
        const written = new Set(reviewed.map(issue => issue.id));
        const newlines = result.document.newline === '\r\n' ? '\r\n' : '\n';
        const next: Record<string, string | null> = {};
        for (const issue of staged) {
          if (written.has(issue.id) || issue.start == null) continue;
          const start = issue.start + reviewed.reduce((shift, edit) => (edit.start ?? Infinity) < issue.start! ?
            shift + (edits[edit.id] ?? '').replace(/\r?\n/gu, newlines).length - edit.quote.length : shift, 0);
          const remaining = refreshed.issues.find(current => !current.allowed && !current.confirmedOkay && current.start === start &&
            current.quote === issue.quote && current.category === issue.category && current.origin === issue.origin);
          if (remaining) next[remaining.id] = edits[issue.id];
        }
        try { sessionStorage.setItem(`manuscript-edits:${ctx.work.id}:${id}:${result.document.hash}`, JSON.stringify(next)); } catch { /* Keep pending edits in this view. */ }
        setEdits(next);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function loadDiff(entry: LegacySave) {
    if (!doc) return;
    setBusy(true); setError('');
    try { setLegacyDiff({ entry, diff: await ctx.call('getManuscriptSaveDiff', { documentId: doc.id, entryId: entry.id }) }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function undo(entry: ReviewUndo) {
    if (!doc || !journal || active) return;
    setBusy(true); setError('');
    try {
      const result = await ctx.call('undoManuscriptDecision', {
        documentId: doc.id, entryId: entry.id, sourceHash: journal.currentHash, type: entry.type, confirmed: true,
      });
      setLegacyDiff(undefined); renewJournal(value => value + 1);
      if (entry.type === 'edit' || entry.type === 'legacy') await check(false, false, result.document);
      else setReport(await ctx.call('getManuscriptReport', { documentId: doc.id }));
      ctx.notify(entry.type === 'wording' ? '已撤销用词放行' : entry.type === 'keep' ? '已撤回确认' : '已恢复对应的原文');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const errorNotice = error && <div className="notice danger" role="alert">{error}</div>;
  const visible = displayedIssues.filter(issue => (category === 'all' || issue.category === category) &&
    (category !== 'wording' || wordingView === 'all' || !!issue.olderRelease === (wordingView === 'previous')));
  const selectable = visible.filter(issue => issue.quote && issue.start != null && !doc?.readOnly);
  const selectedIssues = selectable.filter(issue => batchSelection.includes(issue.id));
  const allowedWords = (report?.issues || []).filter(issue => issue.category === 'wording' && issue.allowed);
  function toggleBatch(ids: string[], checked: boolean) {
    setBatchSelection(previous => checked ? [...new Set([...previous, ...ids])] : previous.filter(id => !ids.includes(id)));
  }
  const aiCovered = report?.coverage.some(row => row.checked.length);
  const canResume = valid && aiCovered && report?.semanticStatus !== 'complete' && ctx.work.writingModel.enabled;
  const busyWithResearch = busy || !!searching || !!suggesting;
  const proposedBatch = nav.reviewBatch;
  const batchApplies = proposedBatch?.documentId === id && proposedBatch?.reportId === report?.id && proposedBatch?.sourceHash === report?.sourceHash;
  const progressText = stopping || progress?.phase === 'stopping' ? '正在停止…'
    : progress?.phase === 'semantic' ? `AI 正在核对 · ${progress.checked}/${progress.total} 个片段` : '正在运行本地机检…';

  return <section className="manuscript-review">
    <div className="manuscript-review-heading">
      <div><label htmlFor={documentSelectId}>核对文稿</label><select id={documentSelectId} value={doc?.id || ''} disabled={active || busyWithResearch}
        onChange={e => { setId(e.target.value); setReport(null); setJournal(undefined); setPane('open'); }}>
        {!doc && <option value="">选择正文或章节草稿</option>}
        {['draft', 'chapter'].map(kind => <optgroup key={kind} label={kind === 'draft' ? '章节草稿' : '正式正文'}>
          {manuscripts.filter(d => d.kind === kind).map(d => <option key={d.id} value={d.id}>{d.title} · {fileStates[d.id] || d.path.split('/').pop()}</option>)}
        </optgroup>)}
      </select></div>
      <button disabled={active || busyWithResearch} onClick={() => void pick()}><Icon name="folder" size={15}/>导入稿件</button>
    </div>
    {doc && <div className="manuscript-review-actions">
      {active ? <button disabled={stopping || progress?.phase === 'stopping'} onClick={() => void stopReview()}>
        {stopping || progress?.phase === 'stopping' ? '正在停止…' : '停止核对'}</button>
        : <button className="primary" disabled={loading || busyWithResearch} onClick={() => void check(true, valid && report?.semanticStatus === 'complete')}>
          <Icon name="shield" size={15}/>{canResume ? '补查未完成段落' : valid && report?.semanticStatus === 'complete' ? '重新运行 AI 全文核对' : '核对全文'}</button>}
      {!active && <button className="text-button" disabled={loading || busyWithResearch} onClick={() => void check(false)}>仅机检</button>}
      <button className="text-button" onClick={openManuscript}>打开整份原稿</button>
    </div>}
    {!editReview && !ruling && !batchWording && !carrySelection && !imported && !legacyDiff && errorNotice}
    {active && <p className="manuscript-review-progress" role="status">{progressText}</p>}
    {doc && <div className="manuscript-view-tabs" role="group" aria-label="核对记录范围">
      <button aria-pressed={pane === 'open' && !showEarlier} onClick={() => { setPane('open'); setShowEarlier(false); }}>待处理{report ? ` · ${current.length}` : ''}</button>
      {!!earlier.length && <button aria-pressed={pane === 'open' && showEarlier} onClick={() => { setPane('open'); setShowEarlier(true); }}>上轮遗留 · {earlier.length}</button>}
      <button aria-pressed={pane === 'history'} onClick={() => setPane('history')}>已处理</button>
    </div>}
    {doc && pane === 'history' && <>
      {journalLoading && <p className="muted" role="status">正在读取处理记录…</p>}
      {journal && <ManuscriptHistory journal={journal} busy={active || busyWithResearch || journalLoading} onUndo={entry => void undo(entry)} onDiff={entry => void loadDiff(entry)}/>}
    </>}
    {pane === 'open' && !report && loading && !active && <p className="muted" role="status">正在读取核对结果…</p>}
    {pane === 'open' && !report && !loading && !active && <Empty title={doc ? '这份稿件还没有核对报告' : '先选择一份稿件'}
      detail={doc ? '全文核对包含离线机检与分段 AI 审读。AI 审读使用本作品当前配置的模型。' : '可以从正文、章节草稿中选择，也可以导入 Markdown 或纯文本。'}/>}
    {pane === 'open' && report && <>
      {!valid && <div className="notice warning">这里显示上一版报告。运行当前版机检后可继续处理，改动记录可在「已处理」查看。</div>}
      {proposedBatch && <div className="notice">
        <strong>{batchApplies ? 'Agent 准备的处理清单' : '清单对应的报告已更新，请从对话重新准备。'}</strong>
        {batchApplies && <div className="manuscript-review-actions">
          {!!proposedBatch.allowIds.length && <button disabled={active || busyWithResearch || !valid} onClick={() => {
            const ids = outstanding.filter(issue => proposedBatch.allowIds.includes(issue.id)).map(issue => issue.id);
            if (ids.length) { setBatchSelection(ids); setScope('revision'); setBatchWording(true); }
          }}>核对放行 {proposedBatch.allowIds.length} 处</button>}
          {!!proposedBatch.rewriteIds.length && <button disabled={active || busyWithResearch || !valid}
            onClick={() => void prepareBatch(outstanding.filter(issue => proposedBatch.rewriteIds.includes(issue.id)))}>拟修改 {proposedBatch.rewriteIds.length} 处</button>}
        </div>}
      </div>}
      <div className="manuscript-review-status" role="status">
        <span>机检 <Badge status={report.gate.status}/></span>
        <span title={report.sourceHash}>{valid ? '当前保存版本' : '旧版'} · {report.sourceHash.slice(0, 8)}</span>
        {!active && <span>{report.specialReview && report.semanticStatus === 'complete' ? '已收到 AI 核对回执'
          : report.specialReview && report.semanticStatus === 'partial' ? '有段落或疑点待补查'
          : semanticLabels[report.semanticStatus] || semanticLabels.partial}</span>}
        <span>{report.paragraphs} 段{report.passages !== report.paragraphs ? `，${report.passages} 个核对片段` : ''}{report.model ? ` · ${report.model}` : ''}</span>
      </div>
      {report.specialReview && <details className="manuscript-wording-group">
        <summary>比喻与疑点回执 · 本章 {quotaLabel(report.specialReview.chapter)}
          {report.specialReview.missing > 0 && ` · ${report.specialReview.missing} 条漏答`}
          {report.specialReview.pending > 0 && ` · ${report.specialReview.pending} 条待核对`}</summary>
        {report.specialReview.scenes.map(scene => <p key={scene.id}>{scene.name} · {quotaLabel(scene)}</p>)}
        {report.specialReview.unscoped && <p className="muted">部分正文没有明确场界，场次配额待核对。</p>}
        {report.specialReview.figures.map(figure => <div key={figure.id}>
          <p>第 {figure.line} 行 · {figure.quote}</p>
          <p className="muted">{figure.subject} / {figure.image} · {figure.shared}</p>
          {doc && <button type="button" onClick={() => void previewSource(figure.id, doc.id, report.sourceHash,
            figure.line, figure.quote, doc.title, figure.start)}>定位原文</button>}
          {doc && <button type="button" disabled={!valid || active || busy} onClick={async () => {
            setBusy(true); setError('');
            try {
              setReport(await ctx.call('decideManuscriptFigure', { documentId: doc.id, reportId: report.id,
                sourceHash: report.sourceHash, figureId: figure.id, dismiss: !figure.dismissed }));
            } catch (e) { setError((e as Error).message); }
            finally { setBusy(false); }
          }}>{figure.dismissed ? '恢复计数' : '判为非比喻'}</button>}
          {sourcePreview?.issueId === figure.id && <section className="manuscript-source-preview" aria-label="比喻原文定位">
            <p>{sourcePreview.before}<mark>{sourcePreview.quote}</mark>{sourcePreview.after}</p>
          </section>}
        </div>)}
        {report.specialReview.targets.map(row => <p key={row.id} title={row.label}>
          第 {row.line} 行 · {row.reply?.quote || row.quote} · {row.reply ? verdictLabels[row.reply.verdict] : '未收到回执'}
          {row.reply && ` · ${row.reply.reason}`}
        </p>)}
      </details>}
      {category === 'wording' && <details className="manuscript-wording-group">
        <summary>已放行 · {allowedWords.length} 处</summary>
        {allowedWords.length ? allowedWords.map(issue => <div key={issue.id}>{issue.term || issue.quote} · 第 {issue.line} 行{issue.decision && ` · ${scopes[issue.decision.scope]}`}</div>) :
          <p className="muted">这版报告没有已放行的用词。</p>}
        <button type="button" onClick={() => setPane('history')}>查看放行记录和撤回</button>
      </details>}
      {category === 'wording' && <div className="manuscript-filters" role="group" aria-label="用词处理状态">
        <button aria-pressed={wordingView === 'all'} onClick={() => setWordingView('all')}>全部待处理</button>
        <button aria-pressed={wordingView === 'previous'} onClick={() => setWordingView('previous')}>以前已放行 · {olderReleases.length}</button>
        <button aria-pressed={wordingView === 'pending'} onClick={() => setWordingView('pending')}>等待裁定</button>
      </div>}
      {valid && selectable.length > 0 && <div className="manuscript-review-actions manuscript-batch-tools">
        <label className="check-label"><input type="checkbox" checked={selectedIssues.length === selectable.length}
          disabled={active || busyWithResearch} onChange={event => toggleBatch(selectable.map(issue => issue.id), event.target.checked)}/>全选当前分类</label>
        {category === 'wording' && olderReleases.length > 0 && <button type="button" disabled={active || busyWithResearch}
          onClick={() => setBatchSelection(selectable.filter(issue => issue.olderRelease).map(issue => issue.id))}>选中以前已放行</button>}
        <small>{selectedIssues.length} 处已选</small>
        <button type="button" disabled={!selectedIssues.length || active || busyWithResearch} onClick={() => void prepareBatch(selectedIssues)}>拟修改所选</button>
        <button type="button" disabled={!selectedIssues.length || selectedIssues.some(issue => !issue.research || issue.severity === 'hard') || active || busyWithResearch}
          onClick={() => { setError(''); setBatchSelection(selectedIssues.map(issue => issue.id)); setScope('revision'); setBatchWording(true); }}>放行所选</button>
      </div>}
      {!!report.error && <p className="muted small-text">{report.error}</p>}
      <div className="manuscript-filters" role="group" aria-label="按问题分类筛选">
        <button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>全部 <span>{displayedIssues.length}</span></button>
        {(Object.keys(categories) as Category[]).map(key => <button key={key} aria-pressed={category === key} onClick={() => setCategory(key)}>
          {categories[key]} <span>{displayedIssues.filter(i => i.category === key).length}</span></button>)}
      </div>
      {valid && olderReleases.length > 1 && (category === 'all' || category === 'wording') && <div className="manuscript-review-actions">
        <button className="text-button" disabled={active || busyWithResearch} onClick={() => {
          setError(''); setCarrySelection(olderReleases.map(issue => issue.olderRelease!.id));
        }}>沿用旧版放行 · {olderReleases.length} 条</button>
      </div>}
      {showEarlier && <p className="muted">这里保留上轮发现、当前尚未复现或核对未完的疑点。</p>}
      <details className="manuscript-audit"><summary>核对范围与原始报告</summary>
        {report.checked_at && <p>检查时间 {new Date(report.checked_at).toLocaleString('zh-CN', { hour12: false })}</p>}
        <p>检查版本 <code>{report.sourceHash.slice(0, 12)}</code>{doc && report.sourceHash !== doc.hash && <> · 当前保存版本 <code>{doc.hash.slice(0, 12)}</code></>}</p>
        <p>AI 回执 · {(Object.keys(categories) as Category[]).map(key => `${categories[key]} ${report.totals[key]}/${report.passages}`).join(' · ')}</p>
        {report.coverage.some(row => row.checked.length !== 4) && <p>AI 未完成的片段起始行 · {report.coverage.filter(row => row.checked.length !== 4).map(row => row.line).join('、')}</p>}
        <pre>{report.gate.output.split('\n').filter(line => !line.startsWith('STORYDESK_GATE_JSON:')).join('\n')}</pre>
        <button className="text-button" disabled={!valid || active || !doc || doc.readOnly || !ctx.work.writingModel.enabled || report.gate.gatePolicyVersion !== 2}
          onClick={() => setRevision(true)}>根据机检生成整稿修订建议</button>
      </details>
      {!visible.length && <p className="muted">当前分类暂无待处理项。</p>}
      <ol className="manuscript-issues">{visible.map(issue => <li key={issue.id} className="manuscript-issue"
        ref={nav.reviewIssueId === issue.id ? returnIssue : undefined}>
        {valid && issue.quote && issue.start != null && !doc?.readOnly && <label className="manuscript-row-select">
          <input type="checkbox" aria-label={`选择第 ${issue.line} 行 ${issue.term || categories[issue.category]}`}
            disabled={active || busyWithResearch} checked={batchSelection.includes(issue.id)}
            onChange={event => toggleBatch([issue.id], event.target.checked)}/>
        </label>}
        <button className="manuscript-issue-heading" aria-expanded={expanded === issue.id} onClick={() => setExpanded(expanded === issue.id ? undefined : issue.id)}>
          <span className={`manuscript-severity severity-${issue.severity}`}>{
            issue.origin === 'ai' && issue.category !== 'wording' && issue.basisStatus !== 'located' ? '待核对' : severityLabels[issue.severity]}</span>
          <span><strong>{issue.term || issue.quote.slice(0, 70) || issue.message}</strong><small>
            {categories[issue.category]} · {issue.origin === 'machine' ? '机检' : 'AI'}{issue.line ? ` · 第 ${issue.line} 行` : ' · 全文指标'}
            {issue.recheck === 'not_seen' ? ' · 本轮未复现' : issue.recheck ? ' · 上轮疑点' : ''}</small></span>
          {Object.hasOwn(edits, issue.id) && <span className="muted">拟修改</span>}{issue.olderRelease && <span className="muted">以前已放行</span>}<Icon name="chevron" size={14}/>
        </button>
        {expanded === issue.id && <div className="manuscript-issue-body">
          <p>{issue.message}</p>
          {issue.quote && <blockquote>{issue.quote}</blockquote>}
          {issue.usage && <small className="muted">适用词义 · {issue.usage}</small>}
          {issue.olderRelease && <p className="muted">此前选了「仅本次版本」。可将这条放行沿用到本章及后续修订。</p>}
          {issue.recheck === 'not_seen' && <p className="muted">上轮发现了这处疑点。本次 AI 未再次报告，仍可由你确认或修改。</p>}
          {issue.recheck === 'previous' && <p className="muted">当前稿件仍能找到这处原句，判断依据来自上一版核对。</p>}
          <div className="manuscript-review-actions">
            {issue.line && doc && <button className="text-button"
              onClick={() => void previewSource(issue.id, doc.id, report.sourceHash, issue.line!, issue.quote, doc.title, issue.start)}>定位原文</button>}
            {valid && issue.research && <button className="text-button" disabled={busyWithResearch || active} onClick={() => void researchWord(issue)}>
              {searching === issue.id ? '查证中…' : researchError?.issueId === issue.id ? '重试查证' : '联网查证'}</button>}
            {valid && issue.research && <button className="text-button" disabled={busyWithResearch || active}
              onClick={() => { setScope('document'); setReason(issue.olderRelease?.reason || ''); setRuling(issue); }}>
              {issue.olderRelease ? '沿用上次放行' : '按范围放行'}</button>}
            {valid && !issue.research && issue.severity !== 'hard' && <button className="text-button" disabled={active || busyWithResearch}
              onClick={() => void keep(issue)}>确认无问题</button>}
            {valid && issue.quote && issue.start != null && !doc?.readOnly && !Object.hasOwn(edits, issue.id) && <button className="text-button" disabled={active || busyWithResearch}
              onClick={() => prepareEdit(issue)}>拟修改</button>}
            {valid && !issue.quote && <small className="muted">全文指标需要通读处理。可打开整份原稿编辑。</small>}
          </div>
          {sourcePreview?.issueId === issue.id && <section className="manuscript-source-preview" aria-label="原文定位">
            <div className="manuscript-basis-source"><strong>{sourcePreview.title} · 第 {sourcePreview.line} 行</strong>
              <button className="text-button" onClick={() => setSourcePreview(undefined)}>收起原文</button></div>
            {(sourcePreview.snapshot || sourcePreview.excerptOnly) && <small className="muted">{sourcePreview.excerptOnly ?
              '核对时摘录' : '核对时的保存版本'}</small>}
            <pre>{sourcePreview.before}<mark className="evidence-highlight">{sourcePreview.quote}</mark>{sourcePreview.after}</pre>
          </section>}
          {issue.origin === 'ai' && issue.category !== 'wording' && <section className="manuscript-basis" aria-label="判断依据">
            <strong>判断依据</strong>
            {issue.basisStatus !== 'located' && <p className="muted">{issue.basisStatus === 'pending' ?
              '可定位的依据不足，需作者核对。' : '这份旧报告未记录可定位的依据。'}</p>}
            {issue.basis?.map(basis => <div key={JSON.stringify([basis.documentId, basis.line, basis.quote])}>
              <div className="manuscript-basis-source">
                <small>{basisLabels[basis.kind]} · {basis.title} · {basis.label}</small>
                <button className="text-button" onClick={() => void previewSource(issue.id, basis.documentId, basis.sourceHash, basis.line, basis.quote, basis.title, basis.start)}>
                  定位依据 · 第 {basis.line} 行
                </button>
              </div>
              <blockquote>{basis.quote}</blockquote>
            </div>)}
          </section>}
          {researchError?.issueId === issue.id && <div className="notice warning" role="alert">
            查证未完成。{researchError.message}
          </div>}
          {research?.issueId === issue.id && <div className="manuscript-sources">
            <section className="manuscript-lookup-result" role="status">
              <strong>「{research.term}」{research.period ? ` · ${research.period}用法` : ' · 用法查证'}</strong>
              {research.meaning && <p>本句含义 · {research.meaning}</p>}
              <p>{research.assessment.message}</p>
            </section>
            {!!research.alternatives.length && <section className="manuscript-alternatives" aria-label="建议怎么改">
              <strong>建议怎么改</strong>
              {research.alternatives.map(row => <article key={row.replacement}>
                <small>{registers[row.register]} · {row.sources?.length ? '有同义书证' : row.lookup ? '称谓待考' : '语境改写 · 待审'}</small>
                <blockquote>{issue.quote} → {row.replacement}</blockquote>
                <p>{row.reason}</p>
                {row.sources?.map(source => <div key={source.url + source.quote}>
                  <small>{source.attribution}</small>
                  <blockquote>{source.quote}</blockquote>
                  <small>书证词义 · {source.sense}</small>
                  <button className="text-button" onClick={() => ctx.call('openWebSource', { url: source.url }).catch(e => setError(e.message))}>打开替代词出处</button>
                </div>)}
                {!issue.allowed && !doc?.readOnly && <button disabled={!valid || active}
                  onClick={() => updateEdit(issue.id, row.replacement)}>用这条拟修改</button>}
              </article>)}
            </section>}
            {!!research.results.length && <details className="manuscript-research-excerpts" open={!!research.assessment.citations.length}>
              <summary>原词查证出处 · {research.results.length}</summary>
              <small>勾选的出处会随作者裁定保存。</small>
              {research.results.map(source => <div key={source.id}>
              <label className="check-label"><input type="checkbox" checked={selectedSources.includes(source.id)} disabled={selectedSources.length >= 4 && !selectedSources.includes(source.id)}
                onChange={e => setSelectedSources(ids => e.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id))}/>{source.title}</label>
              {research.assessment.citations.some(c => c.sourceId === source.id)
                ? research.assessment.citations.filter(c => c.sourceId === source.id).map(citation => <div key={citation.quote}>
                  <small>{citation.attribution}</small>
                  <blockquote>{citation.quote}</blockquote>
                  <p>原句词义 · {citation.sense}</p>
                </div>)
                : <><small className="muted">含原词的相关摘录</small><p>{source.excerpt}</p></>}
              <button className="text-button" onClick={() => ctx.call('openWebSource', { url: source.url }).catch(e => setError(e.message))}>打开出处</button>
              </div>)}
            </details>}
          </div>}
          {Object.hasOwn(edits, issue.id) && !issue.allowed && <div className="manuscript-edit">
            <label>替换文本<textarea rows={3} value={edits[issue.id] ?? ''} disabled={!valid || edits[issue.id] === null || active || busy}
              placeholder="在此填写替换这段原文的文字" onChange={e => updateEdit(issue.id, e.target.value)}/></label>
            <div className="manuscript-edit-status" role="status">
              {suggesting === issue.id ? '正在根据本处上下文生成建议…' : suggestionNote?.issueId === issue.id ? suggestionNote.text : ''}
              <small className="muted">{edits[issue.id] === null ? '已选删除此处原文，等待确认写回。' : changedText(edits[issue.id], issue.quote) ?
                '替换已拟好。核对差异后可确认写回。' : '待填改法。填写不同的文字，或明确选择删除原文。'}</small>
            </div>
            <div className="manuscript-review-actions">
              {!changedText(edits[issue.id], issue.quote) && ctx.work.writingModel.enabled && <button className="text-button"
                disabled={!valid || active || busyWithResearch} onClick={() => { updateEdit(issue.id, ''); void suggestEdit(issue); }}>生成本条建议</button>}
              <button className="text-button" disabled={!valid || active || busy} aria-pressed={edits[issue.id] === null}
                onClick={() => updateEdit(issue.id, edits[issue.id] === null ? '' : null)}>{edits[issue.id] === null ? '取消删除' : '拟删除原文'}</button>
              <button className="text-button" disabled={busy} onClick={() => updateEdit(issue.id)}>撤下修改</button>
            </div>
          </div>}
        </div>}
      </li>)}</ol>
      {!!staged.length && <div className="manuscript-review-footer"><span>{uniqueEdits.length} 处可核对
        {staged.length > reviewed.length && <small>{staged.length - reviewed.length} 处待填改法</small>}</span>
        <button className="primary" disabled={!valid || active || busy || !!suggesting} onClick={openEditReview}>核对拟修改</button></div>}
    </>}
    {carrySelection && <Modal title="沿用旧版用词放行" onClose={() => setCarrySelection(undefined)}>
      {errorNotice}
      <p>勾选的旧裁定会沿用到本章及后续修订，理由和查证出处一并保留。</p>
      {olderReleases.map(issue => <label className="check-label" key={issue.olderRelease!.id}>
        <input type="checkbox" checked={carrySelection.includes(issue.olderRelease!.id)} disabled={busy} onChange={e => {
          const key = issue.olderRelease!.id;
          setCarrySelection(ids => e.target.checked ? [...ids!, key] : ids!.filter(id => id !== key));
        }}/>{issue.term}{issue.usage ? ` · ${issue.usage}` : ''}
      </label>)}
      <div className="modal-footer"><button className="primary" disabled={busy || !valid || !carrySelection.length}
        onClick={() => void carryReleases()}>确认沿用 {carrySelection.length} 条</button></div>
    </Modal>}
    {ruling && <Modal title={`放行「${ruling.term}」`} onClose={() => setRuling(undefined)}>
      {errorNotice}
      <p>{ruling.usage ? `此裁定适用于${ruling.usage}的用法。` : '请选择该词的适用范围。'}</p>
      {ruling.olderRelease && <p className="muted">沿用旧版裁定的依据，可在下方调整范围和理由。</p>}
      <label>放行范围<select value={scope} onChange={e => setScope(e.target.value as Scope)}>
        {(Object.entries(scopes) as [Scope, string][]).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>裁定理由（选填）<textarea value={reason} rows={3} onChange={e => setReason(e.target.value)}/></label>
      <p className="muted">{scope === 'revision' ? '适用于本次保存版本。稿件更新后该词会重新进入核对。' :
        scope === 'document' ? '本章改稿或重新核对时继续沿用这条放行。' : '当前作品的后续章节也会沿用。'}</p>
      <div className="modal-footer"><button className="primary" disabled={busy || !valid} onClick={() => void allow()}>确认放行</button></div>
    </Modal>}
    {batchWording && <Modal title={`放行所选 ${batchSelection.length} 处用词`} onClose={() => setBatchWording(false)}>
      {errorNotice}
      <p>{outstanding.filter(issue => batchSelection.includes(issue.id)).map(issue => issue.term).filter((term, index, terms) => terms.indexOf(term) === index).join('、')}</p>
      <label>放行范围<select value={scope} onChange={event => setScope(event.target.value as Scope)}>
        {(Object.entries(scopes) as [Scope, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <div className="modal-footer"><button type="button" disabled={busy} onClick={() => setBatchWording(false)}>取消</button>
        <button className="primary" disabled={busy || !valid} onClick={() => void allowBatch()}>确认放行</button></div>
    </Modal>}
    {legacyDiff && <Modal title="较早的稿件保存" subtitle={`差异从原文第 ${legacyDiff.diff.line} 行开始`} onClose={() => setLegacyDiff(undefined)} wide>
      {errorNotice}
      <ManuscriptDifference before={legacyDiff.diff.before} after={legacyDiff.diff.after}/>
      {legacyDiff.diff.truncated && <p className="muted">这里显示差异的前段。完整稿件可在正文的版本比较中查看。</p>}
      {(!legacyDiff.entry.canUndo || !legacyDiff.diff.canUndo) && <p className="muted">可对照保存记录选择要手动恢复的文字。</p>}
      <div className="modal-footer"><button onClick={() => setLegacyDiff(undefined)}>返回已处理</button>
        {legacyDiff.entry.canUndo && legacyDiff.diff.canUndo && <button className="primary" disabled={busy || active}
          onClick={() => void undo({ id: legacyDiff.entry.id, type: 'legacy' })}>恢复到这次保存前</button>}
      </div>
    </Modal>}
    {editReview && <Modal title="确认写回本地稿件" subtitle={doc?.path} onClose={() => setEditReview(false)} wide>
      {errorNotice}
      {!reviewed.length && <p>还没有可以写回的变化。返回填写替换文字，或为要删除的原文勾选「拟删除原文」。</p>}
      {!!reviewed.length && staged.length > reviewed.length && <p className="muted">另有 {staged.length - reviewed.length} 处待填写。本次只写回下面的差异。</p>}
      {!!uniqueEdits.length && <div className="manuscript-review-actions">
        <strong>已选 {selectedEdits.length} / {uniqueEdits.length} 处</strong>
        <button type="button" disabled={busy} onClick={() => setEditSelection(uniqueEdits.filter(issue =>
          !uniqueEdits.some(other => other !== issue && overlaps(issue, other))).map(issue => issue.id))}>全选无冲突</button>
        <button type="button" disabled={busy || !selectedEdits.length} onClick={() => setEditSelection([])}>取消全部选择</button>
        <button type="button" disabled={busy} onClick={() => { for (const issue of reviewed) if (!editSelection.includes(issue.id)) updateEdit(issue.id); }}>拒绝未选建议</button>
        <button type="button" disabled={busy} onClick={() => {
          for (const issue of reviewed) updateEdit(issue.id);
          setEditSelection([]); setEditReview(false);
        }}>拒绝全部</button>
      </div>}
      {uniqueEdits.map(issue => <section key={issue.id} className="manuscript-edit-candidate">
        <label className="check-label"><input type="checkbox" disabled={busy} checked={editSelection.includes(issue.id)}
          onChange={event => setEditSelection(previous => event.target.checked ? [...previous.filter(id =>
            !uniqueEdits.some(other => other.id === id && overlaps(issue, other))), issue.id] : previous.filter(id => id !== issue.id))}/>
          第 {issue.line} 行 · {categories[issue.category]}</label>
        {uniqueEdits.some(other => issue !== other && overlaps(issue, other)) && <p className="muted">与同一段的其他建议重叠，选中此处会取消相交的建议。</p>}
        <div className="diff-columns"><div><h4>当前原文</h4><pre>{issue.quote}</pre></div>
          <div><label>替换文本<textarea rows={3} value={edits[issue.id] ?? ''} placeholder="此处将删除"
            disabled={busy} onChange={event => updateEdit(issue.id, event.target.value.trim() ? event.target.value : null)}/></label></div></div></section>)}
      <div className="modal-footer"><button disabled={busy} onClick={() => setEditReview(false)}>返回修改</button>
        <button className="primary" disabled={busy || !valid || !selectedEdits.length} onClick={() => void apply()}>确认并写回</button></div>
    </Modal>}
    {imported && <Modal title="导入章节草稿副本" onClose={() => setImported(undefined)}>
      {errorNotice}
      <label>章号<input type="number" min={1} max={99999} value={imported.chapter}
        onChange={e => setImported({ ...imported, chapter: Number(e.target.value) })}/></label>
      <label>草稿标题<input value={imported.title} onChange={e => setImported({ ...imported, title: e.target.value })}/></label>
      <div className="modal-footer"><button className="primary" disabled={busy || !imported.title.trim() || imported.chapter < 1}
        onClick={() => void importDraft()}>保存为章节草稿</button></div>
    </Modal>}
    {revision && doc && report && <RevisionPanel ctx={ctx} document={doc} report={report.gate} onClose={() => setRevision(false)}/>}
  </section>;
}
