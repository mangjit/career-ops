// ai-key-store.mjs — server-side storage for the key-based AI engine.
//
// The Config page POSTs {provider, model, apiKey} here; the file lives at
// config/ai-keys.json inside the career-ops checkout, which is:
//   - gitignored (a secret never enters the repo), and
//   - part of mongo-sync's tracked surface, so it survives Render redeploys
//     like the rest of the personal data.
//
// Plain node JS with the root injected so node --test covers it; the routes
// pass careerOpsRoot(). Reads never return the key to the browser except
// masked (see ai-client.mjs maskedKey).

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { providerSpec } from "./ai-providers.mjs";

export function aiKeysPath(root) {
  return path.join(root, "config", "ai-keys.json");
}

/** Atomic (temp+rename in the same dir) JSON write — mirrors safe-write.ts. */
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** null when unset/unreadable — callers treat that as "no key engine". */
export function readAiKeys(root) {
  try {
    const v = JSON.parse(fs.readFileSync(aiKeysPath(root), "utf8"));
    if (!v || typeof v !== "object") return null;
    const spec = providerSpec(v.provider);
    if (!spec) return null;
    const apiKey = typeof v.apiKey === "string" ? v.apiKey.trim() : "";
    if (!apiKey && !spec.optionalKey) return null;
    return {
      provider: v.provider,
      // "" = auto: the client walks the provider's free-first model chain.
      model: typeof v.model === "string" ? v.model.trim() : "",
      apiKey,
      baseUrl: typeof v.baseUrl === "string" ? v.baseUrl.trim() : "",
    };
  } catch {
    return null;
  }
}

export function writeAiKeys(root, { provider, model, apiKey, baseUrl }) {
  const spec = providerSpec(provider);
  if (!spec) throw new Error(`unknown provider '${provider}'`);
  const key = (apiKey ?? "").trim();
  if (!key && !spec.optionalKey) throw new Error("apiKey required");
  if (spec.id === "custom" && !(baseUrl ?? "").trim()) throw new Error("custom provider needs a base URL");
  writeJsonAtomic(aiKeysPath(root), {
    provider,
    model: (model ?? "").trim(),
    apiKey: key,
    baseUrl: (baseUrl ?? "").trim(),
  });
}

export function deleteAiKeys(root) {
  try {
    fs.rmSync(aiKeysPath(root), { force: true });
    return true;
  } catch {
    return false;
  }
}
