import { AppError, atomicJson, decode, hash, stamp, uid } from './io.mjs';
import { manuscriptSpans } from './manuscript-findings.mjs';
import { isRecordedEvent } from './chapter-review.mjs';

const reportPath = '_创作管理/全书核对/当前任务.json';
const scanVersion = 2;
const running = new WeakMap();
const numbers = '[零〇一二两三四五六七八九十廿卅初0-9]+';
const datePattern = new RegExp(`(闰?${numbers})月(${numbers})(?:日|号|(?=$|[\\s，。、：；！？夜晨早晚午])|(?=时分))`, 'gu');
const yearPattern = new RegExp(`(天宝|开元|至德|乾元|贞观)(${numbers}|元)[载年]|(\\d{4})年`, 'u');
const forward = /约好|说定|答应|届时|约定|日后|改日|早晚有一日|到那时/u;
const unresolved = /尚未揭晓|仍未拆开|未曾启封|来历不明|去向不明|下落不明|谜底|从何而来|未解之谜/u;
const callback = /终于|果然|应约|如约|履约|原来|至此才|那封|那本|旧约|当年的/u;

function numberOf(text) {
  const digits = '零一二三四五六七八九';
  const value = text.replace(/^初/u, '').replaceAll('两', '二').replaceAll('〇', '零');
  if (/^\d+$/u.test(value)) return Number(value);
  if (value === '元') return 1;
  if (/^[廿卅][一二三四五六七八九]?$/u.test(value)) return (value[0] === '廿' ? 20 : 30) + (digits.indexOf(value[1]) > 0 ? digits.indexOf(value[1]) : 0);
  if (/^[一二三]?[十][一二三四五六七八九]?$/u.test(value)) {
    const [tens, ones] = value.split('十');
    return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
  }
  return digits.indexOf(value);
}

