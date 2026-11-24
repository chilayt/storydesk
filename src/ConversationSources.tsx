import { useState } from 'react';
import type { AppContext } from './domain';
import type { DiscussionReference, WritingScope } from './writing-domain';
import { Icon } from './components';

const categories = [
  { key: 'plan', label: '剧情规划', icon: 'plot' },
  { key: 'chapter', label: '正文', icon: 'book' },
  { key: 'draft', label: '草稿', icon: 'edit' },
  { key: 'people', label: '人物档案', icon: 'users' },
  { key: 'map', label: '地点与地图', icon: 'map' },
];
const planningScopes = [
  { key: 'next', label: '当前章节' },
  { key: 'stage', label: '阶段规划' },
  { key: 'volume', label: '分卷规划' },
  { key: 'work', label: '全书规划' },
] as const;

export function ConversationSources({ ctx, references, scope, disabled, onSelect, onScope }: {
  ctx: AppContext; references: DiscussionReference[]; scope: WritingScope; disabled: boolean;
  onSelect: (item: DiscussionReference) => void; onScope: (scope: WritingScope) => void;
}) {
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(8);
  const visible = ctx.work.documents.filter(doc => !doc.error && !doc.generated && !ctx.work.hiddenChapterMaterials?.includes(doc.id));
  const docs = category === 'plan' ? visible.filter(doc => ['plan', 'plot'].includes(doc.kind)) : visible.filter(doc => doc.kind === category);
  const next = ctx.work.nextChapter ?? ctx.work.stats.latestFile + 1;
  const order = (doc: typeof docs[number]) => {
    const chapter = doc.chapter ?? doc.chapterMaterial?.chapter ?? 0;
    return category === 'plan' && chapter === next ? -1 : chapter;
  };
  docs.sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path, 'zh-CN'));
  const sources: DiscussionReference[] = category === 'people' ? ctx.work.characters.map(person => ({
    kind: 'character', id: person.id, title: person.name, revision: person.revision,
  })) : category === 'map' ? (ctx.work.locationMaps || []).flatMap(place => place.map.documentId ? [{
    kind: 'map', id: place.id, title: `${place.name} · ${place.map.version}`, version: place.map.version, documentId: place.map.documentId,
  }] : []) : [
    ...(category === 'plan' ? (ctx.work.stagePlans || []).flatMap(plan => plan.hash ? [{
      kind: 'stage' as const, id: plan.id, title: `${plan.title} · 第 ${plan.fromChapter}–${plan.toChapter} 章`, hash: plan.hash,
    }] : []) : []),
    ...docs.filter(doc => doc.hash).map(doc => ({ kind: 'document' as const, id: doc.id, title: doc.title, hash: doc.hash })),
  ];
  const filtered = sources.filter(item => !query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase()) ||
    (item.kind === 'character' && ctx.work.characters.find(row => row.id === item.id)?.aliases.some(alias => alias.includes(query.trim()))));
  return <section className="conversation-sources" aria-label="选择讨论资料">
    <div className="conversation-source-types">{categories.map(item => <button key={item.key} type="button" aria-pressed={category === item.key}
      disabled={disabled} onClick={() => { setCategory(current => current === item.key ? '' : item.key); setQuery(''); setLimit(8); }}>
      <Icon name={item.icon} size={15}/>{item.label}</button>)}</div>
    {category === 'plan' && <div className="conversation-planning" role="group" aria-label="剧情规划范围">
      {planningScopes.map(item => <button key={item.key} type="button" aria-pressed={scope === item.key}
        onClick={() => onScope(item.key)} disabled={disabled}>
        {scope === item.key && <Icon name="check" size={14}/>}<span>{item.label}</span>
      </button>)}
    </div>}
    {category && <div className="conversation-source-results">
      {sources.length > 8 && <input aria-label="筛选讨论资料" placeholder="按名称筛选" value={query}
        onChange={e => { setQuery(e.target.value); setLimit(8); }}/>}
      {category !== 'plan' && sources.length > 0 && <p className="conversation-source-hint">点击下方条目加入本轮引用</p>}
      {filtered.slice(0, limit).map(item => {
        const cited = references.some(row => row.id === item.id && row.kind === item.kind);
        return <button type="button" key={item.id} disabled={disabled} data-cited={cited || undefined}
          className="conversation-source-row" onClick={() => onSelect(item)}>
          <span>{item.title}</span><small>{cited ? <><Icon name="check" size={13}/>已引用</> : '@ 引用'}</small></button>;
      })}
      {filtered.length > limit && <button className="text-button" onClick={() => setLimit(count => count + 8)}>显示更多</button>}
      {!filtered.length && <p className="studio-muted">{query.trim() ? '没有找到匹配资料。' : '本作品尚未登记这类资料。'}</p>}
    </div>}
  </section>;
}
