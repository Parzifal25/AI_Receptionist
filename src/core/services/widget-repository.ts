import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Business,
  ChatMessage,
  Conversation,
  LeadDraft,
  Receptionist,
  UsageEventType,
  WidgetBranding,
} from "@halo/core/domain/types";
import { DEFAULT_BRANDING } from "@halo/core/domain/types";
import { scoreLead } from "./lead-scorer";
import { AppError } from "@halo/core/errors/app-error";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { logger } from "@halo/platform/logger";
import type { ToolTranscriptRecord } from "@halo/runtime/system-actions";

const log = logger.child({ service: "widget-repository" });

export interface ReceptionistContext {
  receptionist: Receptionist;
  business: Business;
  allowedDomains: string[];
}

/**
 * All persistence for the public widget API. Runs on the service role, so
 * every method takes explicit tenant scope (widget key or visitor token) —
 * nothing here can be called without proving which tenant/conversation the
 * caller belongs to.
 */
export class WidgetRepository {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  /** Resolves a widget key to its receptionist + business. */
  async getReceptionistByWidgetKey(widgetKey: string): Promise<ReceptionistContext> {
    return this.fetchReceptionistContext("widget_key", widgetKey);
  }

  /** Same hydrated context, looked up by receptionist id (used mid-conversation). */
  async getReceptionistById(receptionistId: string): Promise<ReceptionistContext> {
    return this.fetchReceptionistContext("id", receptionistId);
  }

  private async fetchReceptionistContext(
    column: "widget_key" | "id",
    value: string,
  ): Promise<ReceptionistContext> {
    const { data, error } = await this.db
      .from("receptionists")
      .select(
        `id, business_id, name, greeting, tone, language, custom_instructions,
         widget_key, is_active, lead_capture_enabled, voice_enabled, branding,
         businesses ( id, name, slug, description, industry, website, phone,
                      email, address, business_hours, logo_url,
                      business_settings ( allowed_domains ) )`,
      )
      .eq(column, value)
      .maybeSingle();

    if (error) {
      log.error("widget key lookup failed", { error: error.message });
      throw AppError.internal();
    }
    if (!data || !data.is_active) throw AppError.notFound("Receptionist");

    const biz = data.businesses as unknown as {
      id: string;
      name: string;
      slug: string;
      description: string;
      industry: string;
      website: string;
      phone: string;
      email: string;
      address: string;
      business_hours: Business["businessHours"];
      logo_url: string;
      business_settings: { allowed_domains: string[] } | { allowed_domains: string[] }[] | null;
    };

    const settings = Array.isArray(biz.business_settings)
      ? biz.business_settings[0]
      : biz.business_settings;

    return {
      receptionist: {
        id: data.id,
        businessId: data.business_id,
        name: data.name,
        greeting: data.greeting,
        tone: data.tone,
        language: data.language,
        customInstructions: data.custom_instructions,
        widgetKey: data.widget_key,
        isActive: data.is_active,
        leadCaptureEnabled: data.lead_capture_enabled,
        voiceEnabled: data.voice_enabled,
        branding: { ...DEFAULT_BRANDING, ...(data.branding as Partial<WidgetBranding>) },
      },
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
      allowedDomains: settings?.allowed_domains ?? [],
    };
  }

  /**
   * Trusted tenant proof for agent resolution (HALO Phase 1). A widget key
   * exists on exactly one receptionist row of exactly one tenant, so it maps
   * 1:1 to (businessId, agent slug = receptionist id). No client input can
   * widen this scope.
   */
  async getAgentSelectorByWidgetKey(
    widgetKey: string,
  ): Promise<{ businessId: string; agentSlug: string }> {
    const { data, error } = await this.db
      .from("receptionists")
      .select("id, business_id, is_active")
      .eq("widget_key", widgetKey)
      .maybeSingle();
    if (error) {
      log.error("agent selector lookup failed", { error: error.message });
      throw AppError.internal();
    }
    if (!data || !data.is_active) throw AppError.notFound("Receptionist");
    return { businessId: data.business_id, agentSlug: data.id };
  }

