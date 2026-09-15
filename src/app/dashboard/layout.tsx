import Link from "next/link";
import { requireBusiness } from "@halo/tenancy/auth";

// Every dashboard page is per-user and cookie-scoped — never prerender.
export const dynamic = "force-dynamic";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { signOut } from "@/features/auth/actions";
import { DashboardNav } from "@/features/dashboard/nav";
import { Button } from "@/components/ui/button";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { businessId } = await requireBusiness();
  const supabase = await createSupabaseServerClient();
  const { data: business } = await supabase
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .single();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto flex max-w-7xl">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-6 md:flex dark:border-slate-800 dark:bg-slate-900">
          <Link href="/dashboard" className="mb-8 flex items-center gap-2 px-2 font-bold text-slate-900 dark:text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-xs text-white">
              AI
            </span>
            AI Receptionist
          </Link>
          <DashboardNav />
          <div className="mt-auto space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
            <p className="truncate px-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              {business?.name}
            </p>
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
                Sign out
              </Button>
            </form>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
