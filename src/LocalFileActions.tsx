import { useRef, useState } from 'react';
import type { AppContext } from './domain';
import { Icon } from './components';

type ImportedDocument = { id: string; hash: string; title: string; path: string };

export function ImportTextButton({ ctx, maxFiles, disabled, onImported, onBusy }: {
  ctx: AppContext; maxFiles?: number; disabled?: boolean;
  onImported: (documents: ImportedDocument[]) => void | Promise<void>; onBusy?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function pick() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusy?.(true);
    try {
      const files = await ctx.act<ImportedDocument[] | null>(() => ctx.call('importTexts', { maxFiles }));
      if (files?.length) await onImported(files);
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  }
  return <button type="button" disabled={disabled || busy} aria-busy={busy}
    title="选择本机 Markdown 或 TXT 文件，保存到当前作品的资料库" onClick={() => void pick()}>
    <Icon name="upload" size={16}/>{busy ? '正在导入…' : '导入文本'}
  </button>;
}

export function RevealSourceButton({ ctx, documentId, compact = false }: {
  ctx: AppContext; documentId: string; compact?: boolean;
}) {
  const label = '在文件资源管理器中显示';
  return <button type="button" title={label} className={compact ? 'text-button' : undefined}
    onClick={() => void ctx.call('revealSource', { documentId }).catch(error => ctx.notify(error.message, true))}>
    <Icon name="folder" size={15}/>{compact ? '定位文件' : label}
  </button>;
}
