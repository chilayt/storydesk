import { AppError, decode, encode, hash, uid } from './io.mjs';
import { planningTarget } from './planning.mjs';

export const bookDesignInstruction = [
  '你在引导第一次构思新小说的作者。作者可以只讲一个画面、一种人物或一个设想。',
  '以作者本轮最清楚的东西为起点，没有必经的顺序。世界或行业先找谁会被逼着作决定；人物或关系先找双方的目标与不能兼得之处；事件或结局先反推谁的选择会造成它；已有因果主线直接检验分卷。每轮只问一个能改变后续设计的问题。简短说明为何先问它。若作者只要求整理或复核，直接执行。',
  '从人物选择推剧情，再用人物的处境、动机和关系反查这次选择是否成立。分卷要说清读者期待的事、卷中推进、卷末兑现与改变。卷数、章数及结局可以待定。世界设定先查会影响选择的规则，工业等现实资料不足时列待核实。',
  '复述只保留作者明确给出的内容与现行裁定。你的推测、可能动机或结局解释须在引入时标明“一个可能是”或“可以考虑”，待作者选择。画面中的空位、未知的债务、相同行为都可能有多重解释。不要用推断替换作者的原话，也不要把它写入待核对构思的事实陈述。',
  '全书大纲用“核心构想、人物与目标、主要阻力、故事走向、待定事项”组织。其他设计按其用途列小标题。保留尚未做的决定，遇到和前面不一致的说法先请作者选择。',
  '以 bookDecisions 中的作者裁定为准，状态为 exploring（待探索）、tentative（暂定）或 confirmed（已确认）。只有作者通过界面保存才能改变状态。聊天中提到的可能性、备选和未选中的方向不要当成既定设定，也不要写进正式资料。清楚的单项定案或改动意向可用 prepare_book_decisions 整理成核对卡。已有同一决定时传 replaces；确认权限始终由作者控制。',
  '遇到改动先说它和哪条旧决定不同，保留作者明确未改的动机和条件。复核时阅读 bookDecisions 中的 dependsOn、documents 和 review，逐条说清受影响的卷纲、章纲或人物关系为何需要核对。回复使用资料标题，ID 留给工具。只把有依据的依赖列为已记录；欠缺依赖记录时注明范围，其他潜在影响列为建议核查，不自动改下游文档。',
  '需要整理成文档时使用 prepare_book_design。分清整理档案和确定构思两种动作，写完候选卡后接着回答作者。',
  '全书大纲、卷纲和章纲分别写到各自的设计文件，人物档案和世界设定各自建档。形成首章目标、阻力与收束时，可以建议转入本章讨论。此任务专用于设计。',
].join('\n');

const kinds = ['work', 'volume', 'chapter', 'character', 'setting'];
export const bookDesignParameters = {
  type: 'object', properties: {
    items: { type: 'array', minItems: 1, maxItems: 6, items: {
      type: 'object', properties: {
        kind: { type: 'string', enum: kinds },
        title: { type: 'string', maxLength: 80, description: '人物的确切姓名或设定名称；其他类型可写相应纲要标题' },
        number: { type: 'integer', minimum: 1, maximum: 99999, description: '卷纲填卷号，章纲填章号' },
        text: { type: 'string', maxLength: 16000, description: '完整 Markdown 正文。更新时保留作者已有内容并并入本轮变化。仅记录作者提供或选定的设计。' },
        quote: { type: 'string', minLength: 2, maxLength: 250, description: '逐字摘录支持该项的作者原话，便于核对' },
      },
      required: ['kind', 'title', 'text', 'quote'], additionalProperties: false,
    } },
  }, required: ['items'], additionalProperties: false,
};

export function validDesignText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 16000 || text.includes('\0') ||
    /<!--\s*storydesk:/iu.test(text)) throw new AppError('VALIDATION', '请输入有效的设计正文，最多 16000 字符。');
  return text.trim();
}

