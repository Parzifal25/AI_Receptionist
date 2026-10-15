/** Production audit adapter against disposable PostgREST. No provider calls. */
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { requireDisposablePostgrest } from './disposable-database.mjs';
const target = requireDisposablePostgrest(process.env);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function jwt(role, sub) {
 const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
 const body = `${encode({alg:'HS256',typ:'JWT'})}.${encode({role,sub,exp:Math.floor(Date.now()/1000)+300})}`;
 return `${body}.${createHmac('sha256',target.jwtSecret).update(body).digest('base64url')}`;
}
const actor = '11111111-1111-1111-1111-111111111111', tenant = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const service = jwt('service_role'), member = jwt('authenticated',actor), foreign = jwt('authenticated','11111111-1111-1111-1111-111111111112');
let failOutcome = '';
const proxy = createServer(async (req,res)=>{
 try {
  const chunks=[]; for await(const chunk of req) chunks.push(chunk);
  const body=Buffer.concat(chunks);
  if(req.method==='POST' && failOutcome && JSON.parse(body.toString()).outcome===failOutcome){res.writeHead(503);res.end('{}');return;}
  const headers={...req.headers};delete headers.host;delete headers['content-length'];
  const response=await fetch(target.url+(req.url??'/').replace(/^\/rest\/v1/,''),{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch {res.writeHead(500);res.end('{}');}
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const address=proxy.address();
Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${address.port}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:jwt('anon'),SUPABASE_SERVICE_ROLE_KEY:service,NEXT_PUBLIC_APP_URL:'http://localhost:3000',HALO_OUTBOUND_ENABLED:'false',MESSAGING_PROVIDER:'log'});
const {securityAuditStore:store}=await import(root+'/packages/tenancy/security-audit-store.ts');
const {withTelemetryContext}=await import(root+'/packages/platform/telemetry.ts');
const {withSecurityAudit,bindSecurityIdentity,finishSecurityAudit}=await import(root+'/packages/platform/security-audit.ts');
let assertions=0;
function assert(condition,label){if(!condition)throw new Error(label);assertions++;console.log('ok '+label);}
const read=async(token,id)=>{
 const response=await fetch(`${target.url}/audit_logs?correlation_id=eq.${id}&select=*`,{headers:{Authorization:`Bearer ${token}`}});
 if(!response.ok)throw new Error('audit query unavailable');return response.json();
};
try {
 const correlation=randomUUID();
 await withTelemetryContext(()=>withSecurityAudit(store,true,async()=>{await bindSecurityIdentity({businessId:tenant,actorId:actor});await finishSecurityAudit(200);}),correlation);
 const rows=await read(member,correlation);
 assert(rows.length===2 && rows.map(r=>r.outcome).sort().join(',')==='attempted,succeeded','actual adapter persisted attempt and success over HTTP');
 assert(rows.every(r=>r.business_id===tenant && r.actor_id===actor && r.created_at && r.correlation_id===correlation),'trusted identity, timestamp and correlation survived HTTP serialization');
 assert((await read(foreign,correlation)).length===0,'foreign member cannot read audit through PostgREST');
 const deniedId=randomUUID();
 await withTelemetryContext(()=>withSecurityAudit(store,false,async()=>{await bindSecurityIdentity({businessId:tenant,actorId:actor});await finishSecurityAudit(403);}),deniedId);
 const denied=await read(member,deniedId);
 assert(denied.some(r=>r.outcome==='denied'&&r.reason==='forbidden'&&r.actor_id===actor),'authorized denial persisted through the production adapter');
 const insert=await fetch(target.url+'/audit_logs',{method:'POST',headers:{Authorization:`Bearer ${member}`,'Content-Type':'application/json'},body:JSON.stringify(rows[0])});
 assert(insert.status===403,'client cannot fabricate audit records through HTTP');
 const update=await fetch(`${target.url}/audit_logs?id=eq.${rows[0].id}`,{method:'PATCH',headers:{Authorization:`Bearer ${service}`,'Content-Type':'application/json'},body:'{"reason":"completed"}'});
 assert(update.status===403,'service cannot rewrite audit history through HTTP');
 let effects=0;failOutcome='attempted';
 try {await withSecurityAudit(store,true,async()=>{await bindSecurityIdentity({businessId:tenant,actorId:actor});effects++;});}catch{}
 assert(effects===0,'HTTP pre-audit outage prevented protected side effect');
 failOutcome='succeeded';const postId=randomUUID();
 const result=await withTelemetryContext(()=>withSecurityAudit(store,true,async()=>{await bindSecurityIdentity({businessId:tenant,actorId:actor});effects++;await finishSecurityAudit(200);return 'completed';}),postId);
 assert(result==='completed'&&effects===1&&(await read(member,postId)).length===1,'HTTP terminal audit outage retained completed result and durable attempt');
 failOutcome='';
 console.log(`check-security-audit-http: ${assertions} assertions passed`);
}finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
