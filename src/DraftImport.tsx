import { useState } from 'react';
import type { AppContext, SourceDocument } from './domain';
import { Icon, Modal } from './components';

export const isImportedLibraryText = (doc: SourceDocument) =>
  doc.kind === 'reference' && doc.path.startsWith('创作资料库/导入文本/');

export function newestImportFirst(a: SourceDocument, b: SourceDocument) {
  return (b.importedAt || b.modified).localeCompare(a.importedAt || a.modified) ||
    (b.importOrder || 0) - (a.importOrder || 0);
}

export function importDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

type Chosen = { document: SourceDocument } | { file: { title: string; text: string } };

export function NewChapterDraft({ ctx, chapter: initialChapter, onClose, onSaved }: {
  ctx: AppContext; chapter: number; onClose: () => void; onSaved: (draft: SourceDocument) => void;
}) {
  const [chapter, setChapter] = useState(initialChapter);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = Number.isInteger(chapter) && chapter >= 1 && chapter <= 99999 && !!title.trim();
  async function create() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const document = await ctx.act<SourceDocument>(() => ctx.call('createChapterDraft', { chapter, title }), '章节草稿已创建');
      if (document) onSaved(document);
    } finally { setBusy(false); }
  }
  return <Modal title="新建章节草稿" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void create(); }}>
      <div className="form-grid"><label>草稿章号<input type="number" min={1} max={99999}
        value={chapter || ''} onChange={e => setChapter(Number(e.target.value))}/></label>
        <label>草稿标题<input maxLength={90} value={title} onChange={e => setTitle(e.target.value)}/></label></div>
      <div className="modal-footer"><button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary" disabled={busy || !valid}>{busy ? '正在创建…' : '创建草稿'}</button></div>
    </form>
  </Modal>;
}

