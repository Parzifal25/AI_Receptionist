import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const migrations = path.resolve(__dirname, "../../supabase/migrations");
const historical = readFileSync(path.join(migrations, "0033_knowledge_governance.sql"), "utf8");
const correction = readFileSync(path.join(migrations, "0035_knowledge_backfill_source_ref_validation.sql"), "utf8").replace(/--.*$/gm, "").trim();
const start = historical.indexOf("create or replace function public.knowledge_backfill_legacy(");
const original = historical.slice(start, historical.indexOf("\n$$;", start) + 4);
describe("K1 additive migration", () => {
  it("changes only the shared source_ref validation branch of the existing function", () => {
    expect(correction).toBe(original.replace("    elsif d.source_type <> 'manual'", "    elsif char_length(d.source_ref) > 500 then\n      item_kind := 'document'; item_id := d.id; action := 'quarantined_source_ref_too_long'; return next;\n    elsif d.source_type <> 'manual'"));
  });
  it("keeps the signature, SECURITY DEFINER, fixed path and dry-run default", () => {
    expect(correction).toContain("p_business_id uuid, p_apply boolean default false");
    expect(correction).toContain("security definer\nset search_path = public");
    expect(correction.indexOf("char_length(d.source_ref) > 500")).toBeLessThan(correction.indexOf("if p_apply then"));
    expect(correction).not.toMatch(/\b(?:grant|revoke|alter|drop|truncate)\b/i);
  });
});
