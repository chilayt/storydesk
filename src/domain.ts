export type Layer = 'baseline' | 'occurred' | 'plan' | 'belief' | 'ruling';
export interface Fact {
  id: string; entity_id: string; field: string; value: any; layer: Layer;
  evidence: string; source_document_id: string | null; source_hash: string | null;
  source_chapter: number | null; status: string; start?: number | null; end?: number | null;
  reported_evidence?:string; evidence_match?:{status:string;method?:string|null;spanId?:string|null}; confirmed_range?:{start:number;end:number}; automatic?: boolean; review_reasons: string[]; eventId?: string; eventTitle?: string; eventStale?: boolean;
  supersedes_fact_id?: string; latest_only?: boolean;
  sourceRetired?: boolean;
}
export interface StoryEvent {
  id: string; title: string; summary: string; story_time: string; facts: Fact[];
  source_document_id: string | null; source_chapter: number | null; stale?: boolean;
  sourceRetired?: boolean;
  evidence_review_required?:boolean; damaged?: boolean; withdrawn?: boolean; superseded?: boolean;
  editorial_status?: string; editorial_layer?: Layer; editorial_evidence?: ReviewEvidence;
}
export interface ReviewEvidence { evidence: string; reported_evidence?: string; evidence_match?: { status: string }; }
export interface ChapterReview {
  id: string; kind: 'event' | 'hook' | 'withdraw_event'; eventId: string; jobId: string; title: string;
  status: string; revision: number; evidence?: ReviewEvidence;
  event?: { summary: string; story_time: string; editorial_layer: Layer };
  summary?: string; hookId?: string | null; hookStatus?: string;
  result?: { title: string; summary?: string; recordId?: string };
}
export interface SourceDocument {
  id: string; path: string; title: string; kind: string; chapter: number | null;
  hash: string; status: string; modified: string; size: number; error?: string;
  text?: string; draft?: { text: string; baseHash: string; saved_at: string };
  external?: any; readOnly?: boolean; generated?: boolean; scenes?: Scene[]; aliases?: string[];
  chapterMaterial?: { chapter: number; role: 'draft' | 'design' | 'review' | 'reference'; label: string };
  draftChapterHint?: number;
  importedAt?: string; importOrder?: number;
  historical?: boolean; snapshotAvailable?: boolean; archiveAvailable?: boolean;
  agentEdits?: { from: number; to: number }[];
  reason?: string; archivePath?: string | null; evidencePath?: string | null;
}
export interface SourceMove {
  id: string; documentId: string; title: string; from: string; to: string;
  reason: string; at: string; evidencePath?: string | null; snapshot?: string;
}
export interface RetiredSource extends SourceDocument { at: string; reason: string; snapshot?: string; archivedByAuthor?: boolean }
export interface LocationMapLink {
  id: string; name: string; aliases: string[]; summary: string;
  map: { title: string; version: string; path: string; documentId: string | null };
  sources: { title: string; path: string; documentId: string | null; status: string }[];
}
export interface StageNode {
  id: string; title: string; chapter: number | null; eventId?: string; note?: string;
  decision?: 'pending' | 'conflict' | 'adopted';
}
export interface StagePlan {
  id: string; title: string; path: string; hash?: string; fromChapter: number; toChapter: number; status: string; description: string;
  nodes: (StageNode & {
    state: 'completed' | 'pending' | 'changed' | 'conflict' | 'review';
    event: { id: string; title: string; chapter: number; documentId?: string; summary: string } | null;
  })[];
}
export interface Scene { id: string; name: string; documentId: string; sourceHash: string; start: number; end: number; }
export interface BaselineField { field: string; value: string; certainty?: string; evidence?: string; confirmed?: boolean; sourceLine?: number; }
export interface Character {
  id: string; name: string; aliases: string[]; sourceIds: string[];
  sourceEvidence: { documentId: string; quote: string }[];
  primarySourceId?: string; status: string; revision: number; baselineConfirmed?: boolean;
  disambiguation?: string; sourceMissing?: boolean; fields?: BaselineField[];
}
export interface Relationship {
  id: string; fromId: string; toId: string; type: string; attitude: string;
  firstFact: Fact; currentFact: Fact; changes: Fact[];
}
export interface CharacterDetail extends Character {
  baseline: { id: string; revision: number; appliesAt: string; fields: BaselineField[]; approved_at: string } | null;
  candidates: BaselineField[]; current: Record<string, Fact>; history: StoryEvent[];
  facts: Fact[]; mentions: { documentId: string; chapter: number; title: string; type: string }[];
  appearances?: Fact[]; firstMention: any; firstAppearance: Fact | null; skills: Fact[]; relationships: Relationship[];
  sourceText: string; pending: Proposal[];
  sourceHash?: string;
}
export interface Proposal { id: string; eventId: string; jobId: string; fact: Fact; status: string; operation: string; revision?: number; }
export interface Job { id: string; documentId: string; sourceHash: string; mode: string; status: string; versionState?: string; created_at: string; totalChunks: number; completedChunks: number; applied?: number; pending?: number; error?: string; errorCode?:string; diagnostics?:any; evidenceSummary?:any; rawResultAvailable?:boolean;reusedChunks?:number; usage?: { total_tokens: number; estimated?: boolean }; sourceChanged?: boolean; reviewPlot?: boolean; }
export interface BoardRecord { id: string; kind: string; title: string; body: string; status: string; participants: string[]; revision: number; updated_at: string; details?: Record<string, any>; }
export interface LocalModelPreset { id: string; title: string; detail: string; model: string; port: number; baseUrl: string; available: boolean; }
export interface LocalModelStatus { active: string | null; ready: string[]; }
export interface Work {
  id: string; name: string; root: string; era: string; documents: SourceDocument[];
  characters: Character[]; settings: any; approvals: any[]; jobs: Job[]; proposals: Proposal[]; chapterReviews?: ChapterReview[];
  localPresets: LocalModelPreset[]; writingModel: { key: string; enabled: boolean; model: string; baseUrl: string; title?: string };
  wordingDecisions?:any[]; revisionTasks?:any[]; memories:any[]; memoryRuns:any[]; obligationCards:any[];obligationChecks:any[];modelTest?:any; locks: any[]; checks: any[]; scenes: Scene[]; events: StoryEvent[]; records: BoardRecord[];
  externalChanges: Record<string, any>; recovery: any[]; reader: any;
  sourceHistory?: { moves: SourceMove[]; retired: Record<string, RetiredSource> };
  sourceRouteIssues?: string[];
  locationMaps?: LocationMapLink[]; locationMapIssue?: string;
  nextChapter?: number;
  stagePlans?: StagePlan[];
  chapterOutlines?: { chapter: number; approvalId: string; documentId: string; sourceHash: string }[];
  hiddenChapterMaterials?: string[];
  settingMeta?: Record<string, { category: string; nature: string; scope: string; summary: string; confirmed: boolean;
    research?: { candidateId: string; fromChapter: number | null; toChapter: number | null } }>;
  stats: { documents: number; chapters: number; confirmed: number; latestFile: number; characters: number; candidates: number; baselines: number; pending: number; external: number; events: number };
}
export interface CommitBatch { id: string; label: string; status: string; created_at: string; completed_at?: string; files: { path: string; beforeHash: string | null; afterHash: string | null }[]; }
export interface SearchResult { id: string; title: string; path: string; kind: string; excerpt: string; query: string; }
export type Page = 'overview' | 'reader' | 'cowriting' | 'manuscript' | 'book-review' | 'characters' | 'settings-docs' | 'plot' | 'entities' | 'library' | 'research' | 'updates' | 'memory' | 'obligations' | 'settings' | 'attachment' | 'extensions' | 'extension-draft';
export interface BookReviewReturn {
  tab: 'issues' | 'timeline' | 'hooks' | 'semantic';
  handled: boolean;
  openDetails: string[];
  detail?: string;
  citation?: string;
  history?: { reportId: string; runId: string };
}
export function bookCitationKey(source: { documentId: string; sourceHash: string; start: number }) {
  return `${source.documentId}:${source.sourceHash}:${source.start}`;
}
export interface Navigation { page: Page; documentId?: string; newChapterNumber?: number; characterId?: string; cardId?:string; researchId?: string; quote?: string; tab?: string; sourceLine?: number; sourceHash?: string; reviewRequestId?: string; draftEditHash?: string; reviewDocumentId?: string; reviewIssueId?: string; reviewPane?: 'open' | 'history'; reviewBatch?: import('./writing-domain').ReviewBatch; bookReviewReturn?: BookReviewReturn; }
export interface AppContext {
  work: Work; cutoff: number | null; call: (method: string, args?: any) => Promise<any>;
  refresh: () => Promise<void>; navigate: (nav: Navigation) => void;
  registerDocumentLeave: (id: string, confirm: () => Promise<boolean>) => () => void;
  confirmDocumentLeave: () => Promise<boolean>;
  notify: (message: string, error?: boolean) => void; act: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}
