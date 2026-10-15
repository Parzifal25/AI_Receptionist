import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { requireDisposableDatabase } from "../../scripts/disposable-database.mjs";

// Enabled only by the task-owned, network-none database harness. Each test's
// complete synthetic fixture and any fault-injection DDL roll back together.
const enabled = process.env.HALO_DISPOSABLE_DATABASE === "1" && Boolean(process.env.HALO_DISPOSABLE_DB_URL);
const url = enabled ? requireDisposableDatabase(undefined, process.env) : "";
const a = randomUUID(), b = randomUUID(), collection = randomUUID();
function run(body: string, role = "service_role"): string {
  const seed = `insert into public.businesses(id,name,slug) values ('${a}','K1 A','${a}'),('${b}','K1 B','${b}');
    insert into public.knowledge_collections(id,business_id,name) values('${collection}','${a}','K1 collection');
    insert into public.knowledge_documents(business_id,title,content,source_type,source_ref,collection_id,created_at)
      select '${a}', 'ref'||n, 'Synthetic K1 content', 'url', repeat('x',n), '${collection}', '2026-01-01'::timestamptz+n*interval '1 second' from (values(499),(500),(501)) v(n);
    insert into public.knowledge_documents(business_id,title,content,source_type,source_ref) values('${b}','Other tenant','Synthetic B','url',repeat('b',500));
    insert into public.faqs(business_id,question,answer) values('${a}','Synthetic question','Synthetic answer');`;
  return execFileSync("psql", [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    input: `begin;${seed}set local role ${role};${body}rollback;`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
const apply = `select count(*) from public.knowledge_backfill_legacy('${a}',true);`;
describe.skipIf(!enabled)("K1 corrected backfill (disposable PostgreSQL)", () => {
  it("accepts 499/500 and quarantines 501 identically in dry-run and apply", () => {
    const result = run(`select json_agg(row_to_json(s) order by s.n) from (
      select char_length(d.source_ref) n,x.action from public.knowledge_backfill_legacy('${a}',false) x
      join public.knowledge_documents d on d.id=x.item_id) s;
      select json_agg(row_to_json(s) order by s.n) from (
      select char_length(d.source_ref) n,x.action from public.knowledge_backfill_legacy('${a}',true) x
      join public.knowledge_documents d on d.id=x.item_id) s;`).split("\n").map((line) => JSON.parse(line));
    expect(result[0]).toEqual([{ n: 499, action: "would_create_draft" },{ n: 500, action: "would_create_draft" },{ n: 501, action: "quarantined_source_ref_too_long" }]);
    expect(result[1]).toEqual([{ n: 499, action: "draft_created_needs_indexing" },{ n: 500, action: "draft_created_needs_indexing" },{ n: 501, action: "quarantined_source_ref_too_long" }]);
  });
  it("dry-run writes nothing, then valid records progress without touching provenance, scope or another tenant", () => {
    expect(run(`select count(*) from public.knowledge_backfill_legacy('${a}',false);
      select count(*) from public.knowledge_document_revisions where business_id='${a}';${apply}
      select count(*) from public.knowledge_document_revisions r join public.knowledge_documents d on d.id=r.document_id
       where r.business_id='${a}' and d.business_id=r.business_id and r.source_ref=d.source_ref and r.source_type=d.source_type
       and d.collection_id='${collection}' and r.state='draft' and r.index_status='pending' and r.origin='legacy_backfill';
      select count(*) from public.knowledge_document_revisions where business_id='${b}';
      select count(*) from public.faq_revisions where business_id='${a}' and state='pending_review';
      select count(*) from public.knowledge_documents where business_id='${a}' and char_length(source_ref)=501 and published_revision_id is null;`)).toBe("4\n0\n4\n2\n0\n1\n1");
  });
  it("retries only report the quarantined item; revisions and approval states remain unchanged", () => {
    expect(run(`${apply}select string_agg(action,',') from public.knowledge_backfill_legacy('${a}',true);
      select count(*) from public.knowledge_document_revisions where business_id='${a}' and state='draft';`)).toBe("4\nquarantined_source_ref_too_long\n2");
  });
  it("a mid-call injected failure rolls back all work before a successful retry", () => {
    expect(run(`reset role;
      create function pg_temp.ws3_k1_fault() returns trigger language plpgsql as $$ begin
       if new.title='ref500' then raise exception 'synthetic K1 fault'; end if; return new; end $$;
      create trigger ws3_k1_fault before insert on public.knowledge_document_revisions for each row execute function pg_temp.ws3_k1_fault();
      do $$ begin begin perform * from public.knowledge_backfill_legacy('${a}',true);
       raise exception 'expected injected fault' using errcode='XX000';
       exception when sqlstate 'P0001' then null; end; end $$;
      select count(*) from public.knowledge_document_revisions where business_id='${a}';
      select count(*) from public.faq_revisions where business_id='${a}';
      select count(*) from public.knowledge_documents where business_id='${a}' and status='ready';
      drop trigger ws3_k1_fault on public.knowledge_document_revisions;
      set local role service_role;${apply}`)).toBe("0\n0\n3\n4");
  });
  it("does not replace or revoke an already approved revision during backfill replay", () => {
    const owner=randomUUID();
    expect(run(`${apply}reset role;
      insert into auth.users(id,email) values('${owner}','k1-owner@synthetic.invalid');
      insert into public.business_members(business_id,user_id,role) values('${a}','${owner}','owner');
      set local request.jwt.claim.sub='${owner}';
      do $$ declare doc uuid; rev uuid; begin
        select d.id,r.id into doc,rev from public.knowledge_documents d join public.knowledge_document_revisions r on r.document_id=d.id
          where d.business_id='${a}' and d.title='ref499';
        perform public.knowledge_begin_indexing('${a}',doc,rev);
        insert into public.knowledge_chunks(document_id,business_id,revision_id,content,chunk_index) values(doc,'${a}',rev,'Synthetic approved chunk',0);
        perform public.knowledge_finish_indexing('${a}',doc,rev,1);
        perform public.knowledge_submit_revision(rev);
        perform public.knowledge_review_revision(rev,true);
      end $$;
      set local role service_role;
      select count(*) from public.knowledge_backfill_legacy('${a}',true);
      select count(*) from public.knowledge_document_revisions where business_id='${a}' and state='approved';
      select count(*) from public.knowledge_documents d join public.knowledge_document_revisions r on r.id=d.published_revision_id
        where d.business_id='${a}' and r.business_id=d.business_id and r.state='approved' and d.title='ref499';
      select count(*) from public.knowledge_document_revisions where business_id='${a}';`)).toBe("4\n1\n1\n1\n2");
  });
  it("uses character count rather than byte length and never truncates a Unicode source", () => {
    expect(run(`reset role;update public.knowledge_documents set source_ref=repeat('అ',500) where business_id='${a}' and title='ref501';
      set local role service_role;${apply}
      select count(*) from public.knowledge_document_revisions where business_id='${a}' and char_length(source_ref)=500 and octet_length(source_ref)=1500;`)).toBe("4\n1");
  });
  it("keeps effective execution service-role only", () => {
    expect(run(`select has_function_privilege('anon','public.knowledge_backfill_legacy(uuid,boolean)','execute')||','||
      has_function_privilege('authenticated','public.knowledge_backfill_legacy(uuid,boolean)','execute')||','||
      has_function_privilege('service_role','public.knowledge_backfill_legacy(uuid,boolean)','execute');`)).toBe("false,false,true");
    expect(() => run(apply,"authenticated")).toThrow();
  });
});
