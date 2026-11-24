import React, { useEffect, useRef, useState } from 'react';
import { Icon, Markdown } from './components';

export interface WritingSelection { start: number; end: number; quote: string; sourceHash: string; }
export function WritingCanvas({ documentId, sourceHash, sourceText, title, planning, readOnly, disabled, recovery,
  onSave, onRecover, onClearRecovery, onQuote, onAnnotate, onDirty, onLoadReply, canLoadReply, onOpenChapter, openChapterLabel,
  draft = false, sourcePath, onPublish, onCheck, fileAction }:
  { documentId: string; sourceHash: string; sourceText: string; title: string; planning: boolean; readOnly: boolean;
    disabled: boolean; recovery?: { text: string; baseHash: string } | null;
    onSave: (text: string, expectedHash: string) => Promise<{ hash: string; text: string } | null>;
    onRecover: (text: string, baseHash: string) => Promise<void>; onClearRecovery: () => Promise<void>;
    onQuote: (text: string) => void; onAnnotate: (selection: WritingSelection, note: string) => Promise<void>;
    onDirty: (dirty: boolean) => void; onLoadReply: () => string; canLoadReply: boolean; onOpenChapter?: () => void; openChapterLabel?: string;
    draft?: boolean; sourcePath?: string; onPublish?: () => void; onCheck?: () => void; fileAction?: React.ReactNode }) {
  const [value, setValue] = useState(sourceText);
  const [baseHash, setBaseHash] = useState(sourceHash);
  const [editing, setEditing] = useState(!sourceText);
  const [selection, setSelection] = useState<WritingSelection | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const acceptedSource = useRef({ hash: sourceHash, text: sourceText });
  const latest = useRef({ value, baseHash, sourceText, onRecover });
  latest.current = { value, baseHash, sourceText, onRecover };
  const dirty = value !== sourceText, conflict = sourceHash !== baseHash && dirty;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (latest.current.value === acceptedSource.current.text || value === sourceText) {
      setValue(sourceText); setBaseHash(sourceHash); setSelection(null);
    }
    acceptedSource.current = { hash: sourceHash, text: sourceText };
  }, [documentId, sourceHash]);
  useEffect(() => {
    const flush = async () => {
      const state = latest.current;
      if (state.value !== state.sourceText) await state.onRecover(state.value, state.baseHash);
    };
    const off = window.storyDesk.onFlush(flush);
    return () => { off(); void flush().catch(() => {}); };
  }, [documentId]);
  useEffect(() => {
    if (!dirty || readOnly) return;
    const timer = setTimeout(() => onRecover(value, baseHash).catch(e => setError((e as Error).message)), 1200);
    return () => clearTimeout(timer);
  }, [value, baseHash, dirty, readOnly, onRecover]);
  function choose() {
    const element = editor.current;
    if (!element) return;
    if (element.selectionStart === element.selectionEnd) {
      setSelection(null); setNote(''); return;
    }
    if (selection?.start !== element.selectionStart || selection?.end !== element.selectionEnd) setNote('');
    setSelection({ start: element.selectionStart, end: element.selectionEnd,
      quote: value.slice(element.selectionStart, element.selectionEnd), sourceHash: baseHash });
  }
  function clearSelection() {
    const element = editor.current;
    if (element) element.setSelectionRange(element.selectionEnd, element.selectionEnd);
    setSelection(null); setNote('');
  }
  async function save() {
    setSaving(true); setError('');
    try {
      const saved = await onSave(value, baseHash);
      if (saved) {
        latest.current = { ...latest.current, value: saved.text, sourceText: saved.text, baseHash: saved.hash };
        setValue(saved.text); setBaseHash(saved.hash); setSelection(null); onDirty(false);
      }
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  async function annotate() {
    if (!selection || !note.trim() || dirty || selection.sourceHash !== sourceHash) return;
    setSaving(true); setError('');
    try { await onAnnotate(selection, note.trim()); setNote(''); setSelection(null); }
    catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return <section className="writing-canvas" aria-label={planning ? '章纲工作区' : '正文工作区'}>
    <div className="studio-section-heading"><div><h2>{title}</h2>{sourcePath && <small className="studio-path">{sourcePath}</small>}</div>
      <div className="actions">{fileAction}<button aria-pressed={editing} disabled={saving} onClick={() => { clearSelection(); setEditing(!editing); }}>
        {editing ? '阅读预览' : readOnly ? '选段引用' : planning ? '编辑大纲' : '编辑文稿'}</button></div></div>
    {error && <p className="notice danger" role="alert">{error}</p>}
    {conflict && <p className="notice danger">原文已出现新版本，当前编辑已保留为恢复草稿。请在正文版本页比较后合并，避免覆盖。</p>}
    {!!recovery && recovery.text !== sourceText && !dirty && <div className="notice">有未保存的恢复草稿。
      <button disabled={disabled || saving} onClick={() => { setValue(recovery.text); setBaseHash(recovery.baseHash); setEditing(true); }}>恢复编辑</button>
      <button disabled={disabled || saving} onClick={() => void onClearRecovery()}>舍弃恢复草稿</button></div>}
    {editing ? <textarea ref={editor} aria-label={planning ? '大纲编辑器' : '正文编辑器'} className="studio-document-editor"
      value={value} readOnly={readOnly || disabled} spellCheck={false} maxLength={planning ? 16000 : 1000000}
      onChange={e => { setValue(e.target.value); setSelection(null); setNote(''); }} onSelect={choose} onMouseUp={choose} onKeyUp={choose}
      onKeyDown={e => {
        if (e.key === 'Escape' && selection) { e.preventDefault(); clearSelection(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!readOnly && !disabled && !conflict) void save(); }
      }}
      placeholder={planning ? '在这里整理本章目标、人物行动、分场和章末承接。' : '从这里开始写正文，也可以选中原文添加批注。'}/>
      : <div className="studio-document-reading" tabIndex={0}>{value ? <Markdown text={value}/> : <p className="studio-muted">还没有内容，可以直接编辑，或把讨论结果整理成大纲。</p>}</div>}
    {editing && selection && <div className="writing-selection"><div className="studio-section-heading"><strong>选中原文 · {selection.quote.length} 字</strong>
      <div className="studio-actions"><button className="text-button" onClick={clearSelection}>取消选段</button>
        <button onClick={() => { onQuote(selection.quote); if (!note) clearSelection(); }}>选段带回对话</button></div></div>
      {!planning && !readOnly && <><label htmlFor="writing-annotation-note">对这段的批注</label><textarea id="writing-annotation-note" rows={2} maxLength={800} value={note}
        onChange={e => setNote(e.target.value)} placeholder="例如：意思保留，改得更贴近人物声口。"/>
        {dirty && <p className="studio-muted">请先保存正文，再为准确的保存版本添加批注。</p>}
        <button disabled={disabled || saving || readOnly || dirty || !note.trim() || selection.quote.length > 2500} onClick={annotate}>保存这条批注</button></>}
    </div>}
    <div className="studio-document-footer"><span role="status">{saving ? '正在保存…' : dirty ? '有未保存编辑 · 自动保留恢复草稿' : readOnly ? '只读原档' : '当前保存版本'}</span>
      <div className="studio-actions">{planning && canLoadReply && <button disabled={disabled || saving} onClick={() => { setValue(onLoadReply()); setEditing(true); }}>用最新回复起草大纲</button>}
        {planning && onOpenChapter && <button disabled={disabled || saving || dirty} onClick={onOpenChapter}>{openChapterLabel || '打开或新建本章草稿'}</button>}
        {onCheck && !editing && <button className="primary" disabled={disabled || saving || dirty || conflict || !value.trim()}
          onClick={onCheck}><Icon name="shield" size={15}/>稿件核对</button>}
        {onPublish && !editing && <button disabled={disabled || saving || dirty || readOnly || conflict || !!recovery && recovery.text !== sourceText}
          onClick={onPublish}>核对并发布</button>}
        {(editing || planning) && <button className="primary" disabled={disabled || saving || readOnly || conflict || (!dirty && !!sourceText) || (planning && !value.trim())} onClick={save}>
          {planning ? '保存大纲' : draft ? '保存草稿' : '保存正文'}</button>}</div></div>
  </section>;
}
