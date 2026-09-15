import type { Metadata } from "next";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { ProfileForm } from "@/features/business/profile-form";
import type { BusinessHours } from "@halo/core/domain/types";

export const metadata: Metadata = { title: "Business profile — AI Receptionist" };

export default async function ProfilePage() {
  const { businessId } = await requireBusiness();
  const supabase = await createSupabaseServerClient();

  const { data: business } = await supabase
    .from("businesses")
    .select("name, description, industry, website, phone, email, address, business_hours")
    .eq("id", businessId)
    .single();

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Business profile</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Your receptionist uses this information to introduce and represent your business — keep it accurate.
        </p>
      </div>
      <ProfileForm
        business={{
          name: business?.name ?? "",
          description: business?.description ?? "",
          industry: business?.industry ?? "",
          website: business?.website ?? "",
          phone: business?.phone ?? "",
          email: business?.email ?? "",
          address: business?.address ?? "",
          businessHours: (business?.business_hours ?? {}) as BusinessHours,
        }}
      />
    </div>
  );
}
