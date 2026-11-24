import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../core/workspace.mjs';

export const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-output');
export const chapterText = '# 第一章　渡口\n\n七月廿三，阿青在渡口遇见沈舟。\n\n阿青把《听潮诀》交给沈舟。沈舟开始试练第一层。\n\n阿青说：“明日去北城。”\n';
export async function fixture(name = 'case', options = {}) {
  await fs.mkdir(output, { recursive: true }); const root = await fs.mkdtemp(path.join(output, `${name}-`));
  const write = async (relative, text) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  await write('05-剧本/正文/第01章_渡口.md', chapterText);
  await write('05-剧本/正文/第02章_北城.md', '# 第二章　北城\n\n七月廿四，阿青到了北城。\n');
  await write('01-人物/人物分档/阿青.md', '# 阿青\n\n## 一、基本信息\n\n- 姓名：阿青\n- 居处：南村\n\n## 二、性格\n\n- 谨慎，重承诺。\n\n## 三、剧情进展\n\n第一章在渡口遇见沈舟。\n');
  await write('01-人物/人物分档/沈舟.md', '# 沈舟\n\n## 一、基本信息\n\n- 姓名：沈舟\n- 身份：船工\n\n## 二、武学\n\n初始尚未修习听潮诀。\n');
  await write('01-人物/白沙沈氏家谱.md', '# 群像\n\n| 名 | 身份 |\n|---|---|\n| 陆迟 | 商人 |\n');
  await write('03-世界观/武学功法/听潮诀.md', '# 听潮诀\n\n此功只增长听力，不改变容貌。\n');
  await write('05-剧本/剧情推进.md', '# 剧情推进\n\n## 一、当前状态\n\n第一章定稿状态待确认。\n');
  const workspace = new Workspace(root, options); await workspace.init();
  return { root, workspace, write, read: rel => fs.readFile(path.join(root, rel), 'utf8'), close: () => workspace.close() };
}
export function modelFacts(input, override) {
  const data = JSON.parse(input.messages[1].content);
  const aq = data.characters.find(c => c.name === '阿青'); const sz = data.characters.find(c => c.name === '沈舟');
  const facts = [
    { entity_id: aq?.id, field: 'relationship', value: { otherId: sz?.id, type: '相识', attitude: '初识', direction: 'outgoing' }, layer: 'occurred', certainty: 'explicit', evidence: '阿青在渡口遇见沈舟。' },
    { entity_id: sz?.id, field: 'item_holder', value: '《听潮诀》功法册', layer: 'occurred', certainty: 'explicit', evidence: '阿青把《听潮诀》交给沈舟。' },
    { entity_id: sz?.id, field: 'skill', value: { skillName: '听潮诀', stage: '开始修习', level: '第一层' }, layer: 'occurred', certainty: 'explicit', evidence: '沈舟开始试练第一层。' },
    { entity_id: aq?.id, field: 'location', value: '北城', layer: 'occurred', certainty: 'explicit', evidence: '阿青说：“明日去北城。”' },
    { entity_id: aq?.id, field: 'base.天赋', value: '绝世天才', layer: 'baseline', certainty: 'inferred', evidence: '阿青在渡口遇见沈舟。' }
  ];
  return override ? override({ aq, sz, facts, data }) : [{ title: '渡口相识与传书', summary: '阿青与沈舟相识，功法册转交，沈舟开始试练。', story_time: '七月廿三', facts }];
}
export function modelFetch(override) {
  return async (_url, request) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ events: modelFacts(JSON.parse(request.body), override) }) } }], usage: { total_tokens: 500 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}
export async function configure(workspace) {
  await workspace.updateSettings({ ai: { enabled: true, baseUrl: 'http://127.0.0.1:9955/v1', model: 'fixture-model', maxTokensPerJob: 120000, dailyTokenLimit: 300000, maxOutputTokens: 2000 } });
}
export async function confirmFirst(workspace) {
  const doc = workspace.documents.find(d => d.kind === 'chapter' && d.chapter === 1);
  await workspace.checksFor({ documentId: doc.id });
  return workspace.confirmRevision({ documentId: doc.id, sourceHash: doc.hash });
}
export async function waitJob(workspace, id) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const job = workspace.project.jobs.find(j => j.id === id);
    if (['completed', 'partial', 'failed', 'stale', 'cancelled', 'superseded'].includes(job.status) && !workspace.controllers.has(id)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('等待分析任务超时');
}
