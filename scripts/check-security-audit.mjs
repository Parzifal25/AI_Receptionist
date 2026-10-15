/** Synthetic concurrent persistence checks; accepts only an explicitly disposable DB. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { requireDisposableDatabase } from "./disposable-database.mjs";
const url = requireDisposableDatabase(process.argv[2], process.env);
const query = sql => execFileSync("psql", [url,"-X","-qAt","-v","ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();
const a = randomUUID(), b = randomUUID(), actorA = randomUUID(), actorB = randomUUID();
query(`insert into auth.users (id) values ('${actorA}'),('${actorB}');
insert into businesses(id,name,slug) values ('${a}','Synthetic audit A','${a}'),('${b}','Synthetic audit B','${b}');
insert into business_members(business_id,user_id,role) values ('${a}','${actorA}','owner'),('${b}','${actorB}','owner');`);
const ids = Array.from({length:40},()=>randomUUID());
const exec = promisify(execFile);
await Promise.all(ids.map((id,i)=>exec("psql",[url,"-X","-qAt","-v","ON_ERROR_STOP=1","-c",`begin; set local role service_role;
insert into audit_logs(operation_id,business_id,actor_id,action,outcome,reason,correlation_id)
values('${id}','${i%2?a:b}','${i%2?actorA:actorB}','api_access','attempted','authorized','${id}'); commit;`])));
function assert(sql, expected, label) {
 const result = query(sql); if(result!==expected) throw new Error(label+": assertion failed"); console.log("ok "+label);
}
assert(`select count(*) from audit_logs where business_id in ('${a}','${b}');`,'40','40 concurrent durable appends, no lost writes');
assert(`select count(*) from audit_logs where business_id in ('${a}','${b}') and
 ((business_id='${a}' and actor_id <> '${actorA}') or (business_id='${b}' and actor_id <> '${actorB}') or operation_id <> correlation_id);`,'0','no actor, tenant or correlation misattribution');
assert(`begin; select set_config('request.jwt.claim.sub','${actorA}',true) is not null; set local role authenticated;
select count(*) from audit_logs where business_id='${b}'; commit;`,'t\n0','real-role cross-tenant read isolation');
assert(`begin; select set_config('request.jwt.claim.sub','${actorA}',true) is not null; set local role authenticated;
select count(*) from audit_logs where business_id='${a}'; commit;`,'t\n20','real-role own-tenant visibility');
assert(`select count(*) from audit_logs where business_id in ('${a}','${b}') and created_at is not null;`,'40','server timestamps persisted');
console.log('check-security-audit: 5 assertions passed');
