import { useState } from 'react';
import type { AppContext } from './domain';
import type { WorkspaceAction } from './writing-domain';
import { Modal } from './components';

export function WorkspaceActionReview({ ctx, action, onClose, onApplied }: {
  ctx: AppContext; action: Extract<WorkspaceAction, { type: 'archive' }>; onClose: () => void; onApplied: () => void;
}) {
  const [selected, setSelected] = useState(() => action.files.map(file => file.documentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    if (busy || !selected.length) return;
    setBusy(true);
    setError('');
    try {
      await window.storyDesk.flushNow();
      await ctx.call('archiveWorkspaceFiles', { files: action.files.filter(file => selected.includes(file.documentId)) });
      await ctx.refresh();
      ctx.notify('已归档所选文件，可在草稿页恢复。');
      onApplied();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <Modal title="核对要归档的文件" onClose={() => { if (!busy) onClose(); }}>
    <p>所选文件会移出当前资料，可在「正文与草稿 → 草稿 → 已归档文件」恢复。</p>
    {action.files.map(file => <label className="check-label" key={file.documentId}>
      <input type="checkbox" disabled={busy} checked={selected.includes(file.documentId)} onChange={event => {
        const checked = event.target.checked;
        setSelected(ids => checked ? [...ids, file.documentId] : ids.filter(id => id !== file.documentId));
      }}/>
      <span>{file.title}<small className="studio-path">{file.path}</small></span>
    </label>)}
    {error && <p className="notice danger" role="alert">{error}</p>}
    <div className="modal-footer"><button disabled={busy} onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !selected.length}
        onClick={() => void confirm()}>{busy ? '正在处理…' : '确认归档'}</button>
    </div>
  </Modal>;
}
