import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage } from "@halo/core/domain/types";
import type { CallTranscriptTurn } from "@halo/core/domain/voice";
import { toAgentVersion, type AgentVersionRow } from "@halo/agents/agent-repository";
import { logger } from "@halo/platform/logger";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import type { ConversationStore } from "@halo/runtime/system-actions";
import type {
  CallEventRecord,
  CallFinalization,
  CallRecord,
  CallStore,
  InboundRoute,
  NewCall,
  OutcomeRecord,
} from "../call-store";

const log = logger.child({ service: "call-store" });

/**
 * Postgres-backed call persistence (migration 0020_voice_calls). Service-role
 * client (Regime B): every statement carries an explicit `business_id` taken
 * from server-side routing, and the 0020 triggers re-check tenant ownership
 * and the call state graph in the database.
 */

const CALL_COLUMNS =
  "id, business_id, agent_id, agent_version_id, conversation_id, phone_number_id, direction, provider, provider_call_id, from_number, to_number, state, correlation_id" as const;

interface CallRow {
  id: string;
  business_id: string;
  agent_id: string;
  agent_version_id: string;
  conversation_id: string | null;
  phone_number_id: string | null;
  direction: CallRecord["direction"];
  provider: string;
  provider_call_id: string;
  from_number: string;
  to_number: string;
  state: CallRecord["state"];
  correlation_id: string;
}

function toCall(row: CallRow): CallRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    conversationId: row.conversation_id,
    phoneNumberId: row.phone_number_id,
    direction: row.direction,
    provider: row.provider,
    providerCallId: row.provider_call_id,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    state: row.state,
    correlationId: row.correlation_id,
  };
}

function fail(operation: string, error: { message: string; code?: string }): never {
  log.error(`${operation} failed`, { error: error.message, code: error.code });
  throw new Error(`call store: ${operation} failed`);
}

export class SupabaseCallStore implements CallStore {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async resolveInboundRoute(provider: string, toNumber: string): Promise<InboundRoute | null> {
    const { data: number, error } = await this.db
      .from("phone_numbers")
      .select("id, business_id, agent_id, handoff_number, status")
      .eq("provider", provider)
      .eq("e164", toNumber)
      .maybeSingle();
    if (error) fail("route lookup", error);
    if (!number || number.status !== "active") return null;

    const { data: agent, error: agentError } = await this.db
      .from("agents")
      .select("id, status, live_version_id")
      .eq("id", number.agent_id)
      .eq("business_id", number.business_id)
      .maybeSingle();
    if (agentError) fail("route agent lookup", agentError);
    if (!agent || agent.status !== "active" || !agent.live_version_id) return null;

    const [{ data: versionRow, error: versionError }, { data: biz, error: bizError }] = await Promise.all([
      this.db
        .from("agent_versions")
        .select("id, agent_id, business_id, version, config, prompt_template, prompt_version, model, published_at, created_by, created_at")
        .eq("id", agent.live_version_id)
        .eq("agent_id", agent.id)
        .eq("business_id", number.business_id)
        .maybeSingle(),
      this.db
        .from("businesses")
        .select("id, name, slug, description, industry, website, phone, email, address, business_hours, logo_url")
        .eq("id", number.business_id)
        .maybeSingle(),
    ]);
    if (versionError) fail("route version lookup", versionError);
    if (bizError) fail("route business lookup", bizError);
    if (!versionRow || !versionRow.published_at || !biz) return null;

    return {
      phoneNumberId: number.id,
      agentId: agent.id,
      agentStatus: agent.status,
      handoffNumber: number.handoff_number,
      version: toAgentVersion(versionRow as AgentVersionRow),
      business: {
        id: biz.id,
        name: biz.name,
        slug: biz.slug,
        description: biz.description,
        industry: biz.industry,
        website: biz.website,
        phone: biz.phone,
        email: biz.email,
        address: biz.address,
        businessHours: biz.business_hours ?? {},
        logoUrl: biz.logo_url,
      },
    };
  }

  async createOrGetCall(input: NewCall): Promise<{ call: CallRecord; created: boolean }> {
    const { data, error } = await this.db
      .from("calls")
      .insert({
        business_id: input.businessId,
        agent_id: input.agentId,
        agent_version_id: input.agentVersionId,
        phone_number_id: input.phoneNumberId,
        direction: input.direction,
        provider: input.provider,
        provider_call_id: input.providerCallId,
        from_number: input.fromNumber.slice(0, 32),
        to_number: input.toNumber.slice(0, 32),
        state: input.state,
        language: input.language,
      })
      .select(CALL_COLUMNS)
      .maybeSingle();
    if (!error && data) return { call: toCall(data as CallRow), created: true };
    // 23505 = unique violation: the provider retried; return the existing leg.
    if (error && error.code !== "23505") fail("call insert", error);
    const existing = await this.getCallByProviderId(input.provider, input.providerCallId);
    if (!existing || existing.businessId !== input.businessId) throw new Error("call store: idempotent call lookup failed");
    return { call: existing, created: false };
  }

  async getCallByProviderId(provider: string, providerCallId: string): Promise<CallRecord | null> {
    const { data, error } = await this.db
      .from("calls")
      .select(CALL_COLUMNS)
      .eq("provider", provider)
      .eq("provider_call_id", providerCallId)
      .maybeSingle();
    if (error) fail("call lookup", error);
    return data ? toCall(data as CallRow) : null;
  }

