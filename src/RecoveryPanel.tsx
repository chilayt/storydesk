import React, { useEffect, useState } from 'react';
import type { AppContext } from './domain';
import { Modal } from './components';
export function RecoveryPanel({ctx,record,onClose}:{ctx:AppContext;record:any;onClose:()=>void}){
  const [index,setIndex]=useState(0);const [diff,setDiff]=useState<any>(null);const [ack,setAck]=useState(false);
  useEffect(()=>{ctx.call('recoveryDiff',{id:record.id,index}).then(setDiff).catch(e=>ctx.notify(e.message,true));},[index]);
  return <Modal title="比较未完成批次" subtitle="第三个版本不会被自动覆盖。快照和当前文件都保留。" onClose={onClose} wide><label>涉及文件<select value={index} onChange={e=>setIndex(Number(e.target.value))}>{record.files.map((f:any,i:number)=><option value={i} key={f.path}>{f.path}</option>)}</select></label>{diff&&<div className="recovery-columns"><div><h4>写入前</h4><pre>{diff.before}</pre></div><div><h4>拟写入</h4><pre>{diff.after}</pre></div><div><h4>当前文件</h4><pre>{diff.current}</pre></div></div>}<label className="check-label"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>已核对：保留外部版本，撤回本批次已写入但没有外部变化的文件</label><div className="modal-footer"><button onClick={onClose}>继续保留现场</button><button disabled={!ack} onClick={async()=>{const r=await ctx.act(()=>ctx.call('abandonRecovery',{id:record.id}),'已保留外部版本并撤回未完成批次');if(r)onClose();}}>按上述规则结束恢复</button></div></Modal>;
}
