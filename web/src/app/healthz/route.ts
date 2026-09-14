import { NextResponse } from "next/server";

// Unguarded liveness endpoint for host health checks (Render & friends).
//
// The /api proxy guard intentionally 403s any host that isn't loopback or
// explicitly allowlisted (CAREER_OPS_WEB_ALLOWED_HOSTS) — those routes spawn
// processes and write the user's files, so refusing strangers is the whole
// point. But an infra health probe must not depend on operator-configured
// env vars: pointing Render's healthCheckPath at an /api route made fresh
// deploys "Timed Out" until the allowlist was filled in. This route lives
// OUTSIDE the guard's matcher ("/api/:path*"), answers nothing sensitive,
// and is what render.yaml's healthCheckPath uses.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true });
}
