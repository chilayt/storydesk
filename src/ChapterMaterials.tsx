import React, { useCallback, useState } from 'react';
import type { AppContext, SourceDocument, Work } from './domain';
import { Badge, Markdown, Modal } from './components';
import { importDate, newestImportFirst } from './DraftImport';

function MaterialRow({ document, label, description, children }: {
  document: SourceDocument; label?: string; description?: string; children: React.ReactNode;
}) {
  return <li className="chapter-material-row">
    <div>
      <strong>{document.title}</strong>{label && <Badge>{label}</Badge>}
      <small className="studio-path" title={document.path}>{document.path.split('/').at(-1)}</small>
      {description && <span className="chapter-material-note">{description}</span>}
    </div>
    <div className="studio-actions">{children}</div>
  </li>;
}

function draftCheck(work: Work, document: SourceDocument) {
  const reports = work.checks.filter(report => report.documentId === document.id);
  const check = reports.filter(report => report.sourceHash === document.hash).at(-1);
  if (!check) return reports.length ? '稿件已变更，需检查这一版' : '待检查当前版本';
  if (check.gatePolicyVersion !== 2) return '检查规则已更新，需复检';
  if (check.status === 'passed') return '当前版本文风检查通过';
  if (check.status === 'not_required') return '本作品未启用文风门禁';
  return check.status === 'failed' ? '当前版本有硬线待修' : '当前版本检查未完成';
}

