import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  checkRequest,
  hostFromExternalUrl,
  parseAllowedHosts,
  parseAllowedOrigins,
} from "@/lib/origin-guard.mjs";

// Single choke point over the API surface. Every /api request is gated on the
// same-origin + loopback guard before it can reach a route handler (which may
// spawn a child process or write the user's files). See origin-guard.mjs for
// the two-layer rationale (F1 drive-by CSRF, F2 LAN reachability).
//
// Opt in to extra hosts (e.g. a trusted LAN box) with a comma/space separated
// CAREER_OPS_WEB_ALLOWED_HOSTS; unset means loopback only. "*.wildcard"
// entries (e.g. *.onrender.com) match any subdomain. On Render the service's
// own platform-assigned host (RENDER_EXTERNAL_URL) is trusted automatically,
// so a fresh deploy needs no host config at all — recreating the service
// with a new minted hostname still just works.
//
// Opt in to extra *origins* the same way with CAREER_OPS_ALLOWED_ORIGINS;
// unset means none. Regular browser use never needs it (same-origin Fetch
// Metadata passes on its own) — only exotic clients like a browser extension
// calling from a chrome-extension:// origin do.
export function proxy(req: NextRequest) {
  const allowedHosts = parseAllowedHosts(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS);
  const ownHost = hostFromExternalUrl(process.env.RENDER_EXTERNAL_URL ?? "");
  if (ownHost) allowedHosts.add(ownHost);
  const decision = checkRequest({
    secFetchSite: req.headers.get("sec-fetch-site"),
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
    allowedHosts,
    allowedOrigins: parseAllowedOrigins(process.env.CAREER_OPS_ALLOWED_ORIGINS),
  });
  if (!decision.ok) {
    return NextResponse.json({ error: decision.reason }, { status: decision.status });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
