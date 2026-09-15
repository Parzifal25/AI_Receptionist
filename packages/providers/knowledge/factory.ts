import "server-only";
import type { KnowledgeProvider } from "@halo/ports/knowledge-provider";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { getEmbeddingProvider } from "@halo/providers/embedding/factory";
import { SupabaseKnowledgeProvider } from "./supabase-knowledge-provider";

let cached: KnowledgeProvider | null = null;

export function getKnowledgeProvider(): KnowledgeProvider {
  if (cached) return cached;
  cached = new SupabaseKnowledgeProvider(getAdminClient(), getEmbeddingProvider());
  return cached;
}
