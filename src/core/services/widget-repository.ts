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
} from "@/core/domain/types";
import { DEFAULT_BRANDING } from "@/core/domain/types";
import { AppError } from "@/core/errors/app-error";
import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

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

  async createConversation(params: {
    businessId: string;
    receptionistId: string;
    channel: "chat" | "voice";
    pageUrl: string;
    userAgent: string;
  }): Promise<Conversation> {
    const { data, error } = await this.db
      .from("conversations")
      .insert({
        business_id: params.businessId,
        receptionist_id: params.receptionistId,
        channel: params.channel,
        page_url: params.pageUrl.slice(0, 2000),
        user_agent: params.userAgent.slice(0, 500),
      })
      .select("id, business_id, receptionist_id, visitor_token, channel, status, message_count, started_at, last_message_at")
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
      .select("id, business_id, receptionist_id, visitor_token, channel, status, message_count, started_at, last_message_at")
      .eq("visitor_token", visitorToken)
      .maybeSingle();

    if (error) {
      log.error("conversation lookup failed", { error: error.message });
      throw AppError.internal();
    }
    if (!data) throw AppError.notFound("Conversation");
    return mapConversation(data);
  }

  async getRecentMessages(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    const { data, error } = await this.db
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
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

    const { data: convo } = await this.db
      .from("conversations")
      .select("message_count")
      .eq("id", conversationId)
      .single();

    await this.db
      .from("conversations")
      .update({
        message_count: (convo?.message_count ?? 0) + messages.length,
        last_message_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
  }

  /**
   * Creates or updates the lead attached to a conversation. One lead per
   * conversation; new details merge into existing ones.
   */
  async upsertConversationLead(
    businessId: string,
    conversationId: string,
    draft: LeadDraft,
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

    if (existing) {
      const { error } = await this.db
        .from("leads")
        .update({
          name: draft.name || existing.name,
          email: draft.email || existing.email,
          phone: draft.phone || existing.phone,
          intent: draft.intent || existing.intent,
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
      name: draft.name ?? "",
      email: draft.email ?? "",
      phone: draft.phone ?? "",
      intent: draft.intent ?? "",
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
  };
}
