import React, { useState } from 'react';
import { Badge, Modal } from './components';
import type { AppContext } from './domain';
import { kindLabels } from './domain';

type Entry = { path: string; title: string; kind: string; source: string; documentId?: string; pending?: boolean };
type Preview = { token: string; total: number; collisions: string[]; skipped: { path: string; reason: string }[]; items: Entry[] };

export function LibraryMigration({ ctx, onClose }: { ctx: AppContext; onClose: () => void }) {
  const [source, setSource] = useState('');
  const [kind, setKind] = useState('organization');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ directory: string; count: number; pending: number } | null>(null);
  const call = (method: string, args: object) => window.storyDesk.call(method, args, ctx.work.id);
  const options = { source, kind };

  async function choose(folder: boolean) {
    try {
      const path = await call('pickMaterial', { folder });
      if (path) { setSource(path); setPreview(null); }
    } catch (e) { setError((e as Error).message); }
  }

  async function prepare() {
    setBusy(true);
    setError('');
    setPreview(null);
    try { setPreview(await call('previewLibrary', options)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function build() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const created = await call('buildIndependentLibrary', { ...options, token: preview.token });
      setResult(created);
      await ctx.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const counts = new Map<string, number>();
  for (const entry of preview?.items || []) counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1);
  return <Modal title="建立独立作品资料库" subtitle="生成本作品目录下的 Markdown 文件，并登记来源与版本。" wide onClose={() => { if (!busy) onClose(); }}>
    {error && <p className="notice danger" role="alert">{error}</p>}
    {result ? <>
      <p>{result.directory} 已生成 {result.count} 份资料，其中 {result.pending} 份待核对。正文与档案会读取新库。</p>
      <div className="modal-footer"><button className="primary" onClick={onClose}>返回资料库</button></div>
    </> : <>
      <p className="muted">已接入的资料会复制到新库。系统可按现有分类整理门派、世界设定、地点、功法与物资。</p>
      <div className="form-grid">
        <label>额外资料路径<input value={source} placeholder="作品内的 .md、.txt 或文件夹" disabled={busy}
          onChange={e => { setSource(e.target.value); setPreview(null); }}/></label>
        <label>额外资料类型<select value={kind} disabled={busy} onChange={e => { setKind(e.target.value); setPreview(null); }}>
          <option value="organization">门派与势力</option><option value="character">人物</option>
          <option value="setting">世界设定</option><option value="location">地点</option><option value="item">道具与物资</option>
          <option value="family">家族</option><option value="rule">写作规则</option><option value="reference">待核对原档</option>
        </select></label>
      </div>
      <div className="actions">
        <button disabled={busy} onClick={() => void choose(false)}>选文件</button>
        <button disabled={busy} onClick={() => void choose(true)}>选文件夹</button>
        <button disabled={busy} onClick={prepare}>{busy && !preview ? '正在整理预览…' : '预览整理结果'}</button>
      </div>
      {preview && <section className="panel">
        <h3>将生成 {preview.total} 份资料</h3>
        <div className="actions">{[...counts].map(([type, count]) => <Badge key={type}>{type === 'reference' ? '待核对' : kindLabels[type]} {count}</Badge>)}</div>
        {preview.items.filter(item => item.pending).map(item => <p key={item.path}>待核对 · {item.source} → {item.title}</p>)}
        {preview.collisions.map(path => <p key={path} className="notice danger">目标文件已存在 · {path}</p>)}
        {preview.skipped.map(item => <p key={item.path} className="notice">{item.path} · {item.reason}</p>)}
        <details><summary>文件与来源清单</summary>
          <ul>{preview.items.map(item => <li key={`${item.path}-${item.source}`}>{item.source} → {item.path}</li>)}</ul>
        </details>
      </section>}
      <div className="modal-footer">
        <button disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" disabled={busy || !preview?.total || !!preview.collisions.length} onClick={build}>生成并启用新资料库</button>
      </div>
    </>}
  </Modal>;
}