  async createConversation(params: {
    businessId: string;
    receptionistId: string;
    channel: "chat" | "voice";
    pageUrl: string;
    userAgent: string;
    /** HALO Phase 1: agent serving this conversation (optional during the
     *  compatibility period; resolved by AgentResolver when available). */
    agentId?: string | null;
    agentVersionId?: string | null;
  }): Promise<Conversation> {
    const { data, error } = await this.db
      .from("conversations")
      .insert({
        business_id: params.businessId,
        receptionist_id: params.receptionistId,
        channel: params.channel,
        page_url: params.pageUrl.slice(0, 2000),
        user_agent: params.userAgent.slice(0, 500),
        ...(params.agentId !== undefined ? { agent_id: params.agentId } : {}),
        ...(params.agentVersionId !== undefined ? { agent_version_id: params.agentVersionId } : {}),
      })
      .select("id, business_id, receptionist_id, visitor_token, channel, status, message_count, started_at, last_message_at, agent_id, agent_version_id")
      .single();

    if (error || !data) {
      log.error("conversation create failed", { error: error?.message });
      throw AppError.internal();
    }
    return mapConversation(data);
  }

  /** Fetches a conversation by its visitor token — the widget's proof of ownership. */
  async getConversationByToken(visitorToken: string): Promise<Conversation> {
    const { data, error } = await this.db
      .from("conversations")
      .select("id, business_id, receptionist_id, visitor_token, channel, status, message_count, started_at, last_message_at, agent_id, agent_version_id")
      .eq("visitor_token", visitorToken)
      .maybeSingle();

    if (error) {
      log.error("conversation lookup failed", { error: error.message });
      throw AppError.internal();
    }
    if (!data) throw AppError.notFound("Conversation");
    return mapConversation(data);
  }

