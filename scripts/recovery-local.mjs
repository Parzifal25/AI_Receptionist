/** Disposable synthetic fixture only. Never a hosted backup or rollback tool. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function validateRecoveryTarget(container, source, target, env) {
  if (env.HALO_DISPOSABLE_DATABASE !== '1'
      || !/^halo-gates-disposable-[0-9]+$/.test(container ?? '')
      || source !== 'halo_check_integrations'
      || !/^halo_check_restore_[a-z0-9_]+$/.test(target ?? '')
      || source === target) {
    throw new Error('Recovery requires the task-owned disposable container, synthetic chat source, and a new halo_check_restore_<suffix> database.');
  }
}

export function runRecovery(container, source, target, env = process.env) {
  validateRecoveryTarget(container, source, target, env);
  const run = (args, input) => {
    const result = spawnSync('docker', ['exec', '-i', container, ...args], {
      input, maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    });
    if (result.error || result.status !== 0) {
      // Tool output could contain data. Never print it on failure.
      throw new Error(`Local recovery ${args[0]} failed; source left untouched, inspect isolated target before retry.`);
    }
    return result.stdout;
  };
  const sql = (db, query) => run(['psql', '-X', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atq'], query).toString().trim();
  if (sql(source, 'select public.halo_integration_target();') !== `${source}:synthetic-chat-20261013`) {
    throw new Error('Source is not the synthetic chat fixture');
  }
  // Check before CREATE; never drop, clean, replace, or write to the source.
  if (sql('postgres', `select count(*) from pg_database where datname='${target}';`) !== '0') {
    throw new Error('Restore target already exists; refusing to overwrite');
  }
  const tableList = sql(source, "select schemaname || '.' || tablename from pg_tables where schemaname in ('public','auth','storage') order by 1;").split('\n');
  const fingerprint = (db) => {
    const hashes = tableList.map((table) => {
      if (!/^[a-z_]+\.[a-z_0-9]+$/.test(table)) throw new Error('Unexpected fixture table');
      return sql(db, `select count(*) || ':' || md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' order by row_to_json(t)::text), '')) from ${table} t;`);
    });
    return createHash('sha256').update(hashes.join('\n')).digest('hex');
  };
  const sourceFingerprint = fingerprint(source);
  const started = Date.now();
  const backup = run(['pg_dump', '-U', 'postgres', '-d', source, '--format=custom']);
  const backupAt = new Date().toISOString();
  run(['createdb', '-U', 'postgres', '-T', 'template0', target]);
  run(['pg_restore', '-U', 'postgres', '-d', target, '--exit-on-error'], backup);
  if (fingerprint(target) !== sourceFingerprint) throw new Error('Restored row fingerprint mismatch');
  const assertions = sql(target, `
    begin read only;
    select count(*) = 0 from public.business_members m left join auth.users u on u.id=m.user_id where u.id is null;
    select count(*) = 0 from public.conversations c join public.agents a on a.id=c.agent_id
      join public.agent_versions v on v.id=c.agent_version_id
      where c.business_id<>a.business_id or c.business_id<>v.business_id or v.agent_id<>a.id;
    set local role authenticated;
    set local "request.jwt.claim.sub"='a1000000-0000-4000-8000-000000000001';
    select count(*) = 1 from public.businesses where slug='halo-integration-a';
    select count(*) = 0 from public.businesses where slug='halo-integration-b';
    select count(*) > 0 from public.conversations;
    select count(*) = 0 from public.conversations where business_id not in (select id from public.businesses);
    rollback;
  `).split('\n');
  if (assertions.length !== 6 || assertions.some((value) => value !== 't')) throw new Error('Post-restore identity or tenant assertion failed');
  return {
    evidence: 'disposable PostgreSQL restore; no real Auth, provider, hosting or application artifact rollback',
    at: new Date().toISOString(), backupAt, tables: tableList.length,
    backupBytes: backup.length, backupSha256: createHash('sha256').update(backup).digest('hex'),
    dataFingerprint: sourceFingerprint, identityAndTenantAssertions: assertions.length,
    recoveryDurationMs: Date.now() - started,
    dataLoss: 'zero fixture rows at snapshot; source quiescent; not a hosted RPO',
    sourceUntouched: true, target, status: 'PASS',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(runRecovery(...process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
