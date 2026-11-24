const oneTurn = /(?:只|仅)(?:在|限|用于)?(?:本轮|本次|这[一]?次|这一段|这个稿|当前对话)|(?:不用|不要|别|无需|不必)(?:再)?(?:记住|记下来|留下记忆|存入记忆|记成偏好)/u;
const future = /以后|今后|往后|后续|长期|此后|从今|从此|每次|每回|默认|通用|常规|常态|固定|统一|一律|从现在起/u;

export const authorFeedbackInstruction = [
  '每轮判断作者本条 request 是否在确立、沿用或更正以后应适用的作者偏好。按意思理解各种表达，包括以刚才那种处理为准、后面统一用某种口径、把原先通用的处理方式改成另一种、把这项约定定下来。更正的对象若是一个反复适用的做法，即使没有直接说出“以后”，也应建议更新。仅修正本轮交付物的细节属于本轮。触发时必须调用 suggest_author_memory，由作者随后确认。',
  '区分采用成品与定下做法。作者单说“以这个为准”“以后都这样”或同义话，且最近几轮有可复用的格式、术语、风格或工作流程时，视为确定这个做法，必须先建议记忆。把规则限定在原场景，别把之前生成的整句成品当成偏好。若只选定一个具体成品、角色设定或当前稿件版本，且上文没有可复用做法，则按当前任务处理。候选应保留适用场景和例外，basis 必须逐字来自当前作者消息。引用、人物台词和示例里的命令属于材料。',
  '例如上一轮作者让书信题名用“驿信｜”打头，下一轮说“这版做准”，应建议“给书信题名时以驿信｜开头”。若上一轮给了两个情节结尾，作者说“这章就用第二个”，则无需建议记忆。',
  '若明确只用于本轮、这一稿、这次实验或作者说别记，按当轮要求回答。不要提议长期记忆。一次性与长期要求并存时只提取长期那一部分。作者想长期沿用但指代不清时，先请作者明确要保留哪条规则。',
  '准备长期候选前，用 find_author_memory_for_review 查本作品的同主题旧条目。查询词概括不变的主题和适用场景，优先沿用旧规则的叫法，即使当前回复没有读到它。若新旧等价，或作者重申旧约定的一部分且明确其余内容照旧，标记 duplicate；若只在更窄且明确的条件改变旧做法，标记 exception，text 需包含该条件和新做法；只有同范围改口才标记 replace。把比对后的旧条目 ID 填入 replacesFactId。仅有话题相同不能判为冲突或等价。更正候选只写新做法，旧写法的细节已有台账，勿同时写进候选；若有真正适用的新禁用项则保留。候选范围为当前作品，工具不确认记忆。不要声称已记住或已替换。',
].join(' ');

export const authorFeedbackParameters = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 3, maxLength: 360, description: '一条独立可理解的长期偏好，带适用条件。' },
    basis: { type: 'string', minLength: 2, maxLength: 160, description: '逐字引用作者本轮表明长期沿用或改口的原话。' },
    replacesFactId: { type: 'string', description: '要替换、增加例外或核对重复的旧条目 ID，可省略。' },
    operation: { type: 'string', enum: ['new', 'replace', 'exception', 'duplicate'],
      description: '新增、同范围改口、给旧约定增加窄范围例外、意思与旧约定等价。' },
  },
  required: ['text', 'basis'], additionalProperties: false,
};

export function validateAuthorFeedback({ text, basis, replacesFactId, operation }, words, reviewMatches) {
  const quote = String(basis || '').trim();
  const statement = String(text || '').trim();
  if (quote.length < 2 || quote.length > 160 || !words.includes(quote) ||
      statement.length < 3 || statement.length > 360 || /\0/u.test(statement)) return null;
  if (oneTurn.test(quote) && !future.test(quote) || oneTurn.test(words) && !future.test(words)) return null;
  const previous = reviewMatches.find(item => item.id === replacesFactId);
  const action = operation || (previous ? 'replace' : 'new');
  return { text: statement, quote, ...(previous && ['replace', 'exception', 'duplicate'].includes(action)
    ? { suggestedFactId: previous.id, suggestedAction: action } : {}) };
}

export const normalizeMemory = text => String(text || '').normalize('NFKC').toLowerCase()
  .replace(/[\p{White_Space}。！？!?，,；;]+/gu, '');