export function DraftImport({ ctx, chapter: initialChapter, initialDocument, onClose, onSaved }: {
  ctx: AppContext; chapter: number; initialDocument?: SourceDocument;
  onClose: () => void; onSaved: (draft: SourceDocument) => void;
}) {
  const [chapter, setChapter] = useState(initialChapter);
  const [chosen, setChosen] = useState<Chosen | null>(initialDocument ? { document: initialDocument } : null);
  const [title, setTitle] = useState(initialDocument?.title || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const known = ctx.work.documents.filter(doc => isImportedLibraryText(doc) && !doc.error && !doc.historical)
    .sort(newestImportFirst);
  const matches = known.filter(doc => doc.draftChapterHint === chapter);
  const other = known.filter(doc => doc.draftChapterHint !== chapter);
  const libraryDocument = chosen && 'document' in chosen ? chosen.document : null;
  const filename = (doc: SourceDocument) => doc.path.split('/').at(-1);
  const usable = Number.isInteger(chapter) && chapter >= 1 && chapter <= 99999 && title.trim() && chosen;

  async function chooseFile() {
    setBusy(true);
    setError('');
    try {
      const file = await ctx.call('pickManuscript');
      if (file) {
        setChosen({ file });
        setTitle((/^#\s+(.+?)\s*$/m.exec(file.text)?.[1] || file.title).slice(0, 100));
      }
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }

  function chooseLibrary(id: string) {
    const document = known.find(row => row.id === id);
    setChosen(document ? { document } : null);
    setTitle(document?.title.slice(0, 100) || '');
    setError('');
  }

  async function save() {
    if (!usable || !chosen || busy) return;
    setBusy(true);
    setError('');
    try {
      await window.storyDesk.flushNow();
      const source = 'document' in chosen ? { sourceDocumentId: chosen.document.id, expectedSourceHash: chosen.document.hash }
        : { importedText: chosen.file.text };
      const draft = await ctx.call('createChapterDraft', { chapter, title, ...source });
      await ctx.refresh();
      ctx.notify(`已加入第${chapter}章草稿`);
      onSaved(draft);
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }

  const options = (rows: SourceDocument[]) => rows.map(doc =>
    <option key={doc.id} value={doc.id}>{doc.title} · {filename(doc)} · {importDate(doc.importedAt || doc.modified)}
      {doc.id === known[0]?.id ? ' · 最近导入' : ''}</option>);

  return <Modal title="导入章节草稿" subtitle="选好稿件和章号，保存后就能在本章打开、修改或核对。"
    onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="actions"><button type="button" disabled={busy} onClick={() => void chooseFile()}>
        <Icon name="upload" size={16}/>选择本机文件</button><small className="muted">Markdown 或 TXT</small></div>
      {known.length > 0 && <label>从资料库选已导入文本
        <select value={libraryDocument?.id || ''} disabled={busy} onChange={e => chooseLibrary(e.target.value)}>
          <option value="">选择已导入的文件</option>
          {matches.length > 0 && <optgroup label={`标题标为第${chapter}章`}>{options(matches)}</optgroup>}
          {other.length > 0 && <optgroup label="其他导入文本">{options(other)}</optgroup>}
        </select>
      </label>}
      {chosen && <p className="studio-path">{libraryDocument ? filename(libraryDocument) : 'file' in chosen && chosen.file.title}</p>}
      <div className="form-grid">
        <label>草稿章号<input type="number" value={chapter || ''} min={1} max={99999} disabled={busy} onChange={e => setChapter(Number(e.target.value))}/></label>
        <label>草稿标题<input value={title} maxLength={100} disabled={busy} onChange={e => setTitle(e.target.value)}/></label>
      </div>
      {libraryDocument?.draftChapterHint && libraryDocument.draftChapterHint !== chapter && <p className="notice warning">
        原档标题标为第{libraryDocument.draftChapterHint}章，这份草稿会归到你填写的章号。</p>}
      {error && <p className="notice danger" role="alert">{error}</p>}
      <div className="modal-footer"><button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary" disabled={busy || !usable}>{busy ? '正在处理…' : '存为章节草稿'}</button></div>
    </form>
  </Modal>;
}

export function DraftCleanup({ ctx, keeper, onClose }: { ctx: AppContext; keeper: SourceDocument; onClose: () => void }) {
  const [alternatives] = useState(() => ctx.work.documents.filter(doc => doc.kind === 'draft' && doc.id !== keeper.id &&
    doc.chapter === keeper.chapter && !ctx.work.hiddenChapterMaterials?.includes(doc.id)).sort(newestImportFirst));
  const [chosen, setChosen] = useState(() => new Set(alternatives.map(doc => doc.id)));
  const [busy, setBusy] = useState(false);
  const selected = alternatives.filter(doc => chosen.has(doc.id));
  async function confirm() {
    setBusy(true);
    try {
      await window.storyDesk.flushNow();
      const result = await ctx.act(() => ctx.call('hideOtherChapterDrafts', {
        keeperId: keeper.id, keeperHash: keeper.hash, drafts: selected.map(({ id, hash }) => ({ id, hash })),
      }), '已移出所选草稿，可在「本章资料 → 已移出」恢复');
      if (result) onClose();
    } catch (error) { ctx.notify((error as Error).message, true); }
    finally { setBusy(false); }
  }
  return <Modal title={`整理第${keeper.chapter}章草稿`} subtitle="核对要移出的稿件。文件保存在本机，可在本章资料恢复。"
    onClose={() => { if (!busy) onClose(); }}>
    <p>保留《{keeper.title}》<small className="studio-path"> {keeper.path.split('/').at(-1)}</small></p>
    {alternatives.length ? <div className="draft-cleanup-list">{alternatives.map(doc =>
      <label className="check-label" key={doc.id}><input type="checkbox" disabled={busy} checked={chosen.has(doc.id)} onChange={e => {
        const checked = e.target.checked;
        setChosen(current => {
          const next = new Set(current);
          if (checked) next.add(doc.id); else next.delete(doc.id);
          return next;
        });
      }}/><span>{doc.path.split('/').at(-1)}<small className="studio-path"> {importDate(doc.importedAt || doc.modified)}</small></span></label>
    )}</div> : <p className="muted">本章暂无其他草稿。</p>}
    <div className="modal-footer"><button disabled={busy} onClick={onClose}>返回</button>
      <button className="primary" disabled={busy || !selected.length} onClick={() => void confirm()}>
        移出所选草稿{selected.length ? `（${selected.length}）` : ''}</button></div>
  </Modal>;
}
