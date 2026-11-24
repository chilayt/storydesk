import fs from 'node:fs/promises';import path from 'node:path';
import {AppError,hash,atomicJson} from './io.mjs';
function relative(job){if(!/^job_[\w-]+$/.test(job.id))throw new AppError('VALIDATION','任务ID无效');return `_创作管理/任务/${job.id}.raw.json`;}
export async function loadExtraction(w,job,approval){
  if(job.forceAnalysis||!job.rawResultHash)return null;
  const bytes=await w.store.read(relative(job));
  if(!bytes||hash(bytes)!==job.rawResultHash)throw new AppError('RAW_CONFLICT','已保存的分析结果缺失或被外部修改。可保留文件后点击“重新分析”；未写入正式资料。',{stage:'local_result'});
  let data;try{data=JSON.parse(bytes.toString('utf8'));}catch{throw new AppError('RAW_CONFLICT','已保存的分析结果格式损坏，请重新分析',{stage:'local_result'});}
  if(data.schema_version!==1||data.jobId!==job.id||data.sourceHash!==job.sourceHash||data.approvalId!==approval.id||data.start!==approval.start||data.end!==approval.end||!Array.isArray(data.parts))throw new AppError('RAW_CONFLICT','已保存分析结果的作品、版本或确认范围不一致，请重新分析',{stage:'local_result'});
  for(const p of data.parts)if(!Number.isInteger(p.start)||!Number.isInteger(p.end)||p.start<data.start||p.end>data.end||p.end<=p.start||!Array.isArray(p.events))throw new AppError('RAW_CONFLICT','已保存分析结果的分段范围无效',{stage:'local_result'});
  return data;
}
export async function saveExtraction(w,job,data,{fresh=false}={}){
  await w.exclusive(async()=>{
    const name=relative(job),current=await w.store.read(name),live=w.project.jobs.find(j=>j.id===job.id);
    if(current&&fresh){const archive=await w.store.resolve(`_创作管理/任务/原始历史/${job.id}_${hash(current)}.json`);await fs.mkdir(path.dirname(archive),{recursive:true});await fs.writeFile(archive,current,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});}
    else if(current&&hash(current)!==live.rawResultHash)throw new AppError('RAW_CONFLICT','暂存分析结果已改变，保留现场并停止覆盖',{stage:'local_result'});
    const bytes=Buffer.from(JSON.stringify(data,null,2));await atomicJson(await w.store.resolve(name),data);
    live.rawResultHash=hash(bytes);live.rawResultAvailable=true;live.forceAnalysis=false;if(data.usage&&data.usage.total_tokens>=(live.usage?.total_tokens||0))live.usage=structuredClone(data.usage);await w.persist();
  });
}