declare global {
  interface Window { storyDesk: { call(method: string, args?: any, workId?: string | null): Promise<any>; subscribe(cb: (event: any) => void): () => void; onFlush(cb: () => Promise<void>): () => void; flushNow(): Promise<void>; }; }
}
export const fieldLabels: Record<string, string> = { location: '所在地点', identity: '当前身份', goal: '当前目标', condition: '身体状态', status: '当前状态', relationship: '关系', skill: '武学', item_holder: '持有物', knowledge: '知情与认知', appearance: '出场' };
export const kindLabels: Record<string, string> = { chapter: '正文', draft: '草稿', character: '人物', reference: '综合资料', family: '家族', organization: '门派与势力', setting: '世界观', plan: '剧情设计', rule: '写作规则', plot: '剧情推进', location: '地点资料', item: '道具与物资', attachment: '地图与图纸', event: '事件', memory: '记忆规则' };
export const chapterReferenceLabels: Record<string, string> = { review: '审读与检查', reference: '章节资料' };
export function documentKindLabel(doc: SourceDocument) {
  return chapterReferenceLabels[doc.chapterMaterial?.role || ''] || kindLabels[doc.kind] || doc.kind;
}
export const layerLabels: Record<string, string> = { occurred: '已发生', plan: '计划', belief: '人物认知', baseline: '基座', ruling: '作者裁定' };
export const statusLabels: Record<string, string> = { unconfirmed: '待确认', retired: '已退役', confirmed: '已确认', partial: '部分完成', revising: '修订中', draft: '草稿', candidate: '待核对人物', registered: '已登记', waiting_config: '等待配置模型', queued: '排队中', running: '分析中', applying: '写回中', completed: '归档完成', failed: '失败', stale: '源稿已变', cancelled: '已取消', interrupted: '已中断', passed: '通过', incomplete: '未完成', not_required: '基础检查通过', committed: '已完成', recovery_needed: '待恢复', pending: '待核对', accepted: '已接受', rejected: '已保留原值' };
export const valueText = (v: any) => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
Object.assign(statusLabels,{obsolete:'已失效',superseded:'已转入历史',revoked:'作者已撤回',withdrawn:'已撤回',baseline_recorded:'已写入基座'});
Object.assign(fieldLabels,{plan:'剧情计划',belief:'人物判断'});
export function humanValue(f: Pick<Fact,'field'|'value'>, characters: Character[] = []) {
  if (f.field === 'skill' && typeof f.value === 'object') return [f.value.skillName, f.value.stage, f.value.level].filter(Boolean).join(' · ');
  if (f.field === 'relationship' && typeof f.value === 'object') return `${characters.find(c=>c.id===f.value.otherId)?.name || '关联人物'} · ${f.value.type || '关系'}${f.value.attitude ? ` · ${f.value.attitude}` : ''}`;
  if (f.field === 'appearance' && typeof f.value === 'object') return ({onscreen:'正面出场',mention:'被提及',memory:'回忆中的出现'} as Record<string,string>)[f.value.type] || '出场待核对';
  return valueText(f.value);
}
export const dateText = (s?: string) => s ? new Date(s).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export function choosePresetModel(models:string[],current:string,key:string){
  const oldFree=/opencode-zen-free\//i.test(current)||/-free$/i.test(current)||current==='big-pickle';
  if(models.includes(current)&&!(key==='opencode'&&oldFree))return current;
  if((key==='opencode'||key==='console')&&models.includes('glm-5.3-flash'))return 'glm-5.3-flash';
  return models[0]||current;
}
