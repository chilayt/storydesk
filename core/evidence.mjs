import {AppError,hash,decode} from './io.mjs';
// Formatting tolerance never performs spelling correction, punctuation deletion, or semantic/fuzzy matching.
export function sourceSpans(text, base = 0) {
  const spans = [];
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    let offset = 0;
    while (offset < line[0].length) {
      let end = Math.min(line[0].length, offset + 1200);
      if (end < line[0].length && /[\uD800-\uDBFF]/.test(line[0][end-1])) end--;
      const original = line[0].slice(offset,end), leading=original.length-original.trimStart().length, value=original.trim();
      if (value) { const start=base+line.index+offset+leading;spans.push({id:`p${spans.length+1}`,start,end:start+value.length,text:value}); }
      offset=end;
    }
  }
  return spans;
}
function normalized(text) {
  let value='';const positions=[];
  for(let i=0;i<text.length;i++){
    let c=text[i];if(/[\s\u200b\ufeff]/u.test(c))continue;
    if(c==='“'||c==='”')c='"';if(c==='‘'||c==='’')c="'";
    value+=c;positions.push(i);
  }
  return {value,positions};
}
function matches(text,quote,start,end){
  const exact=[];let at=text.indexOf(quote,start);
  while(quote&&at>=0&&at+quote.length<=end&&exact.length<3){exact.push({start:at,end:at+quote.length});at=text.indexOf(quote,at+1);}
  if(exact.length)return {method:'exact',matches:exact};
  const needle=normalized(quote).value,hay=normalized(text.slice(start,end));const result=[];
  if(needle.length<2)return {method:'formatting',matches:result};
  at=hay.value.indexOf(needle);
  while(at>=0&&result.length<3){const a=start+hay.positions[at],b=start+hay.positions[at+needle.length-1]+1;result.push({start:a,end:b});at=hay.value.indexOf(needle,at+1);}
  return {method:'formatting',matches:result};
}
export function locateEvidence(text,{quote='',spanId='',start=0,end=text.length,spans=sourceSpans(text.slice(start,end),start)}={}){
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>text.length||end<start)return {status:'invalid_range',reason:'确认范围无效',evidence:'',start:null,end:null};
  const supplied=typeof quote==='string'?quote.trim():'';
  let span=null;
  if(spanId){span=spans.find(s=>s.id===spanId&&s.start>=start&&s.end<=end);if(!span)return {status:'invalid_span',reason:'模型引用的段落编号不在本次源文中',evidence:'',reported_evidence:supplied,spanId,start:null,end:null};}
  if(!supplied){
    if(span)return {status:'matched',method:'source_span',evidence:span.text,start:span.start,end:span.end,spanId,duplicate:false};
    return {status:'missing',reason:'模型没有提供原句或有效段落编号',evidence:'',reported_evidence:supplied,start:null,end:null};
  }
  const found=matches(text,supplied,span?.start??start,span?.end??end);
  if(found.matches.length){const hit=found.matches[0];return {status:'matched',method:found.method,...hit,evidence:text.slice(hit.start,hit.end),reported_evidence:supplied,spanId:span?.id||null,duplicate:found.matches.length>1};}
  const outside=matches(text,supplied,0,text.length).matches.length>0;
  return {status:outside?'out_of_scope':'unmatched',reason:outside?'引用只在本次确认范围或指定段落之外出现':'模型引用无法在已确认源文中定位，不能将改写、拼接或补写当成原句',evidence:'',reported_evidence:supplied,spanId:spanId||null,start:null,end:null};
}
export function evidenceSummary(events){
  const facts=events.flatMap(e=>e.facts);return {facts:facts.length,exact:facts.filter(f=>f.evidence_match?.method==='exact').length,formatting:facts.filter(f=>f.evidence_match?.method==='formatting').length,sourceSpans:facts.filter(f=>f.evidence_match?.method==='source_span').length,unlocated:facts.filter(f=>f.status==='pending'&&f.evidence_match&&f.evidence_match.status!=='matched').length,blockedEvents:events.filter(e=>e.facts.some(f=>f.status==='pending'&&f.evidence_match&&f.evidence_match.status!=='matched')).length};
}
export async function verifyFactEvidence(store,document,fact,replacement){
  const bytes=await store.read(document.path);if(!bytes||hash(bytes)!==fact.source_hash)throw new AppError('CONFLICT','证据源稿已经改变，请针对新版本重新确认和分析');
  const text=decode(bytes).text,quote=replacement===undefined?fact.evidence:replacement;
  if(typeof quote!=='string'||quote.trim().length<2||quote.length>3000)throw new AppError('EVIDENCE','请先从已确认稿件中补选真实连续原句；未定位的模型引文不能直接接受',{stage:'evidence',reportedEvidence:fact.reported_evidence||''});
  const range=fact.confirmed_range||{start:0,end:text.length};
  if(fact.evidence_match?.status==='matched'&&(replacement===undefined||replacement===fact.evidence)&&Number.isInteger(fact.start)&&Number.isInteger(fact.end)&&fact.start>=range.start&&fact.end<=range.end&&text.slice(fact.start,fact.end)===quote)return {...fact};
  const located=locateEvidence(text,{quote,start:range.start,end:range.end});
  if(located.status!=='matched')throw new AppError('EVIDENCE',located.reason,{stage:'evidence',status:located.status});
  if(located.duplicate&&fact.evidence_match?.status!=='matched')throw new AppError('EVIDENCE','补选原句在确认范围中多次出现，请补充前后文以唯一定位',{stage:'evidence',status:'ambiguous'});
  return {...fact,evidence:located.evidence,start:located.start,end:located.end,evidence_match:{status:'matched',method:located.method,author_repaired:fact.evidence_match?.status!=='matched'||replacement!==undefined}};
}