export function ChapterMaterials({ ctx, chapter, drafts, formal, disabled, onOutline, onCreateDraft, onImportDraft, onHideDraft }: {
  ctx: AppContext; chapter: number; drafts: SourceDocument[]; formal?: SourceDocument; disabled: boolean;
  onOutline: (design?: SourceDocument) => void; onCreateDraft: () => void; onImportDraft: () => void;
  onHideDraft: (id: string) => void;
}) {
  const [preview, setPreview] = useState<{ document: SourceDocument; historical: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closePreview = useCallback(() => setPreview(null), []);
  const approval = ctx.work.chapterOutlines?.find(row => row.chapter === chapter);
  const hiddenIds = new Set((ctx.work.hiddenChapterMaterials || []).filter(id => id !== approval?.documentId));
  const chapterDocuments = ctx.work.documents.filter(d => d.chapterMaterial?.chapter === chapter);
  const materials = chapterDocuments.filter(d => !hiddenIds.has(d.id));
  const hidden = [...new Map([...chapterDocuments, ...drafts].filter(d => hiddenIds.has(d.id)).map(d => [d.id, d])).values()];
  const visibleDrafts = drafts.filter(d => !hiddenIds.has(d.id)).sort(newestImportFirst);
  const designs = materials.filter(d => d.kind === 'plan' && d.chapterMaterial?.role === 'design')
    .sort((a, b) => Number(b.id === approval?.documentId) - Number(a.id === approval?.documentId));
  const reviews = materials.filter(d => d.chapterMaterial?.role === 'review')
    .sort((a, b) => b.modified.localeCompare(a.modified));
  const references = materials.filter(d => d.chapterMaterial?.role === 'reference');
  const activeDesign = designs.find(d => d.id === approval?.documentId);
  const openSource = (id: string) => ctx.navigate({ page: 'reader', documentId: id });
  const openWriting = (id: string) => ctx.navigate({ page: 'cowriting', documentId: id });
  async function setHidden(doc: SourceDocument, value: boolean) {
    const changed = await ctx.act(() => ctx.call('setChapterMaterialVisibility', { documentId: doc.id, hidden: value }),
      value ? '已移出本章资料。可在「已移出」恢复' : '已恢复到本章资料');
    if (changed && value && doc.kind === 'draft') onHideDraft(doc.id);
  }
  const hide = (doc: SourceDocument) => (doc.chapterMaterial || doc.kind === 'draft') && <button className="text-button"
    disabled={disabled} onClick={() => void setHidden(doc, true)}>{doc.kind === 'draft' ? '移出草稿列表' : '移出本章列表'}</button>;

  async function previewDesign(design: SourceDocument, approvalId?: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await window.storyDesk.flushNow();
      if (approvalId) {
        const version = await ctx.call('approvedSource', { approvalId });
        setPreview({ document: { ...design, text: version.text, hash: version.sourceHash }, historical: true });
      } else {
        const document = await ctx.call('readDocument', { documentId: design.id });
        setPreview({ document, historical: false });
      }
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDesign() {
    if (!preview || preview.historical) return;
    setBusy(true);
    setError('');
    try {
      await ctx.call('confirmChapterOutline', { documentId: preview.document.id, expectedHash: preview.document.hash });
      setPreview(null);
      await ctx.refresh();
      ctx.notify('第' + chapter + '章章纲已定案，供本章创作读取');
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="chapter-materials" aria-label={'第' + chapter + '章资料'}>
    <div className="studio-section-heading"><h2>第{chapter}章资料</h2></div>
    {error && !preview && <p className="notice danger" role="alert">{error}</p>}

    <section className="chapter-material-group" aria-label="草稿章节">
      <div className="studio-section-heading">
        <h3>草稿</h3>
        <div className="actions">
          <button disabled={disabled} onClick={onCreateDraft}>新建草稿</button>
          <button className="primary" disabled={disabled} onClick={onImportDraft}>导入草稿</button>
        </div>
      </div>
      {!visibleDrafts.length && <p className="studio-muted">本章暂无草稿。可选本机文件或资料库中已导入的文本。</p>}
      {visibleDrafts.length > 0 && <ul>{visibleDrafts.map(draft => <MaterialRow key={draft.id} document={draft}
          label={draft.chapterMaterial?.label || '草稿'}
          description={[draft.importedAt && `导入 ${importDate(draft.importedAt)}`, formal ? '备选草稿' : draft.error || draftCheck(ctx.work, draft)].filter(Boolean).join(' · ')}>
          <button disabled={disabled || !!draft.error} onClick={() => openWriting(draft.id)}
            aria-label={'打开' + (draft.chapterMaterial?.label || '草稿') + '：' + draft.title}>打开草稿</button>
          {hide(draft)}
        </MaterialRow>)}</ul>}
    </section>
    <section className="chapter-material-group" aria-label="正式正文">
      <h3>正式正文</h3>
      {formal ? <ul><MaterialRow document={formal} label={formal.status === 'confirmed' ? '正文已确认' : '正文待确认'}>
        <button disabled={disabled || !!formal.error} onClick={() => openWriting(formal.id)}>打开正文</button>
        {formal.status === 'confirmed' && <button disabled={disabled}
          onClick={() => ctx.navigate({ page: 'plot', tab: 'review', documentId: formal.id })}>核对资料变化</button>}
      </MaterialRow></ul> : <p className="studio-muted">本章尚未发布正文。</p>}
    </section>

    <section className="chapter-material-group" aria-label="章纲与设计">
      <div className="studio-section-heading">
        <h3>章纲与设计</h3>
        <button disabled={disabled} onClick={() => onOutline()}>打开章纲工作区</button>
      </div>
      {approval && !activeDesign && <p className="notice warning">定案来源暂不可读，请核对原档位置。</p>}
      {!designs.length && <p className="studio-muted">保存章纲后会在这里显示。</p>}
      <ul>{designs.map(design => {
        const chosen = design.id === approval?.documentId;
        const confirmed = chosen && design.hash === approval.sourceHash && !design.error;
        const label = confirmed ? '本章已定案' : chosen ? '有修订待定案' : '设计草案';
        return <MaterialRow key={design.id} document={design} label={label} description={design.error}>
          <button disabled={!!design.error} onClick={() => openSource(design.id)}>查看原稿</button>
          <button disabled={disabled || !!design.error} onClick={() => onOutline(design)}>讨论这份设计</button>
          {chosen && !confirmed && <button aria-disabled={busy} onClick={() => void previewDesign(design, approval.approvalId)}>查看已定版</button>}
          {!confirmed && <button disabled={disabled || !!design.error} aria-disabled={busy}
            onClick={() => void previewDesign(design)}>核对并定案</button>}
          {!chosen && hide(design)}
        </MaterialRow>;
      })}</ul>
    </section>

    {!!reviews.length && <section className="chapter-material-group" aria-label="审读与检查">
      <h3>审读与检查</h3>
      <p className="studio-muted">外部审读记录供对照。发布时检查所选草稿的当前版本。</p>
      <ul>{reviews.map(review => <MaterialRow key={review.id} document={review} label={review.chapterMaterial?.label}>
        <button disabled={!!review.error} onClick={() => openSource(review.id)}>查看记录</button>
        {hide(review)}
      </MaterialRow>)}</ul>
    </section>}

    {!!references.length && <details className="chapter-material-group">
      <summary>其他章节资料 · {references.length}</summary>
      <ul>{references.map(reference => <MaterialRow key={reference.id} document={reference} label={reference.chapterMaterial?.label}>
        <button disabled={!!reference.error} onClick={() => openSource(reference.id)}>查看原档</button>
        {hide(reference)}
      </MaterialRow>)}</ul>
    </details>}
    {!!hidden.length && <details className="chapter-material-group">
      <summary>已移出 · {hidden.length}</summary>
      <p className="studio-muted">这些资料已从常用列表和 Agent 取数中移出，原文件保存在本机。</p>
      <ul>{hidden.map(doc => <MaterialRow key={doc.id} document={doc} label={doc.chapterMaterial?.label}>
        <button disabled={disabled} onClick={() => void setHidden(doc, false)}>恢复到本章</button>
      </MaterialRow>)}</ul>
    </details>}

    {preview && <Modal title={'第' + chapter + '章' + (preview.historical ? '已定版' : '设计核对')}
      subtitle={preview.historical ? '这是定案时保存的版本。' : '定案会记录所见版本，供本章规划与写作读取。'}
      onClose={closePreview} wide>
      <div className="chapter-outline-title"><h3>{preview.document.title}</h3><p className="studio-path">{preview.document.path}</p></div>
      {!preview.historical && activeDesign && preview.document.id !== activeDesign.id && <p className="notice warning">
        确认后，本章定案将从「{activeDesign.title}」切换到这份设计。
      </p>}
      <div className="chapter-outline-preview" tabIndex={0} aria-label="设计原文">
        <Markdown text={preview.document.text || ''}/>
      </div>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <div className="modal-footer">
        <button onClick={closePreview}>返回资料</button>
        {!preview.historical && <button className="primary" disabled={disabled || busy || !preview.document.text?.trim()} onClick={() => void confirmDesign()}>
          {busy ? '正在保存…' : '确认章纲定案'}
        </button>}
      </div>
    </Modal>}
  </section>;
}
