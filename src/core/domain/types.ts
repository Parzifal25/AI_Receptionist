/**
 * Domain entities. These mirror the database schema but are the canonical
 * types the application layer works with — services never depend on raw
 * Supabase row shapes.
 */

export interface Business {
  id: string;
  name: string;
  slug: string;
  description: string;
  industry: string;
  website: string;
  phone: string;
  email: string;
  address: string;
  businessHours: BusinessHours;
  logoUrl: string;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type BusinessHours = Partial<
  Record<Weekday, { open: string; close: string; closed: boolean }>
>;

export type ReceptionistTone = "friendly" | "professional" | "casual" | "formal";

export interface WidgetBranding {
  theme: "light" | "dark" | "auto";
  primaryColor: string;
  position: "bottom-right" | "bottom-left";
  avatarUrl: string;
  launcherLabel: string;
}

export const DEFAULT_BRANDING: WidgetBranding = {
  theme: "auto",
  primaryColor: "#4f46e5",
  position: "bottom-right",
  avatarUrl: "",
  launcherLabel: "Chat with us",
};

export interface Receptionist {
  id: string;
  businessId: string;
  name: string;
  greeting: string;
  tone: ReceptionistTone;
  language: string;
  customInstructions: string;
  widgetKey: string;
  isActive: boolean;
  leadCaptureEnabled: boolean;
  voiceEnabled: boolean;
  branding: WidgetBranding;
}

export interface Faq {
  id: string;
  businessId: string;
  question: string;
  answer: string;
  category: string;
  sortOrder: number;
  isPublished: boolean;
}

export interface KnowledgeDocument {
  id: string;
  businessId: string;
  title: string;
  content: string;
  sourceType: "manual" | "file" | "url";
  status: "processing" | "ready" | "error";
  createdAt: string;
}

export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface Conversation {
  id: string;
  businessId: string;
  receptionistId: string;
  visitorToken: string;
  channel: "chat" | "voice";
  status: "active" | "ended";
  messageCount: number;
  startedAt: string;
  lastMessageAt: string;
}

export type LeadStatus = "new" | "contacted" | "qualified" | "closed";

export interface Lead {
  id: string;
  businessId: string;
  conversationId: string | null;
  name: string;
  email: string;
  phone: string;
  intent: string;
  notes: string;
  status: LeadStatus;
  createdAt: string;
}

export interface LeadDraft {
  name?: string;
  email?: string;
  phone?: string;
  intent?: string;
}

export interface KnowledgeSnippet {
  source: "chunk" | "faq";
  refId: string;
  /** Human-readable source label (document title or FAQ category). */
  title: string;
  content: string;
  score: number;
}

export type UsageEventType =
  | "widget_loaded"
  | "conversation_started"
  | "message_sent"
  | "lead_captured"
  | "voice_used"
  /** A substantive visitor question retrieval found no knowledge for. */
  | "unanswered_question"
  | "appointment_booked"
  | "appointment_rescheduled"
  | "appointment_cancelled";
