import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { logger } from "@halo/platform/logger";
import {
  CONVERSATION_STATE_VERSION,
  parseConversationState,
  type ConversationState,
  type ConversationStateStore,
} from "../conversation-state";

const log = logger.child({ service: "conversation-state-store" });

/**
 * Postgres-backed conversation state (migration 0019_conversation_state).
 * Service-role client with explicit tenant scoping on every statement
 * (the Regime B pattern): a conversation id alone never selects a row —
 * the trusted business id must match too.
 */
export class SupabaseConversationStateStore implements ConversationStateStore {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async load(conversationId: string, businessId: string): Promise<ConversationState | null> {
    const { data, error } = await this.db
      .from("conversation_state")
      .select("state, state_version")
      .eq("conversation_id", conversationId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      log.warn("conversation state load failed", { error: error.message });
      throw new Error(error.message);
    }
    if (!data) return null;
    const parsed = parseConversationState(data.state);
    if (!parsed) {
      // Malformed or foreign-version rows are ignored loudly, never served.
      log.warn("conversation state row failed validation; starting fresh", {
        conversationId,
        stateVersion: data.state_version,
      });
      return null;
    }
    return parsed;
  }

  async save(conversationId: string, businessId: string, state: ConversationState): Promise<void> {
    const { error } = await this.db.from("conversation_state").upsert(
      {
        conversation_id: conversationId,
        business_id: businessId,
        state,
        state_version: CONVERSATION_STATE_VERSION,
      },
      { onConflict: "conversation_id" },
    );
    if (error) {
      log.warn("conversation state save failed", { error: error.message });
      throw new Error(error.message);
    }
  }
}
