/** Shared by browser, server, and proxy so refresh/delete use identical scope.
 * Browser Supabase needs cookie access; httpOnly is intentionally not enabled.
 */
export const authCookieOptions = {
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};
