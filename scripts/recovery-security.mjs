/** Offline rehearsal helpers. These return SQL/text and never connect themselves. */
export const SECURITY_SNAPSHOT = `
with objects as (
 select 'table'::text kind, format('%I.%I',n.nspname,c.relname) name,
        pg_get_userbyid(c.relowner) owner, c.relacl acl, c.relowner owner_oid,
        case when c.relkind='S' then 'S' else 'r' end::"char" aclkind,
        c.oid, c.relkind::text subkind, c.relrowsecurity rls, c.relforcerowsecurity force_rls
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','supabase_migrations') and c.relkind in ('r','p','v','S')
 union all
 select 'function', format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),
        pg_get_userbyid(p.proowner),p.proacl,p.proowner,'f'::"char",p.oid,
        p.prosecdef::text,false,false
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
), entries as (
 select 'owner' category,kind,name,owner,subkind,rls::text,force_rls::text from objects
 union all
 select 'acl',o.kind,o.name,pg_get_userbyid(a.grantor),
        case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
        a.privilege_type,a.is_grantable::text
 from objects o cross join lateral aclexplode(coalesce(o.acl,acldefault(o.aclkind,o.owner_oid))) a
 union all
 select 'effective',o.kind,o.name,r.rolname,v.privilege,
        case when o.kind='function' then has_function_privilege(r.oid,o.oid,v.privilege)
             when o.subkind='S' then has_sequence_privilege(r.oid,o.oid,v.privilege)
             else has_table_privilege(r.oid,o.oid,v.privilege) end::text,''
 from objects o cross join pg_roles r
 cross join lateral unnest(case when o.kind='function' then array['EXECUTE']
   when o.subkind='S' then array['SELECT','USAGE','UPDATE']
   else array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] end) v(privilege)
 where r.rolname in ('anon','authenticated','service_role')
 union all
 select 'default',d.defaclobjtype::text,coalesce(n.nspname,'<global>'),pg_get_userbyid(d.defaclrole),
        case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
        a.privilege_type, a.is_grantable::text
 from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
 cross join lateral aclexplode(d.defaclacl) a
 where d.defaclobjtype in ('r','S','f') and (n.nspname='public' or d.defaclnamespace=0)
)
select coalesce(json_agg(row_to_json(e) order by category,kind,name,owner,subkind,rls,force_rls),'[]'::json)::text from entries e;`;

// Only the restoring creator's defaults, in the isolated rehearsal database.
// Never revoke actual platform-object grants or another creator's defaults.
// Public-schema grants ADD to global defaults: both levels must be neutralized.
export const NEUTRALIZE_RESTORE_DEFAULTS = `
do $$ declare x record; k text; scope text; begin
 if current_user <> 'postgres' then raise exception 'unexpected restore creator'; end if;
 for x in
   select distinct d.defaclnamespace, d.defaclobjtype, a.grantee
   from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
   where d.defaclrole='postgres'::regrole and d.defaclobjtype in ('r','S','f')
     and (d.defaclnamespace=0 or d.defaclnamespace='public'::regnamespace)
     and a.grantee <> 'postgres'::regrole
 loop
  k := case x.defaclobjtype when 'r' then 'TABLES' when 'S' then 'SEQUENCES' else 'FUNCTIONS' end;
  scope := case when x.defaclnamespace=0 then '' else ' IN SCHEMA public' end;
  execute 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres' || scope || ' REVOKE ALL ON ' || k || ' FROM ' ||
    case when x.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(x.grantee)) end;
 end loop;
end $$;
-- pg_dump ACL output assumes PostgreSQL hardwired initial privileges.
-- Preserve that baseline (PUBLIC EXECUTE for functions): dump ACL entries
-- explicitly revoke it for restricted functions. A stricter creation baseline
-- would lose intentional PUBLIC grants on source functions with NULL proacl.
alter default privileges for role postgres grant execute on functions to public;
`;

