#!/usr/bin/env node
/** Offline file/link/count check; no network, database or environment loading. */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const docs = ['WORKSTREAM_3_REPORT.md','MIGRATION_DEPENDENCY_MAP.md','HOSTED_TARGET_PREFLIGHT.md',
 'KNOWLEDGE_ROLLOUT_RUNBOOK.md','DATABASE_RECOVERY_RUNBOOK.md','WS3_OWNER_ACTIONS.md','HOSTED_MIGRATION_RUNBOOK.md'];
const failures=[];
for(const file of docs) {
 const text=readFileSync(join(root,'docs',file),'utf8');
 for(const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
  if(!match[1].includes('://') && !existsSync(join(root,'docs',match[1]))) failures.push(`${file}: missing ${match[1]}`);
 }
}
const migrations=readdirSync(join(root,'supabase/migrations')).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
const map=readFileSync(join(root,'docs/MIGRATION_DEPENDENCY_MAP.md'),'utf8');
for(const [index,file] of migrations.entries()) {
 if(Number(file.slice(0,4))!==index+1) failures.push('migration sequence is not contiguous');
 if(map.split(`| [${file}]`).length!==2) failures.push(`migration map row missing/duplicated: ${file}`);
}
const owners=readFileSync(join(root,'docs/WS3_OWNER_ACTIONS.md'),'utf8');
const ids=[...owners.matchAll(/^\| (R\d+|D\d+) —/gm)].map(m=>m[1]);
const declared=owners.match(/^OWNER DECISION IDS: (.+)$/m)?.[1].split(',').map(x=>x.trim()).sort();
if(!declared || declared.join()!==[...new Set(ids)].sort().join() || ids.length!==new Set(ids).size) failures.push('owner ID declaration/table mismatch');
const preflight=readFileSync(join(root,'docs/HOSTED_TARGET_PREFLIGHT.md'),'utf8');
const gates=[...preflight.matchAll(/^\| T(\d+) /gm)].map(m=>Number(m[1]));
if(gates.join()!==Array.from({length:10},(_,i)=>i+1).join()) failures.push('expected ten ordered target evidence groups');
const worksheet=JSON.parse(readFileSync(join(root,'infrastructure/hosted/preflight-evidence.example.json'),'utf8'));
if(worksheet.groups.map(r=>r.id).join()!==gates.map(i=>`T${i}`).join()
 || worksheet.targetId!=='' || worksheet.readAuthorizationRecord!==''
 || worksheet.groups.some(r=>r.outcome!=='NOT VERIFIED'||r.evidenceRef!==''||r.reviewedBy!=='')) failures.push('template must match T1–T10 with all evidence uncollected');
if(failures.length) { console.error(failures.join('\n'));process.exitCode=1; }
else console.log(`PASS: ${migrations.length} ordered migration rows, ${docs.length} linked rollout documents, ${ids.length} distinct owner IDs, ${gates.length} target evidence groups`);