  /**
   * Conversational rows only (user/assistant): tool-call transcript rows
   * (role = 'tool', migration 0016) are runtime records, never model history.
   */
  async getRecentMessages(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    const { data, error } = await this.db
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      log.error("message fetch failed", { error: error.message });
      throw AppError.internal();
    }
    return (data ?? []).reverse() as ChatMessage[];
  }

  async appendMessages(
    conversationId: string,
    businessId: string,
    messages: ChatMessage[],
  ): Promise<void> {
    const { error } = await this.db.from("messages").insert(
      messages.map((m) => ({
        conversation_id: conversationId,
        business_id: businessId,
        role: m.role,
        content: m.content,
      })),
    );
    if (error) {
      log.error("message insert failed", { error: error.message });
      throw AppError.internal();
    }
    // conversations.message_count / last_message_at are maintained by the
    // messages_bump_conversation trigger — no read-modify-write here.
  }

  /**
   * Transcribes tool-call turns (HALO Phase 2): one `role = 'tool'` row per
   * executed or rejected intent, with validated arguments and the typed
   * result. Content stays empty — the runtime narrates from the result.
   */
  async appendToolRecords(
    conversationId: string,
    businessId: string,
    records: ToolTranscriptRecord[],
  ): Promise<void> {
    if (records.length === 0) return;
    const { error } = await this.db.from("messages").insert(
      records.map(({ intent, result }) => ({
        conversation_id: conversationId,
        business_id: businessId,
        role: "tool",
        content: "",
        tool_call_id: intent.id.slice(0, 200),
        tool_name: intent.name.slice(0, 200),
        tool_args: intent.arguments,
        tool_result: {
          status: result.status,
          summary: result.summary,
          ...(result.rejection ? { rejection: result.rejection } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
      })),
    );
    if (error) {
      log.error("tool transcript insert failed", { error: error.message });
      throw AppError.internal();
    }
  }

  /** Marks a conversation ended; subsequent messages are rejected. */
  async endConversation(conversationId: string): Promise<void> {
    const { error } = await this.db
      .from("conversations")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (error) {
      log.error("conversation end failed", { error: error.message });
      throw AppError.internal();
    }
  }

  /**
   * Creates or updates the lead attached to a conversation. One lead per
   * conversation; new details merge into existing ones. The merged record is
   * re-qualified on every write so the score always reflects everything known
   * so far — passing the transcript sharpens intent/urgency signals.
   */
  async upsertConversationLead(
    businessId: string,
    conversationId: string,
    draft: LeadDraft,
    transcript: ChatMessage[] = [],
  ): Promise<{ isNew: boolean }> {
    const { data: existing, error: fetchError } = await this.db
      .from("leads")
      .select("id, name, email, phone, intent")
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (fetchError) {
      log.error("lead lookup failed", { error: fetchError.message });
      throw AppError.internal();
    }

    const merged: LeadDraft = {
      name: draft.name || existing?.name || "",
      email: draft.email || existing?.email || "",
      phone: draft.phone || existing?.phone || "",
      intent: draft.intent || existing?.intent || "",
    };
    const qualification = scoreLead(merged, transcript);

    if (existing) {
      const { error } = await this.db
        .from("leads")
        .update({
          name: merged.name,
          email: merged.email,
          phone: merged.phone,
          intent: merged.intent,
          score: qualification.score,
          temperature: qualification.temperature,
          qualification,
        })
        .eq("id", existing.id);
      if (error) {
        log.error("lead update failed", { error: error.message });
        throw AppError.internal();
      }
      return { isNew: false };
    }

    const { error } = await this.db.from("leads").insert({
      business_id: businessId,
      conversation_id: conversationId,
      name: merged.name,
      email: merged.email,
      phone: merged.phone,
      intent: merged.intent,
      score: qualification.score,
      temperature: qualification.temperature,
      qualification,
    });
    if (error) {
      log.error("lead insert failed", { error: error.message });
      throw AppError.internal();
    }
    return { isNew: true };
  }

  async getBusinessNotificationSettings(
    businessId: string,
  ): Promise<{ notifyOnLead: boolean; notificationEmail: string }> {
    const { data } = await this.db
      .from("business_settings")
      .select("notify_on_lead, notification_email")
      .eq("business_id", businessId)
      .maybeSingle();
    return {
      notifyOnLead: data?.notify_on_lead ?? false,
      notificationEmail: data?.notification_email ?? "",
    };
  }

  /**
   * Deletes conversations + usage events past each tenant's retention window.
   * Invoked by the scheduled retention job on the service role.
   */
  async purgeExpiredData(): Promise<{ conversations: number; events: number }> {
    const { data, error } = await this.db.rpc("purge_expired_data").single<{
      deleted_conversations: number;
      deleted_events: number;
    }>();
    if (error) {
      log.error("data purge failed", { error: error.message });
      throw AppError.internal();
    }
    return {
      conversations: data?.deleted_conversations ?? 0,
      events: data?.deleted_events ?? 0,
    };
  }

  /** Fire-and-forget analytics event. Failures are logged, never thrown. */
  async trackEvent(
    businessId: string,
    eventType: UsageEventType,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.db.from("usage_events").insert({
      business_id: businessId,
      event_type: eventType,
      metadata,
    });
    if (error) log.warn("usage event insert failed", { error: error.message });
  }
}

function mapConversation(row: {
  id: string;
  business_id: string;
  receptionist_id: string;
  visitor_token: string;
  channel: string;
  status: string;
  message_count: number;
  started_at: string;
  last_message_at: string;
  agent_id?: string | null;
  agent_version_id?: string | null;
}): Conversation {
  return {
    id: row.id,
    businessId: row.business_id,
    receptionistId: row.receptionist_id,
    visitorToken: row.visitor_token,
    channel: row.channel as "chat" | "voice",
    status: row.status as "active" | "ended",
    messageCount: row.message_count,
    startedAt: row.started_at,
    lastMessageAt: row.last_message_at,
    agentId: row.agent_id ?? null,
    agentVersionId: row.agent_version_id ?? null,
  };
}
