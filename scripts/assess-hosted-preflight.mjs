#!/usr/bin/env node
/** Read saved operator attestations only. No SQL, network, env-file loading or writes.
 * GO means documented worksheet checks passed; never grants execution permission.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const GROUPS = ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10'];
export function assessPreflight(input) {
 const rows=Array.isArray(input?.groups)?input.groups:[];
 const unexpected=rows.some(r=>!GROUPS.includes(r?.id)) || new Set(rows.map(r=>r?.id)).size!==rows.length;
 const targetVerified=typeof input?.targetId==='string' && Boolean(input.targetId.trim())
   && typeof input?.readAuthorizationRecord==='string' && Boolean(input.readAuthorizationRecord.trim());
 const groups=GROUPS.map(id=>{
  const row=rows.find(r=>r?.id===id);
  let outcome='NOT VERIFIED';
  if(row && !['GO','STOP','NOT VERIFIED'].includes(row.outcome)) outcome='STOP';
  else if(row?.outcome==='STOP') outcome='STOP';
  else if(row?.outcome==='GO' && targetVerified
    && typeof row.evidenceRef==='string' && row.evidenceRef.trim()
    && typeof row.reviewedBy==='string' && row.reviewedBy.trim()) outcome='GO';
  return {id,outcome};
 });
 const aggregate=rows=>rows.some(r=>r.outcome==='STOP')?'STOP':rows.every(r=>r.outcome==='GO')?'GO':'NOT VERIFIED';
 return {overall:unexpected?'STOP':aggregate(groups),preMigration:unexpected?'STOP':aggregate(groups.slice(0,9)),
   groups,unexpectedGroups:unexpected,executionAuthorized:false};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 let input; let parsed=false;
 try {input=JSON.parse(readFileSync(process.argv[2],'utf8'));parsed=true;}
 catch { console.log(JSON.stringify(assessPreflight(undefined)));process.exitCode=2; }
 if(parsed) {
  const result=assessPreflight(input);console.log(JSON.stringify(result,null,2));
  process.exitCode=result.overall==='GO'?0:result.overall==='STOP'?1:2;
 }
}
