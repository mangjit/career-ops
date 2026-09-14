// ai-client.mjs — minimal streaming chat client over the key-based providers
// (web/src/lib/ai-providers.mjs). Fetch-only, so it runs in the Next server
// and in node --test with an injected fetch; no SDKs, no node imports.
//
// streamChat() yields text deltas as they arrive over SSE, which the routes
// pipe straight into their response stream — the UI's envelope parsers
// (<<offer:>>, <<act:>>) don't care which engine produced the text.

import { providerSpec } from "./ai-providers.mjs";

/** "sk-ant-…1234" style masking for the Config UI; never returns the key. */
export function maskedKey(key) {
  const t = (key ?? "").trim();
  if (!t) return "";
  if (t.length <= 8) return "•".repeat(t.length);
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

async function providerError(res, fetchFn) {
  let snippet = "";
  try {
    snippet = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
  } catch {
    /* body unreadable — status alone still tells the story */
  }
  const err = new Error(`provider answered ${res.status}${snippet ? `: ${snippet}` : ""}`);
  err.status = res.status; // the auto-switcher decides on this
  return err;
}

/**
 * Errors worth trying the next free model for: a gone/rate-limited/broken
 * upstream, or no upstream at all. Auth failures against a *valid* key shape
 * (401/403) also switch — free pools reject expired keys per-model sometimes —
 * but once a single delta has streamed, the attempt is committed (the UI has
 * partial text; swapping engines mid-sentence would corrupt the stream).
 */
export function isRetriableError(e) {
  if (typeof e?.status === "number") {
    return e.status === 401 || e.status === 402 || e.status === 403 || e.status === 404 || e.status === 408 || e.status === 429 || e.status >= 500;
  }
  return e instanceof TypeError; // fetch itself failed: DNS/refused/aborted network
}

/**
 * Walk an SSE body, yielding whatever `extract(parsedJson)` returns for each
 * `data:` line. Tolerant of chunks splitting lines mid-way (the usual SSE
 * hazard) and of providers that omit the terminal `data: [DONE]`.
 */
export async function* sseDeltas(res, extract) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue; // partial line fragment — the envelope parsers absorb noise
        }
        const text = extract(obj);
        if (typeof text === "string" && text) yield text;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** The model chain for a request: an explicit model wins; blank/"auto" walks
 * the provider's free-first list; providers with no free tier use their
 * default. Custom endpoints require a named model (auto-pull may fetch it). */
export function attemptModels({ spec, model }) {
  const want = (model ?? "").trim();
  if (want && want !== "auto") return [want];
  const chain = [...(spec.freeModels ?? [])];
  if (chain.length === 0 && spec.defaultModel) chain.push(spec.defaultModel);
  if (chain.length === 0 && want) chain.push(want);
  return chain;
}

async function* openaiStream({ spec, model, apiKey, baseUrl, prompt, signal, fetchFn }) {
  const root = (baseUrl || spec.baseUrl || "").replace(/\/+$/, "");
  if (!root) throw new Error("custom provider needs a base URL");
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`; // local servers need none
  const res = await fetchFn(`${root}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  if (!res.ok) throw await providerError(res, fetchFn);
  yield* sseDeltas(res, (o) => o?.choices?.[0]?.delta?.content);
}

async function* geminiStream({ spec, model, apiKey, prompt, signal, fetchFn }) {
  const res = await fetchFn(
    `${spec.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Live-web grounding for AI search; free-tier included for flash models.
        ...(spec.searchTool ? { tools: [{ google_search: {} }] } : {}),
      }),
      signal,
    },
  );
  if (!res.ok) throw await providerError(res, fetchFn);
  yield* sseDeltas(
    res,
    (o) => (o?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("") || undefined,
  );
}

/**
 * Stream a single user turn with ONE model. Yields string deltas; throws
 * Error (with .status) carrying the provider's status + a bounded body
 * snippet on non-2xx. `baseUrl` overrides the registry root (custom endpoints).
 */
export async function* streamChat({ provider, model, apiKey, baseUrl, prompt, signal, fetchFn = fetch }) {
  const spec = providerSpec(provider);
  if (!spec) throw new Error(`unknown provider '${provider}'`);
  if (!apiKey?.trim() && !spec.optionalKey) throw new Error("no API key stored for this provider");
  const args = {
    spec,
    model: model || spec.defaultModel,
    apiKey: (apiKey ?? "").trim(),
    baseUrl,
    prompt,
    signal,
    fetchFn,
  };
  if (spec.wire === "gemini") yield* geminiStream(args);
  else yield* openaiStream(args);
}

/**
 * Ollama-flavoured custom endpoints (localhost:11434/v1, LM Studio, …) can
 * fetch a missing model themselves. Best effort: POST the OpenAI root's
 * sibling /api/pull, retry once if it accepts. Anything else → no pull.
 */
async function tryAutoPullModel({ spec, baseUrl, model, fetchFn }) {
  if (spec.id !== "custom") return false;
  const root = (baseUrl || "").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  if (!root) return false;
  try {
    const res = await fetchFn(`${root}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
    });
    return !!res.ok;
  } catch {
    return false;
  }
}

/**
 * Auto-switching stream: walks attemptModels() free-first, switching on any
 * retriable failure that happens BEFORE the first delta. The first yielded
 * delta commits the attempt (the UI already shows its text). `onSwitch` lets
 * routes narrate a hop into the trace ("[switched to …]"). For custom
 * endpoints a 404 first tries an Ollama-style auto-pull of the same model.
 */
export async function* streamChatWithFallback({
  provider,
  model,
  apiKey,
  baseUrl,
  prompt,
  signal,
  fetchFn = fetch,
  onSwitch,
}) {
  const spec = providerSpec(provider);
  if (!spec) throw new Error(`unknown provider '${provider}'`);
  const queue = attemptModels({ spec, model });
  if (queue.length === 0) throw new Error("custom provider needs a model name");
  const pulled = new Set();
  let lastErr = null;
  while (queue.length > 0) {
    const m = queue.shift();
    const gen = streamChat({ provider, model: m, apiKey, baseUrl, prompt, signal, fetchFn });
    let first;
    try {
      first = await gen.next();
    } catch (e) {
      lastErr = e;
      const gone = typeof e?.status === "number" && e.status === 404;
      if (gone && !pulled.has(m) && (await tryAutoPullModel({ spec, baseUrl, model: m, fetchFn }))) {
        pulled.add(m);
        queue.unshift(m); // pull accepted — retry the same model first
        onSwitch?.(m, e, "pulled");
        continue;
      }
      if (!isRetriableError(e) || queue.length === 0) throw e;
      onSwitch?.(m, e, "switch");
      continue;
    }
    if (!first.done) {
      yield first.value;
      yield* gen; // committed — later errors propagate, no mid-stream swap
    }
    return;
  }
  throw lastErr ?? new Error("no model succeeded");
}

/** Small blocking helper for the Config page's "Test key" button. */
export async function probeChat({ provider, model, apiKey, baseUrl, fetchFn = fetch }) {
  let sample = "";
  for await (const d of streamChatWithFallback({
    provider,
    model,
    apiKey,
    baseUrl,
    prompt: "Reply with exactly the single word: ready",
    fetchFn,
  })) {
    sample += d;
    if (sample.length > 200) break;
  }
  return sample.trim() || "(empty reply)";
}
