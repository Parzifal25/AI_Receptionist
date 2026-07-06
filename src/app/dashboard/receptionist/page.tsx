import type { Metadata } from "next";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ReceptionistForm } from "@/features/receptionist/receptionist-form";
import { DEFAULT_BRANDING, type WidgetBranding } from "@/core/domain/types";

export const metadata: Metadata = { title: "Receptionist — AI Receptionist" };

export default async function ReceptionistPage() {
  const { businessId } = await requireBusiness();
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from("receptionists")
    .select(
      "id, name, greeting, tone, language, custom_instructions, is_active, lead_capture_enabled, voice_enabled, branding",
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  const branding: WidgetBranding = {
    ...DEFAULT_BRANDING,
    ...((data?.branding ?? {}) as Partial<WidgetBranding>),
  };

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Receptionist</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Configure how your AI receptionist behaves and looks.
        </p>
      </div>
      <ReceptionistForm
        receptionist={{
          id: data!.id,
          name: data!.name,
          greeting: data!.greeting,
          tone: data!.tone,
          language: data!.language,
          customInstructions: data!.custom_instructions,
          isActive: data!.is_active,
          leadCaptureEnabled: data!.lead_capture_enabled,
          voiceEnabled: data!.voice_enabled,
          branding,
        }}
      />
    </div>
  );
}
