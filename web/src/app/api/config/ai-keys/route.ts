import { NextResponse } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import { readAiKeys, writeAiKeys, deleteAiKeys } from "@/lib/ai-key-store.mjs";
import { maskedKey } from "@/lib/ai-client.mjs";
import { providerSpec, AI_PROVIDERS } from "@/lib/ai-providers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET never returns the key itself — only enough for the Config page to show
// "configured with …" and restore the key mode.
export async function GET() {
  const cfg = readAiKeys(careerOpsRoot());
  if (!cfg) return NextResponse.json({ configured: false, providers: AI_PROVIDERS.map((p) => p.id) });
  return NextResponse.json({
    configured: true,
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    maskedKey: maskedKey(cfg.apiKey),
  });
}

export async function POST(req: Request) {
  let body: { provider?: string; model?: string; apiKey?: string; baseUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const spec = providerSpec(body.provider ?? "");
  if (!spec) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  if ((typeof body.apiKey !== "string" || !body.apiKey.trim()) && !spec.optionalKey) {
    return NextResponse.json({ error: "apiKey required" }, { status: 400 });
  }
  try {
    writeAiKeys(careerOpsRoot(), {
      provider: body.provider,
      model: body.model ?? "",
      apiKey: body.apiKey ?? "",
      baseUrl: body.baseUrl ?? "",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 400 });
  }
  return NextResponse.json({ configured: true, provider: body.provider });
}

export async function DELETE() {
  deleteAiKeys(careerOpsRoot());
  return NextResponse.json({ configured: false });
}
