import "server-only";
import type { VisitBookingPort, VisitSlot } from "@halo/qualification/booking-step";
import type { VoiceCallContext } from "@halo/voice/gateway";
import { BookingService } from "@halo/scheduling/booking-service";
import { SchedulingRepository } from "@halo/scheduling/scheduling-repository";

/** Adapts the existing race-safe scheduler; offered slots never come from a model. */
export function visitBookingForCall(ctx: VoiceCallContext): VisitBookingPort {
  const repository = new SchedulingRepository();
  const service = new BookingService(repository);
  let timezone = "UTC";
  const label = (slot: { startsAt: string }) => new Intl.DateTimeFormat(ctx.route.version.config.language.primary,
    { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(slot.startsAt));
  const asSlot = (slot: { startsAt: string; endsAt: string; staffId: string }): VisitSlot => ({ ...slot, label: label(slot) });
  return {
    async offerSlots({ now, limit }) {
      const result = await service.getAvailability({ business: ctx.route.business, now, limit });
      timezone = result.settings.timezone;
      return result.slots.map(asSlot);
    },
    async book({ slot, name, phone, now }) {
      const existing = await repository.findLiveAppointmentByConversation(ctx.conversationId);
      if (existing) {
        if (existing.businessId !== ctx.call.businessId) throw new Error("Appointment tenant mismatch");
        return { ok: true, appointmentId: existing.id, startsAt: existing.startsAt, label: label(existing) };
      }
      const result = await service.book({ business: ctx.route.business, conversationId: ctx.conversationId,
        slot: { ...slot, staffName: "" }, serviceName: ctx.route.version.config.objective || "Appointment",
        visitorName: name, visitorPhone: phone, visitorEmail: "", now });
      if (result.ok) return { ok: true, appointmentId: result.appointment.id,
        startsAt: result.appointment.startsAt, label: label(result.appointment) };
      if (result.reason === "slot_taken") return { ...result, alternatives: result.alternatives.map(asSlot) };
      return result;
    },
  };
}
