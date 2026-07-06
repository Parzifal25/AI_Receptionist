import "server-only";
import type { KnowledgeProvider } from "@/core/ports/knowledge-provider";
import { getAdminClient } from "@/lib/supabase/admin";
import { getEmbeddingProvider } from "@/providers/embedding/factory";
import { SupabaseKnowledgeProvider } from "./supabase-knowledge-provider";

let cached: KnowledgeProvider | null = null;

export function getKnowledgeProvider(): KnowledgeProvider {
  if (cached) return cached;
  cached = new SupabaseKnowledgeProvider(getAdminClient(), getEmbeddingProvider());
  return cached;
}
