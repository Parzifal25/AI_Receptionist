#!/usr/bin/env node
/** WS3: own cached-image PostgreSQL + PostgREST, network none, no host ports.
 * No target arguments/env URLs accepted. Mount only listed source/test assets,
 * never env files or Git history. Run destructive gates ONLY in the newly
 * created database. A sidecar shares that isolated network namespace.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const suffix = randomBytes(5).toString('hex');
const pg = `halo_check_ws3_pg_${suffix}`;
const rest = `halo_check_ws3_rest_${suffix}`;
const db = `halo_check_ws3_${suffix}`;
const url = `postgresql://postgres@127.0.0.1:5432/${db}`;
const jwt = randomBytes(32).toString('hex'); // synthetic fixture only, never printed
const owned = [];
const docker = (args, input) => spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:64*1024*1024});
function requireOk(result, label) {
 if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}); ${result.stderr ?? ''}`);
 return result.stdout;
}
const exec = (args, input) => docker(['exec','-i',pg,...args],input);
function gate(label, args) {
 const r=exec(args); process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
 requireOk(r,label); console.log(`PASS ${label}`);
}
try {
 const args=['run','-d','--name',pg,'--network','none','--pull=never',
  '-e',`POSTGRES_DB=${db}`,'-e','POSTGRES_HOST_AUTH_METHOD=trust'];
 for(const name of ['node_modules','packages','src','tests','scripts','supabase','infrastructure','docs','.github',
   'package.json','package-lock.json','tsconfig.json','vitest.config.ts','.env.example','AGENTS.md']) {
  if(existsSync(join(root,name))) args.push('-v',`${join(root,name)}:/workspace/${name}:ro`);
 }
 args.push('-v',`${process.execPath}:/usr/local/bin/node:ro`,'-w','/workspace','pgvector/pgvector:pg16');
 owned.push(pg); requireOk(docker(args),'create isolated PostgreSQL');
 const net=JSON.parse(requireOk(docker(['inspect','-f','{{json .NetworkSettings.Networks}}',pg]),'inspect network'));
 const ports=requireOk(docker(['inspect','-f','{{json .HostConfig.PortBindings}}',pg]),'inspect ports').trim();
 if(Object.keys(net).join()!=='none'||!['{}','null'].includes(ports)) throw new Error('database isolation check failed');
 let ready=false;
 for(let i=0;i<120;i++) {
  if(exec(['pg_isready','-h','127.0.0.1','-U','postgres','-d',db]).status===0){ready=true;break;}
  await new Promise(r=>setTimeout(r,500));
 }
 if(!ready) throw new Error('own database not ready');
 const identity=requireOk(exec(['psql','-X','-h','127.0.0.1','-U','postgres','-d',db,'-Atc',`select current_database()='${db}';`]),'database provenance').trim();
 if(identity!=='t') throw new Error('database provenance mismatch');
 console.log('PASS isolated database identity verified');
 gate('platform stubs', ['psql','-X','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-f','/workspace/infrastructure/ci/supabase-stubs.sql']);
 const nodeEnv=['env','HALO_DISPOSABLE_DATABASE=1',`HALO_DISPOSABLE_DB_URL=${url}`,
  'HALO_OUTBOUND_ENABLED=false','MESSAGING_PROVIDER=log','EMBEDDING_PROVIDER=none',
  'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:1','NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-anon',
  'SUPABASE_SERVICE_ROLE_KEY=synthetic-service','NEXT_PUBLIC_APP_URL=http://localhost:3000'];
 gate('check:migrations', [...nodeEnv,'node','scripts/check-migrations.mjs',url]);
 gate('check:rls', [...nodeEnv,'node','scripts/check-rls.mjs',url]);
 owned.push(rest);
 requireOk(docker(['run','-d','--name',rest,'--network',`container:${pg}`,'--pull=never',
  '-e',`PGRST_DB_URI=${url}`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon',
  '-e',`PGRST_JWT_SECRET=${jwt}`,'public.ecr.aws/supabase/postgrest:v16.4']),'create isolated PostgREST');
 const mode=requireOk(docker(['inspect','-f','{{.HostConfig.NetworkMode}}',rest]),'inspect sidecar').trim();
 if(!mode.startsWith('container:')) throw new Error('sidecar namespace check failed');
 ready=false;
 for(let i=0;i<120;i++) {
  if(exec(['node','-e',"fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).status===0){ready=true;break;}
  await new Promise(r=>setTimeout(r,500));
 }
 if(!ready) throw new Error('isolated PostgREST not ready');
 // Materialize the same config in the container's writable overlay, replacing
 // only its CommonJS __dirname macro for Vite's no-bundle config loader.
 requireOk(exec(['sh','-c','cat > /workspace/vitest.offline.config.mjs'],
  readFileSync(join(root,'vitest.config.ts'),'utf8').replaceAll('__dirname',JSON.stringify('/workspace'))),'write isolated config');
 gate('opt-in production governance and PostgREST isolation', [...nodeEnv,
  'HALO_DISPOSABLE_POSTGREST_URL=http://127.0.0.1:3000',`HALO_DISPOSABLE_JWT_SECRET=${jwt}`,
  'node','node_modules/vitest/vitest.mjs','run','--config','/workspace/vitest.offline.config.mjs','--configLoader','runner','--no-cache','--maxWorkers=1',
  'tests/integration/knowledge-backfill-db.test.ts','tests/integration/knowledge-governance-db.test.ts','tests/integration/tenant-isolation-postgrest.test.ts']);
} catch(error) {
 console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1;
} finally {
 for(const name of owned.reverse()) {
  const result=docker(['rm','-f',name]);
  if(result.status!==0){console.error('own-container cleanup failed');process.exitCode=1;}
 }
}
