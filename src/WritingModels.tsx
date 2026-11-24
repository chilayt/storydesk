import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './components';
import type { AppContext, LocalModelStatus } from './domain';

const emptyStatus: LocalModelStatus = { active: null, ready: [] };

export function WritingModels({ ctx, running, onBusy, onReady }: {
  ctx: AppContext; running: boolean; onBusy: (busy: boolean) => void; onReady: (ready: boolean) => void;
}) {
  const { work, call } = ctx;
  const { writingModel: model, localPresets, settings: { ai } } = work;
  const popover = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(emptyStatus);
  const [authorized, setAuthorized] = useState(false);
  const [catalog, setCatalog] = useState<{ baseUrl: string; models: string[] }>();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const cloud = ai.baseUrl?.startsWith('https://');
  const connectionName = ai.baseUrl ? (cloud ? '云端模型' : '本机模型') : '模型连接';
  const connected = !!ai.enabled && !!ai.baseUrl && (!cloud || authorized);
  const listed = catalog && catalog.baseUrl === ai.baseUrl ? catalog.models : ai.modelList || [];
  const modelNames = [...new Set<string>([ai.model, ...listed].filter(Boolean))];
  const matches = modelNames.filter(name => name.toLowerCase().includes(search.trim().toLowerCase()));

  const refresh = useCallback(async () => {
    if (!localPresets.length) return;
    const request = ++sequence.current;
    try {
      const next = await call('localStatus');
      if (request === sequence.current) setStatus(next);
    } catch (e) {
      if (request === sequence.current) { setStatus(emptyStatus); setError((e as Error).message); }
    }
  }, [call, localPresets.length]);

  useEffect(() => {
    if (model.key !== 'analysis' || open) void refresh();
    const focus = () => { if (model.key !== 'analysis' || open) void refresh(); };
    window.addEventListener('focus', focus);
    const timer = open || model.key !== 'analysis' ? setInterval(focus, 3500) : undefined;
    return () => { ++sequence.current; window.removeEventListener('focus', focus); clearInterval(timer); };
  }, [refresh, model.key, open]);
  useEffect(() => {
    if (!cloud || !ai.enabled) return;
    let live = true;
    setAuthorized(false);
    void call('keyStatus', { baseUrl: ai.baseUrl }).then(result => { if (live) setAuthorized(result.authorized); }).catch(() => {});
    return () => { live = false; };
  }, [call, cloud, ai.baseUrl, ai.enabled, open]);
  useEffect(() => {
    onReady(model.key === 'analysis' ? !cloud || authorized : status.ready.includes(model.key));
  }, [model.key, status, onReady, cloud, authorized]);

  async function fetchModels() {
    setLoading(true); setError('');
    try {
      const result = await call('listModels', { baseUrl: ai.baseUrl });
      setCatalog({ baseUrl: ai.baseUrl, models: result.models });
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function checkConnection() {
    try {
      const ready = cloud ? (await call('keyStatus', { baseUrl: ai.baseUrl })).authorized : true;
      setAuthorized(ready);
      if (ai.enabled && ai.baseUrl && ready && catalog?.baseUrl !== ai.baseUrl && !ai.modelList?.length) await fetchModels();
    } catch (e) { setError((e as Error).message); }
  }

  function toggle() {
    const panel = popover.current, button = trigger.current;
    if (!panel || !button) return;
    if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
    const rect = button.getBoundingClientRect();
    const width = Math.min(410, window.innerWidth - 24);
    panel.style.setProperty('--picker-width', `${width}px`);
    const above = rect.top >= window.innerHeight - rect.bottom;
    panel.style.setProperty('--picker-left', `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`);
    panel.style.setProperty('--picker-top', above ? 'auto' : `${rect.bottom + 8}px`);
    panel.style.setProperty('--picker-bottom', above ? `${window.innerHeight - rect.top + 8}px` : 'auto');
    panel.style.setProperty('--picker-height', `${Math.min(550, (above ? rect.top : window.innerHeight - rect.bottom) - 18)}px`);
    setError('');
    panel.showPopover();
    void checkConnection();
  }

  async function select(key: string, title: string, options: object = {}) {
    setBusy(title); onBusy(true); setError('');
    try {
      await window.storyDesk.call('selectWritingModel', { key, ...options }, work.id);
      await ctx.refresh();
      await refresh();
      popover.current?.hidePopover();
      trigger.current?.focus();
    } catch (e) { setError((e as Error).message); await refresh(); }
    finally { setBusy(''); onBusy(false); }
  }

  async function stop(key: string) {
    setBusy('正在停止'); onBusy(true); setError('');
    try { await call('localStop', { key }); }
    catch (e) { setError((e as Error).message); }
    finally { await refresh(); setBusy(''); onBusy(false); }
  }

  return <>
    <button ref={trigger} type="button" className="model-trigger" aria-label="选择写作模型" aria-expanded={open}
      aria-controls={id} aria-haspopup="dialog" disabled={running} onClick={toggle}>
      <span>{model.title || model.model || '选择模型'}</span><Icon name="chevron" size={13}/>
    </button>
    <div id={id} ref={popover} popover="auto" role="dialog" aria-label="选择写作模型" className="writing-model-picker"
      onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}>
      <section aria-labelledby={`${id}-connection`}>
        <div className="model-section-title"><h3 id={`${id}-connection`}>{connectionName}</h3>
          {connected && <button className="text-button" disabled={loading || !!busy} onClick={() => void fetchModels()}>{loading ? '读取中…' : '刷新列表'}</button>}
        </div>
        {connected ? <>
          {modelNames.length > 7 && <input aria-label="搜索模型" placeholder="搜索模型" value={search} onChange={e => setSearch(e.target.value)}/>}
          {matches.length ? <div className="model-options">{matches.map(name => <button key={name} type="button"
            disabled={!!busy || running} aria-pressed={model.key === 'analysis' && model.model === name}
            onClick={() => void select('analysis', '正在切换模型', { model: name, baseUrl: ai.baseUrl, modelList: modelNames })}>
            <span>{name}</span>{model.key === 'analysis' && model.model === name && <Icon name="check" size={15}/>}
          </button>)}</div> : <p className="model-note">{loading ? '正在读取可用模型…' : modelNames.length ? '没有匹配的模型。' : '刷新列表以读取可用模型。'}</p>}
        </> : <div className="model-row">
          <span className="model-note">{ai.enabled && cloud ? '请在作品设置保存模型连接' : '尚未配置连接'}</span>
          <button className="text-button" onClick={() => { popover.current?.hidePopover(); ctx.navigate({ page: 'settings' }); }}>配置连接</button>
        </div>}
      </section>
      <section aria-labelledby={`${id}-local`}>
        <div className="model-section-title"><h3 id={`${id}-local`}>本机模型</h3></div>
        {localPresets.length ? localPresets.map(preset => {
          const ready = status.ready.includes(preset.id), active = status.active === preset.id;
          const current = model.key === preset.id;
          const label = !preset.available && !ready ? '启动项不可用' : ready ? active ? '已运行' : '外部运行' : active ? '正在启动' : '已停止';
          return <div className="model-row" key={preset.id}>
            <button className="model-local-choice" aria-pressed={current} disabled={!!busy || running || !ready}
              onClick={() => void select(preset.id, '正在切换模型')}>
              <strong>{preset.title}</strong><small>{label}{current ? ' · 当前选择' : ''}</small>
            </button>
            {active ? <button disabled={!!busy || running} onClick={() => void stop(preset.id)} aria-label={`停止 ${preset.title}`}>停止</button>
              : !ready && preset.available && <button disabled={!!busy || running} onClick={() => void select(preset.id, `正在启动 ${preset.title}`, { start: true })}
                aria-label={`启动 ${preset.title}`}>{status.active ? '切换并启动' : '启动并使用'}</button>}
          </div>;
        }) : <p className="model-note">未找到本地模型启动器。</p>}
      </section>
      {busy && <p role="status" className="model-note">{busy}…</p>}
      {error && <p role="alert" className="notice danger">{error}</p>}
    </div>
  </>;
}
