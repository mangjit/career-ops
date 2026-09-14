import { NextResponse } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import { readAiKeys } from "@/lib/ai-key-store.mjs";
import { probeChat } from "@/lib/ai-client.mjs";
import { providerSpec } from "@/lib/ai-providers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// "Test key": runs one tiny completion against the stored (or supplied)
// credentials so the Config page can show a real verdict before saving.
export async function POST(req: Request) {
  let body: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* fall through to the stored config */
  }
  let body2: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } = body;
  const spec = providerSpec(body2.provider ?? "");
  const cfg =
    spec && (body2.apiKey?.trim() || spec.optionalKey) && (spec.id !== "custom" || body2.baseUrl?.trim())
      ? { provider: body2.provider!, model: body2.model ?? "", apiKey: body2.apiKey ?? "", baseUrl: body2.baseUrl ?? "" }
      : readAiKeys(careerOpsRoot());
  if (!cfg) return NextResponse.json({ ok: false, error: "no key supplied or stored" }, { status: 400 });
  try {
    const sample = await probeChat(cfg);
    return NextResponse.json({ ok: true, provider: cfg.provider, model: cfg.model, sample });
  } catch (e) {
    return NextResponse.json(
      { ok: false, provider: cfg.provider, error: e instanceof Error ? e.message : "request failed" },
      { status: 502 },
    );
  }
}
