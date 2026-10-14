import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFaq, updateFaq } from "@/features/faqs/actions";

const fake = vi.hoisted(() => ({ writes: [] as Array<Record<string, unknown>>, filters: [] as Array<[string, unknown]> }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@halo/tenancy/auth", () => ({ requireBusiness: async () => ({ businessId: "tenant-a", userId: "synthetic", role: "owner" }) }));
vi.mock("@halo/tenancy/supabase/server", () => ({ createSupabaseServerClient: async () => ({ from: () => {
  const query = {
    insert: async (row: Record<string, unknown>) => { fake.writes.push(row); return { error: null }; },
    update: (row: Record<string, unknown>) => { fake.writes.push(row); return query; },
    eq: (key: string, value: unknown) => { fake.filters.push([key, value]); return query; },
    then: (resolve: (result: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
  };
  return query;
} }) }));

beforeEach(() => { fake.writes.length = 0; fake.filters.length = 0; });
function form() {
  const data = new FormData();
  data.set("question", "Synthetic question?"); data.set("answer", "Synthetic answer"); data.set("category", "Test");
  data.set("id", "00000000-0000-4000-8000-000000000001"); data.set("is_published", "true");
  return data;
}
describe("Layer 1 FAQ publication lifecycle", () => {
  it("creates pending content despite the legacy DB default or client flag", async () => {
    expect(await createFaq({ error: null }, form())).toMatchObject({ error: null });
    expect(fake.writes[0]).toMatchObject({ business_id: "tenant-a", is_published: false });
  });
  it("withdraws publication when content changes and scopes the update", async () => {
    expect(await updateFaq({ error: null }, form())).toMatchObject({ error: null });
    expect(fake.writes[0]).toMatchObject({ is_published: false });
    expect(fake.filters).toContainEqual(["business_id", "tenant-a"]);
    expect(fake.filters).toContainEqual(["id", "00000000-0000-4000-8000-000000000001"]);
  });
});
