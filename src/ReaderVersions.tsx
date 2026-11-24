import { useEffect, useState } from 'react';
import { Modal } from './components';
import type { AppContext, SourceDocument } from './domain';

export type ReaderVersion = { key: string; label: string } & (
  { kind: 'snapshot'; hash: string } | { kind: 'recovery'; text: string } |
  { kind: 'draft'; documentId: string; hash: string });

export function ReaderVersions({ ctx, document, currentText, options, initial, restoreBlocked, onClose, onRestore }: {
  ctx: AppContext; document: SourceDocument; currentText: string; options: ReaderVersion[]; initial: string;
  restoreBlocked: boolean;
  onClose: () => void; onRestore: (text: string) => void;
}) {
  const [selected, setSelected] = useState(initial);
  const [loaded, setLoaded] = useState<{ key: string; text?: string; error?: string }>();
  const version = options.find(option => option.key === selected);
  useEffect(() => {
    if (!version) return;
    let active = true;
    setLoaded(undefined);
    async function read(option: ReaderVersion): Promise<string> {
      if (option.kind === 'recovery') return option.text;
      if (option.kind === 'snapshot') return ctx.call('versionText', { documentId: document.id, hash: option.hash });
      const draft: SourceDocument = await ctx.call('readDocument', { documentId: option.documentId });
      if (draft.hash !== option.hash) throw new Error('备选稿已更新，请重新打开版本比较。');
      return draft.text || '';
    }
    read(version).then(text => {
      if (active) setLoaded({ key: selected, text: text.replace(/\r\n?/gu, '\n') });
    }, error => {
      if (active) setLoaded({ key: selected, error: (error as Error).message });
    });
    return () => { active = false; };
  }, [selected, document.id, version?.kind === 'recovery' ? version.text : version?.hash]);
  const result = loaded?.key === selected ? loaded : undefined;
  return <Modal title="版本比较" wide onClose={onClose} footer={<>
    <button onClick={onClose}>关闭比较</button>
    {version && version.kind !== 'draft' && !document.readOnly && <button className="primary"
      disabled={restoreBlocked || result?.text === undefined} title={restoreBlocked ? '请先保存当前编辑' : undefined}
      onClick={() => { if (result?.text !== undefined) onRestore(result.text); }}>载入为编辑稿</button>}
  </>}>
    <div className="reader-versions">
      <label className="version-select">与当前稿件比较<select value={selected} onChange={e => setSelected(e.target.value)}>
        {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select></label>
      {result?.error && <p className="notice danger" role="alert">{result.error}</p>}
      {version && <div className="diff-columns">
        <div><h4>{version.label}</h4>{result?.text !== undefined ? <pre>{result.text}</pre>
          : !result?.error && <p role="status">正在读取所选版本…</p>}</div>
        <div><h4>当前保存的稿件</h4><pre>{currentText}</pre></div>
      </div>}
    </div>
  </Modal>;
}
