import React, { useState } from 'react';
import type { AppContext, SourceDocument, Work } from './domain';
import { kindLabels } from './domain';
import { Badge, Icon, Modal } from './components';
import './location-maps.css';

export const worldKinds = ['setting', 'organization', 'family', 'location', 'item'];
export const pendingLibraryDoc = (doc: SourceDocument) => doc.kind === 'reference' && doc.path.startsWith('创作资料库/待核对/');

export function worldDocumentStatus(work: Work, doc: SourceDocument) {
  if (doc.error) return '解析待处理';
  if (doc.external) return '外部修改待核对';
  return work.settingMeta?.[doc.id]?.confirmed && work.approvals.some(a => a.documentId === doc.id && a.sourceHash === doc.hash && a.kind === 'ruling' &&
    a.status === 'active') ? '作者已确认' : '待核对原档';
}

export function openMaterial(ctx: AppContext, doc: SourceDocument) {
  if (doc.kind === 'attachment') return ctx.navigate({ page: 'attachment', documentId: doc.id });
  ctx.navigate({ page: 'reader', documentId: doc.id });
}

function LocationMaps({ ctx }: { ctx: AppContext }) {
  const places = ctx.work.locationMaps || [];
  if (!places.length && !ctx.work.locationMapIssue) return null;
  return <section className="panel location-map-index" aria-label="现行地图">
    <div className="panel-heading"><h2>现行地图</h2></div>
    {ctx.work.locationMapIssue && <p role="alert" className="notice">{ctx.work.locationMapIssue}</p>}
    {places.length > 0 && <ul className="location-map-list">
      {places.map(place => {
        const { map } = place;
        const document = ctx.work.documents.find(doc => doc.id === map.documentId);
        return <li key={place.id} className="location-map-row">
          <button type="button" className="text-button location-map-link" disabled={!document}
            aria-label={'打开' + place.name + '地图 · ' + map.title + ' ' + map.version}
            onClick={() => document && openMaterial(ctx, document)}>
            <strong>{place.name}</strong><span>{map.title} {map.version}</span><Icon name="arrow" size={15}/>
          </button>
          {!document && <p className="location-map-missing">指定地图文件不可用 · {map.path}</p>}
          <details className="location-map-settings">
            <summary>地点设定</summary>
            <p>{place.summary}</p>
            <ul>{place.sources.map(source => {
              const reference = ctx.work.documents.find(doc => doc.id === source.documentId);
              return <li key={source.path}>{reference
                ? <button className="text-button" onClick={() => openMaterial(ctx, reference)}>{source.title}</button>
                : <span>{source.title} · 原档不可用</span>}</li>;
            })}</ul>
          </details>
        </li>;
      })}
    </ul>}
  </section>;
}

export function WorldSources({ ctx, kind }: { ctx: AppContext; kind: 'organization' | 'location' | 'item' }) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const mapIds = new Set(ctx.work.locationMaps?.map(place => place.map.documentId));
  const sources = ctx.work.documents.filter(d => d.kind === kind || kind === 'location' && d.kind === 'attachment' && !mapIds.has(d.id));
  const term = query.trim().toLocaleLowerCase();
  const shown = sources.filter(d => !term || [d.title, ...(d.aliases || []), d.path].some(name => name.toLocaleLowerCase().includes(term)));
  async function addMap() {
    setAdding(true);
    try {
      const picked = await ctx.call('pickMaterial', { map: true });
      if (picked) await ctx.act(() => ctx.call('registerLocationMap', { relativePath: picked }), '地图已登记，可在地点记录中关联');
    } catch (error) { ctx.notify((error as Error).message, true); }
    finally { setAdding(false); }
  }
  if (!sources.length && kind !== 'location') return null;
  return <>{kind === 'location' && <LocationMaps ctx={ctx}/>}<section className="panel world-sources">
    <div className="panel-heading"><h2>{kindLabels[kind]}原档</h2>
      {kind === 'location' && <button disabled={adding} onClick={() => void addMap()}>{adding ? '正在选择…' : '登记本地地图'}</button>}
    </div>
    {!!sources.length && <div className="list-toolbar"><label>筛选原档<input type="search" value={query} onChange={e => setQuery(e.target.value)}/></label>
      <small>{shown.length} 份资料</small>
    </div>}
    {shown.length ? <div className="document-grid">{shown.map(doc => <button key={doc.id} className="document-card"
      onClick={() => openMaterial(ctx, doc)}>
      <Badge>{doc.kind === 'attachment' ? (mapIds.size ? '其他附件' : '地图附件') : worldDocumentStatus(ctx.work, doc)}</Badge>
      <h3>{doc.title}</h3>
      {!!doc.aliases?.length && <p>别名 {doc.aliases.join('、')}</p>}
      <p>{doc.path}</p>
    </button>)}</div> : <p className="muted">{sources.length ? '没有匹配的原档' : '尚未登记地点资料或地图'}</p>}
  </section></>;
}

export function ClassifyMaterial({ ctx, doc, onClose, onClassified }: {
  ctx: AppContext; doc: SourceDocument; onClose: () => void; onClassified: (doc: SourceDocument) => void;
}) {
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const result = await ctx.act(() => ctx.call('classifyLibraryDocument',
      { documentId: doc.id, expectedHash: doc.hash, kind }), '本库副本已归类，来源和版本记录已保留');
    setBusy(false);
    if (result) {
      onClassified(result);
      onClose();
    }
  }
  return <Modal title="归类本库资料" subtitle={doc.title} onClose={onClose}>
    <label>资料类型<select value={kind} onChange={e => setKind(e.target.value)}>
      <option value="">选择分类</option>{[...worldKinds, 'rule'].map(type => <option key={type} value={type}>{kindLabels[type]}</option>)}
    </select></label>
    <p>归类会把这份副本移入对应目录，原文内容和文档编号保留。设定是否适用可另行确认。</p>
    <div className="modal-footer"><button disabled={busy} onClick={onClose}>取消</button>
      <button className="primary" disabled={!kind || busy} onClick={() => void save()}>{busy ? '正在归类…' : '确认归类'}</button></div>
  </Modal>;
}
