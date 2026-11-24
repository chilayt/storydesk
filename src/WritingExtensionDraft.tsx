import { useContext, useEffect, useState } from 'react';
import type { AppContext } from './domain';
import { DiscussionComposer } from './DiscussionReference';
import { Icon } from './components';
import { RevealSourceButton } from './LocalFileActions';

type Entry = { id: string; title: string; kind: 'skill' | 'mcp'; path: string; hash: string };
const blank = { title: '', kind: 'skill' as Entry['kind'], text: '' };

export function WritingExtensionDraft({ ctx }: { ctx: AppContext }) {
  const composer = useContext(DiscussionComposer);
  const [drafts, setDrafts] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry>();
  const [draft, setDraft] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void ctx.call('listWritingExtensionDrafts').then(rows => { if (live) setDrafts(rows); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [ctx.call]);
  async function open(id: string) {
    setBusy(true); setError('');
    try {
      if (id) {
        const item = await ctx.call('readWritingExtensionDraft', { id });
        setSelected(item); setDraft({ title: item.title, kind: item.kind, text: item.text });
      } else { setSelected(undefined); setDraft(blank); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const item = await ctx.call('saveWritingExtensionDraft', { ...draft, id: selected?.id, expectedHash: selected?.hash });
      setSelected(item);
      setDrafts(await ctx.call('listWritingExtensionDrafts'));
      ctx.notify('写作扩展草案已存入本作品');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="dock-shelf extension-draft">
    <div className="form-grid">
      <label>草案<select value={selected?.id || ''} disabled={busy} onChange={e => void open(e.target.value)}>
        <option value="">新草案</option>{drafts.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <label>类型<select value={draft.kind} disabled={busy} onChange={e => setDraft({ ...draft, kind: e.target.value as Entry['kind'] })}>
        <option value="skill">写作技能</option><option value="mcp">MCP 接口设计</option>
      </select></label>
    </div>
    <label>名称<input value={draft.title} maxLength={90} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>
    <div className="studio-actions">
      <button disabled={!composer?.ready} onClick={() => composer?.preparePrompt(draft.kind === 'skill'
        ? `请为本作品拟一份「${draft.title || '写作技能'}」草案，写明适用范围、所需资料、步骤和验收样例。我的要求：`
        : `请为本作品拟一份「${draft.title || 'MCP 接口'}」设计草案，写明用途、输入输出、权限范围及测试样例。我的要求：`)}>去对话拟草案</button>
      <button disabled={busy || !composer?.latestAnswer} onClick={() => setDraft(current => ({
        ...current, text: [current.text.trimEnd(), composer?.latestAnswer].filter(Boolean).join('\n\n').slice(0, 30000),
      }))}>追加上条回复</button>
    </div>
    <label>草案正文<textarea rows={11} maxLength={30000} value={draft.text} disabled={busy}
      onChange={e => setDraft({ ...draft, text: e.target.value })}/></label>
    <div className="studio-actions"><button className="primary" disabled={busy || !draft.title.trim() || !draft.text.trim()} onClick={() => void save()}>
      <Icon name="save" size={15}/>保存草案</button><small className="studio-muted">{selected ? '草案 · 未启用' : '工作区草案'}</small></div>
    {selected && <div className="actions"><p className="studio-path">{selected.path}</p>
      <RevealSourceButton ctx={ctx} documentId={selected.id} compact/></div>}
    {error && <p role="alert" className="notice danger">{error}</p>}
  </div>;
}