function dates(text) {
  const year = yearPattern.exec(text);
  return [...text.matchAll(datePattern)].flatMap(match => {
    const month = numberOf(match[1].replace(/^闰/u, '')), day = numberOf(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return [];
    return [{ label: match[0], offset: match.index, month, day, leap: match[1].startsWith('闰'),
      year: year && year.index < match.index ? year[3] || `${year[1]}${numberOf(year[2])}` : null }];
  });
}

function citation(doc, quote, start) {
  return { documentId: doc.id, title: doc.title, chapter: doc.chapter, sourceHash: doc.hash,
    start, line: doc.text.slice(0, start).split('\n').length, quote };
}

function registeredCitation(doc, entry) {
  if (!entry?.evidence || entry.source_hash && entry.source_hash !== doc.hash) return null;
  const quote = entry.evidence;
  const first = doc.text.indexOf(quote);
  const start = Number.isInteger(entry.start) && doc.text.startsWith(quote, entry.start) ? entry.start
    : first >= 0 && doc.text.indexOf(quote, first + 1) === -1 ? first : -1;
  return start < 0 ? null : citation(doc, quote.slice(0, 280), start);
}

function exactKeys(sentence) {
  return [...new Set([...sentence.matchAll(/《([^》《\r\n]{2,24})》|「([^」「\r\n]{2,16})」/gu)]
    .map(match => (match[1] || match[2]).trim()).filter(term => !/[。？！；]/u.test(term)))];
}

export function inspectBookChapter(doc, events, hooks) {
  const timeline = [], clues = [];
  const seenClues = new Set();
  const headingStack = [];
  const rows = [...doc.text.matchAll(/^[\t ]*(#{1,6})[\t ]+[^\r\n]+/gmu)].map(match => {
    const heading = { text: match[0], start: match.index, heading: true, level: match[1].length, sceneEnd: doc.text.length };
    while (headingStack.length && headingStack.at(-1).level >= heading.level) headingStack.pop().sceneEnd = heading.start;
    headingStack.push(heading);
    return heading;
  });
  rows.push(...manuscriptSpans(doc.text));
  for (const row of rows) {
    const sentences = row.heading ? [{ index: 0, 0: row.text }] : row.text.matchAll(/[^。！？；\r\n]+[。！？；]?/gu);
    for (const span of sentences) {
      const sentence = span[0].trim();
      if (!sentence) continue;
      const index = row.start + span.index + span[0].indexOf(sentence);
      const quote = sentence.slice(0, 280);
      const foundDates = dates(sentence);
      for (const date of foundDates) {
        const nearStart = Math.max(0, date.offset - 80);
        timeline.push({ ...date, kind: row.heading ? 'heading' : 'mention', sceneEnd: foundDates.length === 1 ? row.sceneEnd : undefined,
          evidence: citation(doc, sentence.slice(nearStart, nearStart + 280), index + nearStart) });
      }
      if (row.heading) continue;
      const keys = exactKeys(sentence);
      const cue = forward.test(sentence) ? '约定' : unresolved.test(sentence) ? '悬念' : callback.test(sentence) ? '照应' : '';
      // Named-object mentions can support a link across chapters without establishing payoff.
      for (const key of (keys.length ? keys : cue && cue !== '照应' ? [''] : [])) {
        const slot = `${key}:${cue}:${key ? '' : quote}`;
        if (seenClues.has(slot) || (!key && clues.filter(clue => !clue.key).length >= 12)) continue;
        seenClues.add(slot);
        const marker = key ? sentence.indexOf(key) : sentence.search(cue === '约定' ? forward : unresolved);
        const from = Math.max(0, marker - 85);
        clues.push({ key, cue, evidence: citation(doc, sentence.slice(from, from + 280), index + from) });
      }
    }
  }
  const eventRows = events.filter(event => event.source_document_id === doc.id).map(event => ({
    id: event.id, documentId: doc.id, title: event.title, time: event.story_time || '', stale: !!event.stale || !!event.externalPending || event.source_hash !== doc.hash,
    evidence: event.source_hash === doc.hash && [event.editorial_evidence, ...event.facts.filter(fact => fact.status === 'accepted')]
      .map(entry => registeredCitation(doc, entry)).find(Boolean) || null,
  }));
  const hookRows = hooks.flatMap(hook => (hook.details?.chapterUpdates || []).filter(row => row.documentId === doc.id).map(row => ({
    hookId: hook.id, title: hook.title, status: row.status, eventId: row.eventId,
    evidence: row.sourceHash === doc.hash ? registeredCitation(doc, row.evidence) : null,
  })));
  return { timeline: timeline.sort((a, b) => a.evidence.start - b.evidence.start), clues, events: eventRows, hooks: hookRows };
}

function sceneDateAt(chapter, start) {
  return chapter?.timeline.findLast(row => row.kind === 'heading' && row.evidence.start < start && start < row.sceneEnd);
}

function recurringClues(chapters) {
  const byKey = new Map();
  for (const chapter of chapters) for (const clue of (chapter.clues || []).filter(item => item.key)) {
    if (!byKey.has(clue.key)) byKey.set(clue.key, new Map());
    const mentions = byKey.get(clue.key);
    if (mentions.has(chapter.chapter) && (!clue.cue || mentions.get(chapter.chapter).cue)) continue;
    const date = sceneDateAt(chapter, clue.evidence.start);
    mentions.set(chapter.chapter, { ...clue, date: date?.label, dateEvidence: date?.evidence });
  }
  return [...byKey].filter(([, mentions]) => mentions.size > 1).map(([key, mentions]) => ({ key, mentions: [...mentions.values()] }));
}

function summaryIssues(report) {
  const issues = [], add = (category, title, detail, evidence = [], registryDocumentId) => {
    issues.push({ id: `${category}_${issues.length + 1}`, category, title, detail, evidence: evidence.filter(Boolean), registryDocumentId, status: 'pending' });
  };
  const done = report.chapters.filter(chapter => chapter.status === 'read');
  const headingDates = done.flatMap(chapter => chapter.timeline.filter(row => row.kind === 'heading'));
  for (let index = 1; index < headingDates.length; index++) {
    const before = headingDates[index - 1], after = headingDates[index];
    if (before.year && before.year === after.year && !before.leap && !after.leap && before.month * 32 + before.day > after.month * 32 + after.day) {
      add('timeline', '日期标题的顺序回退', `第${before.evidence.chapter}章 ${before.label}，随后是第${after.evidence.chapter}章 ${after.label}。请确认是否为倒叙、并行场景或日期需要调整。`, [before.evidence, after.evidence]);
    }
  }
  const events = new Map(done.flatMap(chapter => chapter.events).map(event => [event.id, event]));
  for (const event of events.values()) {
    if (event.stale || !event.evidence) {
      add('timeline', `事件需核对出处 · ${event.title}`, '这条登记需要重新对照现行正文版本。可查看当时作为依据的原句，以及更新与核对中的事件记录。', [event.evidence], event.documentId);
      continue;
    }
    const stated = dates(event.time), quoted = dates(event.evidence.quote);
    if (stated.length === 1 && quoted.length === 1 && !stated[0].leap && !quoted[0].leap &&
      (stated[0].month !== quoted[0].month || stated[0].day !== quoted[0].day)) {
      add('timeline', `事件日期与引文不同 · ${event.title}`, `登记时间为「${event.time}」，原句提到「${quoted[0].label}」。请核对原句所指时日。`, [event.evidence]);
    }
  }
  const links = new Map();
  for (const clue of done.flatMap(chapter => chapter.clues).filter(clue => clue.key)) {
    if (!links.has(clue.key)) links.set(clue.key, []);
    links.get(clue.key).push(clue);
  }
  for (const [key, clues] of links) {
    const earlier = clues.find(clue => ['约定', '悬念'].includes(clue.cue));
    const later = earlier && clues.find(clue => clue.evidence.chapter > earlier.evidence.chapter && clue.cue === '照应');
    if (later) {
      const nearbyDates = [earlier, later].flatMap(({ evidence }) => {
        const chapter = done.find(row => row.id === evidence.documentId);
        const date = sceneDateAt(chapter, evidence.start);
        return date ? [date.evidence] : [];
      });
      add('hook', `可能的跨章照应 · ${key}`, '一处有约定或悬念措辞，一处有回指措辞。若有场次日期，附在两处原句之后。请确认是不是同一条伏笔、有没有实际回收。', [earlier.evidence, later.evidence, ...nearbyDates]);
    }
  }
  for (const hook of report.hooks) {
    const updates = done.flatMap(chapter => chapter.hooks).filter(update => update.hookId === hook.id);
    for (const update of updates) {
      const event = events.get(update.eventId);
      if (!update.evidence || update.stale || !event || event.stale || !event.evidence) add('hook', `伏笔与时间线的连接待核对 · ${hook.title}`,
        `该次埋设、推进或回收记录缺少现行引文，或关联事件已变更。${event?.time ? `事件登记时间为「${event.time}」。` : ''}`, [update.evidence, event?.evidence]);
    }
    if (Number.isInteger(hook.introducedChapter) && Number.isInteger(hook.paidOffChapter) && hook.paidOffChapter < hook.introducedChapter) {
      add('hook', `回收章早于埋设章 · ${hook.title}`, `登记在第${hook.introducedChapter}章埋设、第${hook.paidOffChapter}章回收。请核对章节顺序或叙事安排。`, updates.map(row => row.evidence));
    }
  }
  return issues;
}

async function historicalCitations(workspace, doc, rows, events, hooks) {
  const snapshots = new Map();
  async function fromSnapshot(version, records) {
    if (!/^[a-f0-9]{64}$/u.test(version || '') || version === doc.hash) return null;
    if (!snapshots.has(version)) {
      const bytes = await workspace.store.read(`_创作管理/历史/文档版本/${doc.id}/${version}.md`);
      snapshots.set(version, bytes && hash(bytes) === version ? { ...doc, hash: version, text: decode(bytes).text } : null);
    }
    const old = snapshots.get(version);
    return old ? records.map(record => registeredCitation(old, record)).find(Boolean) || null : null;
  }
  for (const row of rows.events.filter(row => !row.evidence)) {
    const event = events.find(event => event.id === row.id);
    row.evidence = await fromSnapshot(event.source_hash, [event.editorial_evidence, ...event.facts.filter(fact => fact.status === 'accepted')]);
  }
  for (const row of rows.hooks.filter(row => !row.evidence)) {
    const update = hooks.find(hook => hook.id === row.hookId)?.details?.chapterUpdates?.find(update => update.documentId === doc.id && update.eventId === row.eventId && update.status === row.status);
    row.evidence = await fromSnapshot(update?.sourceHash, [update?.evidence]);
    row.stale = !!row.evidence;
  }
}

function chapterTargets(workspace) {
  return workspace.documents.filter(doc => doc.kind === 'chapter' && Number.isInteger(doc.chapter) && doc.chapter > 0)
    .sort((a, b) => a.chapter - b.chapter || a.path.localeCompare(b.path))
    .map(doc => ({ id: doc.id, chapter: doc.chapter, title: doc.title, path: doc.path, plannedHash: doc.hash || null }));
}

async function readReport(workspace) {
  const bytes = await workspace.store.read(reportPath);
  if (!bytes) return { report: null, expectedHash: null };
  let report;
  try { report = JSON.parse(bytes.toString('utf8')); } catch { throw new AppError('DAMAGED_DATA', '全书核对记录损坏，已保留原文件。'); }
  if (report?.schema !== 1 || report.workId !== workspace.project.id || !/^book-review_[a-f0-9-]{36}$/u.test(report.id) ||
    !Array.isArray(report.chapters) || !Array.isArray(report.issues) || !Array.isArray(report.hooks)) {
    throw new AppError('DAMAGED_DATA', '全书核对记录与当前作品不符。');
  }
  return { report, expectedHash: hash(bytes) };
}

const storeReport = async (workspace, report) => atomicJson(await workspace.store.resolve(reportPath), report);

function inputs(workspace) {
  const active = new Set(workspace.project.approvals.filter(approval => approval.status === 'active').map(approval => approval.id));
  const events = workspace.events.filter(event => isRecordedEvent(event) && active.has(event.approval_id) &&
    (event.editorial_layer === 'occurred' || !event.editorial_layer && event.facts.some(fact => fact.status === 'accepted' && fact.layer === 'occurred')));
  const hooks = workspace.records.filter(row => row.kind === 'hook' && !row.damaged && !row.unreviewedExternal && !row.externalPending);
  const token = hash(JSON.stringify([events, hooks]));
  return { events, hooks, token };
}

async function executeBookReview(workspace, report, controller) {
  try {
    const { events, hooks, token } = inputs(workspace);
    if (report.inputHash !== token) throw new AppError('CONFLICT', '事件或伏笔已更新，请重新开始核对。');
    for (const chapter of report.chapters) {
      if (controller.signal.aborted) break;
      if (chapter.status === 'read') continue;
      try {
        const source = await workspace.snapshotDocument(workspace.doc(chapter.id));
        if (chapter.plannedHash && chapter.plannedHash !== source.hash) throw new AppError('CONFLICT', '开始后稿件已更新，请重新核对当前版本。');
        const confirmed = workspace.project.approvals.some(approval => approval.documentId === source.id && approval.kind === 'prose' &&
          !approval.sceneId && approval.sourceHash === source.hash && approval.status === 'active');
        const rows = inspectBookChapter(source, events, hooks);
        await historicalCitations(workspace, source, rows, events, hooks);
        Object.assign(chapter, rows, { status: 'read', sourceHash: source.hash, confirmed });
        delete chapter.error;
      } catch (error) { Object.assign(chapter, { status: 'unread', error: error.message }); }
      await storeReport(workspace, report);
    }
    const previous = new Map(report.issues.map(issue => [issueKey(issue), issue]));
    report.issues = summaryIssues(report).map(issue => {
      const prior = previous.get(issueKey(issue));
      return prior ? { ...issue, status: prior.status, decidedAt: prior.decidedAt, change: prior.change } : issue;
    });
    report.links = recurringClues(report.chapters);
    report.status = controller.signal.aborted ? 'paused' : report.chapters.some(chapter => chapter.status !== 'read') ? 'partial' : 'complete';
    report.finishedAt = stamp();
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  } finally {
    try { await storeReport(workspace, report); }
    finally {
      running.delete(workspace); workspace.controllers.delete(report.id);
      const waiting = !workspace.closing && workspace.project.jobs.find(job => job.status === 'queued');
      if (waiting) setTimeout(() => workspace.executeJob(waiting.id).catch(() => {}), 0);
    }
  }
}

const issueKey = issue => JSON.stringify([issue.category, issue.title, issue.detail,
  issue.evidence.map(row => [row.documentId, row.sourceHash, row.start, row.quote])]);

export const bookReviewMethods = {
  async getBookReview() {
    const { report } = await readReport(this);
    if (!report) return null;
    const active = running.has(this);
    const current = new Map(this.documents.map(doc => [doc.id, doc.hash]));
    const changedDocumentIds = report.chapters.filter(row => current.has(row.id) === false ||
      (row.sourceHash || row.plannedHash) && current.get(row.id) !== (row.sourceHash || row.plannedHash)).map(row => row.id);
    const outdated = report.inputHash !== inputs(this).token || chapterTargets(this).length !== report.chapters.length || !!changedDocumentIds.length;
    return { ...report, outdated, needsRescan: report.scanVersion !== scanVersion, changedDocumentIds, active,
      status: !active && report.status === 'running' ? 'paused' : report.status };
  },
  async startBookReview({ resume = false } = {}) {
    if (running.has(this)) return this.getBookReview();
    if ([...this.controllers.keys()].some(id => id.startsWith('book-semantic_'))) {
      throw new AppError('BUSY', '请先结束当前报告的语义复核。');
    }
    const { report: previous } = await readReport(this);
    const chapters = chapterTargets(this);
    if (!chapters.length) throw new AppError('VALIDATION', '请先接入有章序的正文。');
    const { hooks, token } = inputs(this);
    let report;
    if (resume) {
      if (!previous || previous.scanVersion !== scanVersion || !['paused', 'running', 'partial'].includes(previous.status) || (await this.getBookReview()).outdated) {
        throw new AppError('CONFLICT', '核对范围或资料已更新，请重新开始。');
      }
      report = previous;
    } else {
      if (previous) await atomicJson(await this.store.resolve(`_创作管理/全书核对/历史/${previous.id}.json`), previous);
      report = { schema: 1, scanVersion, workId: this.project.id, id: uid('book-review'), createdAt: stamp(), inputHash: token,
        chapters: chapters.map(chapter => ({ ...chapter, status: 'queued' })), issues: previous?.issues.filter(issue => issue.evidence.length && issue.status !== 'written') || [], hooks: hooks.map(row => ({ id: row.id,
          title: row.title, status: row.status, introducedChapter: row.details?.introducedChapter, paidOffChapter: row.details?.paidOffChapter })) };
    }
    report.status = 'running';
    delete report.error;
    const controller = new AbortController();
    running.set(this, controller);
    this.controllers.set(report.id, controller);
    try { await storeReport(this, report); }
    catch (error) { running.delete(this); this.controllers.delete(report.id); throw error; }
    void executeBookReview(this, report, controller).catch(error => this.notify?.({ type: 'error', message: error.message }));
    return this.getBookReview();
  },
  stopBookReview() {
    running.get(this)?.abort();
    return true;
  },
  async previewBookEvidence({ documentId, sourceHash, start, quote }) {
    if (!/^doc_[\w-]+$/u.test(documentId) || !/^[a-f0-9]{64}$/u.test(sourceHash) || !Number.isInteger(start) || start < 0 ||
      typeof quote !== 'string' || !quote || quote.length > 2000) throw new AppError('VALIDATION', '出处位置无效。');
    const doc = this.documents.find(row => row.id === documentId);
    const live = doc && await this.store.read(doc.path);
    const current = !!live && hash(live) === sourceHash;
    const bytes = current ? live : await this.store.read(`_创作管理/历史/文档版本/${documentId}/${sourceHash}.md`);
    if (!bytes || hash(bytes) !== sourceHash) return { exact: false, current: false, before: '', after: '' };
    const text = decode(bytes).text;
    if (!text.startsWith(quote, start)) return { exact: false, current: false, before: '', after: '' };
    return { exact: true, current, before: text.slice(Math.max(0, start - 220), start), after: text.slice(start + quote.length, start + quote.length + 220) };
  },
  async decideBookReview({ reportId, issueId, action, evidenceIndex, replacement, confirmed }) {
    const { report, expectedHash } = await readReport(this);
    if (!report || report.id !== reportId || running.has(this)) throw new AppError('CONFLICT', '核对任务已更新，请重新打开。');
    if (report.scanVersion !== scanVersion) throw new AppError('CONFLICT', '请先用现行场次日期规则重新核对，再处理疑点。');
    const issue = report.issues.find(row => row.id === issueId);
    if (!issue || issue.status === 'written' || !['confirm', 'keep', 'reopen', 'write'].includes(action)) throw new AppError('VALIDATION', '请选择可处理的疑点。');
    if (action !== 'write') {
      issue.status = { confirm: 'confirmed', keep: 'kept', reopen: 'pending' }[action];
      issue.decidedAt = stamp();
      await this.store.batch('全书核对 · 作者裁定', [{ path: reportPath, expectedHash, text: JSON.stringify(report, null, 2) }]);
      return this.getBookReview();
    }
    const evidence = issue.evidence[evidenceIndex];
    if (confirmed !== true || issue.status !== 'confirmed' || !evidence || typeof replacement !== 'string' ||
      !replacement.trim() || replacement.trim() === evidence.quote.trim() || replacement.length > 1500 || replacement.includes('\0')) {
      throw new AppError('VALIDATION', '请先确认疑点，再填写不同的替换文字并确认写回。');
    }
    for (const item of issue.evidence) {
      const source = await this.store.read(this.doc(item.documentId).path);
      if (!source || hash(source) !== item.sourceHash) throw new AppError('CONFLICT', '此条疑点引用的原文已更新，请重新核对。');
    }
    const doc = await this.readDocument(evidence.documentId);
    if (doc.hash !== evidence.sourceHash || !doc.text.startsWith(evidence.quote, evidence.start) || doc.draft && doc.draft.text !== doc.text) {
      throw new AppError('CONFLICT', '原文或恢复草稿已有新版本，请先处理当前稿件。');
    }
    issue.status = 'written';
    issue.change = { ...evidence, replacement, at: stamp() };
    const text = doc.text.slice(0, evidence.start) + replacement + doc.text.slice(evidence.start + evidence.quote.length);
    await this.saveDocument({ documentId: doc.id, expectedHash: doc.hash, text }, {
      label: '全书核对 · 作者确认写回', additionalChanges: [{ path: reportPath, expectedHash, text: JSON.stringify(report, null, 2) }],
    });
    return this.getBookReview();
  },
};
