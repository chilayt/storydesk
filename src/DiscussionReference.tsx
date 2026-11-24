import React, { useContext } from 'react';
import type { DiscussionReference } from './writing-domain';

export const DiscussionComposer = React.createContext<{
  ready: boolean;
  writingDocumentId?: string;
  onManuscript: (id?: string) => void;
  onDraftEdit: () => void;
  references: DiscussionReference[];
  attach: (item: DiscussionReference) => void;
  replaceDocument: (id: string, item: Extract<DiscussionReference, { kind: 'document' }>) => void;
  startCharacter: (name: string) => Promise<boolean>;
  startStage: () => Promise<void>;
  latestAnswer: string;
  preparePrompt: (prompt: string) => void;
} | null>(null);

export function ReferenceButton({ item, disabled }: { item: DiscussionReference; disabled?: boolean }) {
  const composer = useContext(DiscussionComposer);
  if (!composer) return null;
  const selected = composer.references.some(current => current.id === item.id && (
    item.kind === 'character' && current.kind === 'character' && current.revision === item.revision ||
    item.kind === 'document' && current.kind === 'document' && current.hash === item.hash ||
    item.kind === 'stage' && current.kind === 'stage' && current.hash === item.hash ||
    item.kind === 'map' && current.kind === 'map' && current.version === item.version && current.documentId === item.documentId
  ));
  return <button disabled={disabled || !composer.ready || selected} onClick={() => composer.attach(item)}>
    {selected ? '已引用到对话' : '引用到对话'}
  </button>;
}
