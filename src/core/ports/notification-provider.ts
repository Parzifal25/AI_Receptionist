export interface LeadNotification {
  businessId: string;
  businessName: string;
  recipientEmail: string;
  lead: { name: string; email: string; phone: string; intent: string };
}

/**
 * Port for outbound notifications. Phase 1 ships a structured-log
 * implementation; an email provider (Resend/SES/Postmark) drops in behind
 * this interface without touching lead-capture logic.
 */
export interface NotificationProvider {
  readonly name: string;
  notifyNewLead(notification: LeadNotification): Promise<void>;
}