function designTarget(workspace, row) {
  if (row.kind === 'work') return { outlineId: 'outline_work', ...planningTarget('outline_work') };
  if ((row.kind === 'volume' || row.kind === 'chapter') && Number.isInteger(row.number) && row.number > 0 && row.number <= 99999) {
    const outlineId = `outline_${row.kind}_${row.number}`;
    return { outlineId, ...planningTarget(outlineId) };
  }
  if (!['character', 'setting'].includes(row.kind)) throw new AppError('VALIDATION', '请明确类型与章卷序号。');
  const title = typeof row.title === 'string' ? row.title.trim().normalize('NFC') : '';
  if (!title || title.length > 80 || /[<>:"/\\|?*\x00-\x1f]|[. ]$|^\./u.test(title) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(title)) {
    throw new AppError('VALIDATION', '请使用有效的本地文件名称。');
  }
  if (row.kind === 'character') {
    const people = workspace.project.characters.filter(c => c.status !== 'merged' &&
      [c.name, ...c.aliases].some(name => name.normalize('NFKC').toLowerCase() === title.normalize('NFKC').toLowerCase()));
    if (people.length > 1 || people.some(c => c.name !== title || c.primarySourceId &&
        workspace.documents.find(doc => doc.id === c.primarySourceId)?.path !== `人物/${title}.md`)) {
      throw new AppError('CONFLICT', '该人物已有档案或同名记录，请从现有人物档案核对。');
    }
  }
  const folder = row.kind === 'character' ? '人物' : '设定';
  return { title, folder, path: `${folder}/${title}.md` };
}

export async function prepareBookDesign(workspace, rows, authors) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 6) throw new AppError('VALIDATION', '每轮可整理 1–6 项设计。');
  const targets = new Set(), items = [];
  for (const row of rows) {
    const quote = typeof row?.quote === 'string' ? row.quote.trim() : '';
    if (quote.length < 2 || quote.length > 250 || !authors.some(message => message.includes(quote))) {
      throw new AppError('EVIDENCE', '设计须附作者原话，未确认的想法继续讨论。');
    }
    const text = validDesignText(row.text), target = designTarget(workspace, row), key = target.path.toLowerCase();
    if (targets.has(key)) throw new AppError('CONFLICT', '请将同一份设计合在一项里。');
    targets.add(key);
    const bytes = await workspace.store.read(target.path);
    const previous = bytes ? decode(bytes).text : '';
    if (bytes && !target.outlineId && (!workspace.documents.some(doc => doc.path === target.path &&
        doc.kind === row.kind && !doc.readOnly) || /<!--\s*storydesk:/iu.test(previous))) {
      throw new AppError('CONFLICT', '本文件已有保护区块或不可编辑，请在原档核对。');
    }
    if (previous.length > 16000) throw new AppError('VALIDATION', '原纲要较长，请在大纲编辑器中修订。');
    items.push({ id: uid('design'), kind: row.kind, ...target, text, quote, previous, expectedHash: bytes ? hash(bytes) : null });
  }
  return items;
}

export async function saveBookDesignFile(workspace, item, text, decision) {
  const kind = item.kind, before = await workspace.store.read(item.path);
  if ((before ? hash(before) : null) !== item.expectedHash) throw new AppError('CONFLICT', '设计文件已变化，请按现行版本重新整理。');
  const doc = workspace.documents.find(row => row.path === item.path);
  if (doc) {
    const current = await workspace.readDocument(doc.id);
    if (current.readOnly || current.draft && current.draft.text !== current.text) {
      throw new AppError('UNSAVED_DRAFT', '这份资料处于只读或有未保存编辑，请先在原档处理。');
    }
  }
  const body = text.replaceAll('\r\n', '\n');
  const content = body.startsWith(`# ${item.title}\n`) ? body : `# ${item.title}\n\n${body}`;
  const changes = [{ path: item.path, expectedHash: item.expectedHash, bytes: encode(`${content}\n`, before ? decode(before) : {}) }, decision];
  const next = structuredClone(workspace.project);
  if (!next.sources.some(row => row.kind === kind && row.path === item.folder)) {
    next.sources.unshift({ path: item.folder, kind, depth: 0 });
  }
  await workspace.commit('保存作者核对的新书设计', changes, next);
  return workspace.documents.find(doc => doc.path === item.path);
}
