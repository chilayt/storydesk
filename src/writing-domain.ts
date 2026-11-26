export type WritingMode = 'discuss' | 'draft' | 'annotate';
export type WritingScope = 'chapter' | 'draft' | 'next' | 'stage' | 'volume' | 'work';
export type WritingPhase = 'plan' | 'edit' | 'review';
export type DiscussionReference = { kind: 'document'; id: string; hash: string; title: string; selection?: { start: number; end: number; text: string } } |
  { kind: 'character'; id: string; revision: number; title: string } |
  { kind: 'stage'; id: string; hash: string; title: string } |
  { kind: 'map'; id: string; documentId: string; version: string; title: string };
export interface Annotation {
  id: string; sourceHash: string; start: number; end: number; quote: string; note: string; created_at?: string;
}
export interface CreativeTask {
  id: string; taskHash: string; workId: string; kind: Exclude<WritingScope, 'draft'>; documentId: string; sceneId: string | null; filePath?: string;
  title: string; goal: string; notes: string; phase: WritingPhase; status: 'active' | 'archived' | 'deleted';
  purpose?: 'character' | 'book';
  annotations: Annotation[]; referenceIds: string[]; updated_at: string;
  recoveryDraft?: { sourceHash: string; text: string; saved_at: string };
}
export interface ContextSection {
  id: string; kind: string; title: string; excerpt: string; status: string; path: string;
  documentId: string | null; hash: string | null; reason: string; factId?: string;
}
export interface WritingMemoryFeedback {
  reason: 'missed' | 'wrong_scope' | 'not_applied'; factId: string | null; note: string; at: string;
}
export interface WritingManifest {
  documentId: string; sceneId?: string | null; targetTitle?: string;
  sourceHash: string; signature: string; taskId: string | null; created_at: string; request: string;
  sections: ContextSection[]; missing: string[]; stale: boolean; range: string;
  replyId?: string; memoryFeedback?: WritingMemoryFeedback[];
}
export interface TrialSummary { id: string; title: string; status: string; created_at: string; stale: boolean; }
export interface DraftAction {
  documentId: string; sourceHash: string; chapter: number; publish: boolean; cleanup: boolean;
}
export type WorkspaceFilePin = { documentId: string; sourceHash: string; title: string; path: string; kind: string };
export type ReviewBatch = { documentId: string; reportId: string; sourceHash: string; allowIds: string[]; rewriteIds: string[] };
export interface StagePlanProposal {
  title: string; body: string; recordId?: string;
  details: { fromChapter: number; toChapter: number; milestones: import('./domain').StageNode[] };
}
export interface BookDesignItem {
  id: string; kind: 'work' | 'volume' | 'chapter' | 'character' | 'setting';
  title: string; path: string; text: string; quote: string; previous: string; savedAt?: string;
}
export type BookDecisionTopic = 'premise' | 'character' | 'relationship' | 'plot' | 'setting' | 'volume' | 'chapter';
export type BookDecisionStatus = 'exploring' | 'tentative' | 'confirmed';
export interface BookDecision {
  id: string; topic: BookDecisionTopic; title: string; text: string;
  status: BookDecisionStatus; revision: number; version: number;
  documents: { id: string; title: string }[]; dependsOn: { id: string; title: string }[];
  review: { id: string; title: string; text: string }[];
  previous?: { text: string; status: BookDecisionStatus; revision: number };
}
export interface BookDecisionProposal {
  id: string; topic: BookDecisionTopic; title: string; text: string; quote: string;
  dependsOn: string[]; documents: string[]; savedId?: string; replaces?: string;
}
export type WorkspaceAction =
  | ({ type: 'edit'; edits: { before: string; after: string; reason: string }[]; applied?: boolean; appliedHash?: string;
    selection?: { start: number; end: number; text: string } } & WorkspaceFilePin)
  | { type: 'archive'; files: WorkspaceFilePin[] };
export type WritingFollowUp = { id: string; text: string; references: DiscussionReference[] };
export interface WritingView {
  documentId: string; sceneId: string | null; sourceHash: string;
  range: { label: string; excerpt: string }; hasDraft: boolean; outlineText?: string; outlineDocumentId?: string;
  bookDecisions?: BookDecision[];
  recoveryDraft?: { text: string; baseHash: string; saved_at: string } | null;
  messages: { id: string; role: 'author' | 'assistant'; text: string; mode: WritingMode; sourceHash?: string; referenceTitle?: string; incomplete?: boolean; toolFailure?: boolean; sourceStale?: boolean;
    at?: string; hiddenAt?: string; elapsedMs?: number; activity?: string[]; imageNames?: string[];
    artifact?: { title: string; path: string; kind: string };
    stagePlan?: StagePlanProposal;
    bookDesign?: BookDesignItem[];
    bookDecisionProposals?: BookDecisionProposal[];
    memorySuggestion?: { id?: string; text: string; quote: string; sourceId: string };
    reviewAction?: ReviewBatch;
    draftAction?: DraftAction; workspaceAction?: WorkspaceAction; openedWorkspaceFile?: { documentId: string; kind: string } }[];
  composer?: { text: string; saved_at: string | null; references?: DiscussionReference[]; followUps?: WritingFollowUp[] };
  failure?: { code: string; activity: string; requests: number } | null;
  latestRevisionId?: string; revisions: TrialSummary[]; manifest?: WritingManifest;
  memory?: { status: string; count: number }; running: boolean; interrupted: boolean; error?: string;
}
