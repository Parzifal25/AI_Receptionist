import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions } from "@halo/tenancy/supabase/cookie-options";

/**
 * Session refresh + route protection. Runs on every matched request:
 * keeps the Supabase auth cookie fresh and gates /dashboard and /onboarding
 * behind authentication. The public widget API is deliberately excluded.
 */
export default async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const unavailable = () => new NextResponse("Sign-in is temporarily unavailable. Please try again.", {
    status: 503, headers: { "Cache-Control": "private, no-store" },
  });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return unavailable();

  let user;
  try {
    const supabase = createServerClient(
      url,
      key,
      {
        cookieOptions: authCookieOptions,
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet, headers) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
            const previous = response;
            response = NextResponse.next({ request });
            previous.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
            for (const name of ["cache-control", "expires", "pragma"]) {
              const value = previous.headers.get(name);
              if (value) response.headers.set(name, value);
            }
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options),
            );
            Object.entries(headers ?? {}).forEach(([name, value]) => response.headers.set(name, value));
          },
        },
      },
    );

    const result = await supabase.auth.getUser();
    if (result.error && (!result.error.status || result.error.status >= 500 || result.error.status === 429)) return unavailable();
    user = result.error ? null : result.data.user;
  } catch {
    return unavailable();
  }

  // Cookie rotation/deletion and anti-cache headers must survive redirects too.
  const redirectWithSession = (url: URL) => {
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    redirect.headers.set("Cache-Control", "private, no-store");
    redirect.headers.set("Expires", "0");
    redirect.headers.set("Pragma", "no-cache");
    return redirect;
  };

  const { pathname } = request.nextUrl;
  const isProtected = pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding");
  const isAuthPage = pathname === "/login" || pathname === "/register";

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return redirectWithSession(url);
  }

  if (isAuthPage && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return redirectWithSession(url);
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/onboarding", "/login", "/register"],
};