/** Emit the source creator's complete global/public default ACL after neutralization. */
export const RESTORE_SOURCE_DEFAULTS = `
select coalesce(string_agg(stmt,E'\n' order by stmt),'') from (
 select format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres%s GRANT %s ON %s TO %s%s;',
  case when d.defaclnamespace=0 then '' else ' IN SCHEMA public' end,
  a.privilege_type,
  case d.defaclobjtype when 'r' then 'TABLES' when 'S' then 'SEQUENCES' else 'FUNCTIONS' end,
  case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end,
  case when a.is_grantable then ' WITH GRANT OPTION' else '' end) stmt
 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
 where d.defaclrole='postgres'::regrole and d.defaclobjtype in ('r','S','f')
 and (d.defaclnamespace=0 or d.defaclnamespace='public'::regnamespace)
 and a.grantee <> 'postgres'::regrole
 union all
 select 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;'
 where not exists(select 1 from pg_default_acl where defaclrole='postgres'::regrole and defaclnamespace=0 and defaclobjtype='f')
) s;`;

/** Fail closed: neither missing evidence nor a successful pg_restore alone is acceptance. */
export function recoveryVerdict({ restoreStatus, source, restored }) {
  if (restoreStatus !== 0 || !Array.isArray(source) || !source.length || !Array.isArray(restored) || !restored.length) return { accepted: false, categories: ['execution_or_missing_evidence'] };
  if (['owner','acl','effective','default'].some((category) => !source.some((r) => r.category === category) || !restored.some((r) => r.category === category))) {
    return { accepted: false, categories: ['execution_or_missing_evidence'] };
  }
  const categories = ['owner','acl','effective','default'].filter((category) =>
    JSON.stringify(source.filter((r) => r.category === category)) !== JSON.stringify(restored.filter((r) => r.category === category)));
  return { accepted: categories.length === 0, categories };
}

// DDL definitions, independent of ownership/ACL and data fingerprints.
export const NORMALIZE_CHECK = `
create or replace function pg_temp.ws3_normalize_check(p_oid oid) returns text
language plpgsql as $$
declare rel regclass; definition text; result text;
begin
 select conrelid::regclass, pg_get_constraintdef(oid) into rel,definition from pg_constraint where oid=p_oid;
 execute format('create temp table ws3_check_model (like %s)',rel);
 execute 'alter table pg_temp.ws3_check_model add constraint ws3_check ' || definition;
 select pg_get_constraintdef(oid) into result from pg_constraint where conrelid='pg_temp.ws3_check_model'::regclass and conname='ws3_check';
 drop table pg_temp.ws3_check_model;
 return result;
end $$;
`;
export const SCHEMA_SNAPSHOT = `${NORMALIZE_CHECK}
with definitions(kind,name,definition) as (
 select 'column',format('%I.%I.%I',n.nspname,c.relname,a.attname),
   concat_ws('|',a.attnum::text,format_type(a.atttypid,a.atttypmod),a.attnotnull::text,
     a.attidentity::text,a.attgenerated::text,coalesce(pg_get_expr(d.adbin,d.adrelid),''))
 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
 left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
 where n.nspname in ('public','supabase_migrations') and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
 union all select 'constraint',format('%I.%I.%I',n.nspname,c.relname,x.conname),(case when x.contype='c' then pg_temp.ws3_normalize_check(x.oid) else pg_get_constraintdef(x.oid) end)||'|'||x.convalidated
 from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','supabase_migrations')
 union all select 'index',format('%I.%I',n.nspname,c.relname),pg_get_indexdef(c.oid)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','supabase_migrations') and c.relkind='i'
 union all select 'trigger',format('%I.%I.%I',n.nspname,c.relname,t.tgname),pg_get_triggerdef(t.oid)||'|'||t.tgenabled::text
 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
 union all select 'function',format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),pg_get_functiondef(p.oid)
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
 union all select 'policy',format('%I.%I.%I',n.nspname,c.relname,p.polname),
 concat_ws('|',p.polcmd::text,p.polpermissive::text,
  (select string_agg(case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end,',' order by case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end) from unnest(p.polroles) r),
  pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))
 from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
)
select coalesce(json_agg(row_to_json(d) order by kind,name,definition),'[]'::json)::text from definitions d;`;
