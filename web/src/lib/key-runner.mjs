// key-runner.mjs — map a stored AI-key config onto the core's key-based
// evaluation runner (openrouter-runner.mjs at the repo root).
//
// The runner speaks the OpenAI-compatible /chat/completions wire, so ONE
// runner covers every provider: Groq/NIM/OpenAI/custom hit their native
// OpenAI-compat base URL, and Gemini via Google's official OpenAI-compatible
// bridge (/v1beta/openai). The runner's own free-model rotation/blacklist/
// report-writing logic does the rest — no agent CLI on the host needed.
//
// Pure + injected so node --test covers the mapping without a route.

import { providerSpec } from "./ai-providers.mjs";

/** OpenAI-compat chat-completions URL for a provider config. */
export function compatChatUrl(cfg) {
  if (cfg.provider === "google") {
    return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  }
  const spec = providerSpec(cfg.provider);
  const base = (cfg.baseUrl || spec?.baseUrl || "").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

/**
 * What the /api/run route needs to spawn the runner as a plain Node child:
 * argv (node openrouter-runner.mjs evaluate <url>), the env that carries the
 * stored credentials/model, and a human label for stream/error lines.
 */
export function buildKeyRunner({ cfg, root, input, execPath }) {
  const spec = providerSpec(cfg.provider);
  if (!spec) throw new Error(`unknown provider '${cfg.provider}'`);
  const model = cfg.model || spec.freeModels?.[0] || spec.defaultModel || "";
  if (!model) throw new Error("this provider needs a model name");
  return {
    binPath: execPath,
    args: [`${root}/openrouter-runner.mjs`, "evaluate", input],
    env: {
      OPENROUTER_API_KEY: cfg.apiKey || "local-no-key", // local servers ignore auth
      OPENROUTER_API_URL: compatChatUrl(cfg),
      // Pin so non-OpenRouter providers never hit the OR model-list endpoint.
      CAREER_OPS_MODEL: model,
    },
    name: `AI key (${cfg.provider}/${model})`,
  };
}
