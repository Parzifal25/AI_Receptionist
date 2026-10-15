import { withAuditedAction } from "@halo/tenancy/audited-action";
import { bindSecurityIdentity, recordAuthenticationDenial } from "@halo/platform/security-audit";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { safeRedirectPath } from "@halo/platform/safe-redirect";

/**
 * OAuth / email-confirmation callback: exchanges the auth code for a session
 * and forwards the user into the app.
 */
export async function GET(request: NextRequest) {
  return withAuditedAction(async () => {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  if (code) {
    try {
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        if (data?.user) await bindSecurityIdentity({ actorId: data.user.id, businessId: null }, true);
        return NextResponse.redirect(`${origin}${next}`, { headers: { "Cache-Control": "private, no-store" } });
      }
    } catch {
      // Never place the code or an upstream exception in a URL or log.
    }
  }

  await recordAuthenticationDenial();
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`, { headers: { "Cache-Control": "private, no-store" } });
  }, { action: "authentication", method: "GET" });
}
