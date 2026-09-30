import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAgentConfig } from "@halo/core/domain/agents";

export const proposalSchema = z.object({
  businessId: z.uuid(), sourceVersionId: z.uuid(), key: z.string().min(1).max(160),
  rationale: z.string().min(1).max(2000), config: z.unknown(), prompt: z.string().max(40000),
});
/** Analysis can suggest changes but has no publication capability. */
export class LearningProposals {
  constructor(private readonly db: SupabaseClient) {}
  async propose(input: z.infer<typeof proposalSchema>): Promise<string> {
    const parsed = proposalSchema.parse(input);
    const config = parseAgentConfig(parsed.config);
    if (!config) throw new Error("Invalid candidate agent configuration");
    const { data, error } = await this.db.from("learning_proposals").insert({ business_id: parsed.businessId,
      source_version_id: parsed.sourceVersionId, proposal_key: parsed.key, rationale: parsed.rationale,
      candidate_config: config, candidate_prompt: parsed.prompt }).select("id").single();
    if (error) throw new Error(`learning proposal: ${error.message}`);
    return data.id;
  }
  async evaluate(businessId: string, id: string, corpus: string, passed: number, total: number): Promise<void> {
    const { error } = await this.db.rpc("evaluate_learning_proposal", { p_business_id: businessId, p_id: id,
      p_corpus: corpus, p_passed: passed, p_total: total });
    if (error) throw new Error(`learning evaluation: ${error.message}`);
  }
  /** Construct with the authenticated user's client: auth.uid() is checked in SQL. */
  async review(businessId: string, id: string, approve: boolean): Promise<string | null> {
    const { data, error } = await this.db.rpc("review_learning_proposal", { p_business_id: businessId, p_id: id, p_approve: approve });
    if (error) throw new Error(`learning review: ${error.message}`);
    return data;
  }
}
