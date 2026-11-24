import { createContext } from 'react';

export const researchNatureLabels = {
  historical: '历史参考',
  fiction: '架空设定',
  character_claim: '人物说法',
};
export type ResearchNature = keyof typeof researchNatureLabels;
export type ResearchStatus = 'pending' | 'confirmed' | 'deferred';
export type ResearchAction = 'save' | 'adopt' | 'defer' | 'resume';
export const researchQuoteHeading = '网络资料摘录 · 待核对';

export interface WebSource {
  id: string; type: 'web'; title: string; url: string; domain: string;
  excerpt: string; query: string; published: string | null; retrievedAt: string;
}

interface DiscussionSource {
  id: string; type: 'discussion'; title: string; role: 'author' | 'assistant';
  excerpt: string; recordPath: string; messageId: string; at: string;
}
export type ResearchSource = WebSource | DiscussionSource;

export interface ResearchFields {
  title: string; body: string; category: string; nature: ResearchNature;
  fromChapter: number | null; toChapter: number | null;
}

export interface ResearchCandidate extends ResearchFields {
  id: string; hash: string; status: ResearchStatus; updatedAt: string;
  sources: ResearchSource[]; documentId?: string;
}

export interface ResearchList {
  candidates: (Pick<ResearchCandidate, 'id' | 'title' | 'status' | 'nature' | 'updatedAt'> & { sourceCount: number })[];
  damaged: string[];
}

export const ResearchCitation = createContext<{ ready: boolean; insert: (sources: WebSource[]) => boolean } | null>(null);