  async createPhoneConversation(input: { businessId: string; agentId: string; agentVersionId: string }): Promise<string> {
    const { data, error } = await this.db
      .from("conversations")
      .insert({
        business_id: input.businessId,
        channel: "phone",
        agent_id: input.agentId,
        agent_version_id: input.agentVersionId,
      })
      .select("id")
      .single();
    if (error || !data) fail("phone conversation insert", error ?? { message: "no row" });
    return data.id as string;
  }

  async attachConversation(callId: string, businessId: string, conversationId: string): Promise<void> {
    const { error } = await this.db
      .from("calls")
      .update({ conversation_id: conversationId })
      .eq("id", callId)
      .eq("business_id", businessId);
    if (error) fail("attach conversation", error);
  }

  async transitionCall(callId: string, businessId: string, from: CallRecord["state"], to: CallRecord["state"]): Promise<void> {
    const patch: Record<string, unknown> = { state: to };
    if (to === "connected") patch.answered_at = new Date().toISOString();
    // Compare-and-set on the expected state; the trigger enforces the graph.
    const { data, error } = await this.db
      .from("calls")
      .update(patch)
      .eq("id", callId)
      .eq("business_id", businessId)
      .eq("state", from)
      .select("id");
    if (error) fail("call transition", error);
    if (!data || data.length === 0) throw new Error(`call store: call not in state ${from}`);
  }

  async appendEvents(callId: string, businessId: string, events: CallEventRecord[]): Promise<void> {
    if (events.length === 0) return;
    const { error } = await this.db.from("call_events").upsert(
      events.map((e) => ({
        call_id: callId,
        business_id: businessId,
        seq: e.seq,
        type: e.type,
        at: e.at,
        latency_ms: e.latencyMs,
        detail: e.detail,
      })),
      { onConflict: "call_id,seq", ignoreDuplicates: true },
    );
    if (error) fail("call events insert", error);
  }

  async appendTranscript(callId: string, businessId: string, turns: Array<CallTranscriptTurn & { seq: number }>): Promise<void> {
    if (turns.length === 0) return;
    const { error } = await this.db.from("call_transcript_turns").upsert(
      turns.map((t) => ({
        call_id: callId,
        business_id: businessId,
        seq: t.seq,
        turn_index: t.turnIndex,
        speaker: t.speaker,
        source: t.source,
        text: t.text.slice(0, 4000),
        delivered_text: t.deliveredText?.slice(0, 4000) ?? null,
        delivery: t.delivery,
        language: t.language?.slice(0, 16) ?? null,
        stt_confidence: t.sttConfidence,
        turn_id: t.turnId,
        started_at: t.startedAt,
        ended_at: t.endedAt,
      })),
      { onConflict: "call_id,seq", ignoreDuplicates: true },
    );
    if (error) fail("transcript insert", error);
  }

  async finalizeCall(callId: string, businessId: string, f: CallFinalization): Promise<void> {
    const { error } = await this.db
      .from("calls")
      .update({
        ended_at: f.endedAt,
        duration_seconds: f.durationSeconds,
        hangup_cause: f.hangupCause,
        usage: f.usage,
        cost_estimate: f.usage.costEstimate,
      })
      .eq("id", callId)
      .eq("business_id", businessId);
    if (error) fail("call finalize", error);
  }

  async recordOutcome(o: OutcomeRecord): Promise<void> {
    const { error } = await this.db.from("conversation_outcomes").insert({
      business_id: o.businessId,
      call_id: o.callId,
      conversation_id: o.conversationId,
      agent_id: o.agentId,
      agent_version_id: o.agentVersionId,
      disposition: o.disposition,
      disposition_reason: o.dispositionReason?.slice(0, 200) ?? null,
      qualification: o.qualification,
      appointment_id: o.appointmentId,
      escalated: o.escalated,
      do_not_call: o.doNotCall,
    });
    if (error && error.code !== "23505") fail("outcome insert", error);
  }

  async isSuppressed(businessId: string, e164: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("phone_suppressions")
      .select("id")
      .eq("business_id", businessId)
      .eq("e164", e164)
      .maybeSingle();
    if (error) fail("suppression lookup", error);
    return data !== null;
  }

  async suppress(input: { businessId: string; e164: string; reason: "do_not_call" | "wrong_number"; callId: string }): Promise<void> {
    const { error } = await this.db.from("phone_suppressions").upsert(
      { business_id: input.businessId, e164: input.e164, reason: input.reason, call_id: input.callId },
      { onConflict: "business_id,e164", ignoreDuplicates: true },
    );
    if (error) fail("suppression insert", error);
  }

  async recordUsageEvent(businessId: string, type: "call_started" | "call_completed", metadata: Record<string, unknown>) {
    const { error } = await this.db.from("usage_events").insert({ business_id: businessId, event_type: type, metadata });
    if (error) log.warn("call usage event insert failed", { error: error.message });
  }
}

/**
 * Transcript persistence for phone conversations (the runtime's
 * ConversationStore). Conversational rows only are read back as history.
 */
export class SupabasePhoneConversationStore implements ConversationStore {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async loadHistory(conversationId: string, businessId: string, limit: number): Promise<ChatMessage[]> {
    const { data, error } = await this.db
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .eq("business_id", businessId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) fail("history load", error);
    return ((data ?? []) as ChatMessage[]).reverse();
  }

  async appendMessages(conversationId: string, businessId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const { error } = await this.db.from("messages").insert(
      messages.map((m) => ({ conversation_id: conversationId, business_id: businessId, role: m.role, content: m.content })),
    );
    if (error) fail("message insert", error);
  }
}
