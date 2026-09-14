// Tests for the key-based AI engine: SSE streaming over both provider wires,
// error surfacing, key masking, and the server-side key store. Fetch-injected;
// no network, no cluster.
//
// Run:  node --test tests/lib/ai-client.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  streamChat,
  streamChatWithFallback,
  attemptModels,
  isRetriableError,
  maskedKey,
} from "../../src/lib/ai-client.mjs";
import { providerSpec } from "../../src/lib/ai-providers.mjs";
import { readAiKeys, writeAiKeys, deleteAiKeys, aiKeysPath } from "../../src/lib/ai-key-store.mjs";

function sseResponse(chunks, status = 200) {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return { ok: status >= 200 && status < 300, status, body, text: async () => "quota exceeded" };
}

function recordingFetch(responder) {
  const calls = [];
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(calls.length);
    },
  };
}

const OPENAI_CHUNKS = [
  'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
  // A line split across chunk boundaries — the parser must buffer, not drop.
  'data: {"choices":[{"delta":{"cont',
  'ent":"lo"}}]}\n\ndata: [DONE]\n\n',
];

test("openai wire: streams deltas, splits lines safely, sends Bearer auth", async () => {
  const rf = recordingFetch(() => sseResponse(OPENAI_CHUNKS));
  const out = [];
  for await (const d of streamChat({
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    apiKey: "gsk_test",
    prompt: "hi",
    fetchFn: rf.fn,
  })) {
    out.push(d);
  }
  assert.equal(out.join(""), "hello");
  const call = rf.calls[0];
  assert.equal(call.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(call.init.headers.authorization, "Bearer gsk_test");
  const body = JSON.parse(call.init.body);
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].content, "hi");
});

test("gemini wire: native REST + x-goog-api-key + google_search grounding", async () => {
  const rf = recordingFetch(() =>
    sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"sea"},{"text":"rch"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"ing"}]}}]}\n\n',
    ]),
  );
  const out = [];
  for await (const d of streamChat({
    provider: "google",
    model: "gemini-2.5-flash",
    apiKey: "AIza_test",
    prompt: "find jobs",
    fetchFn: rf.fn,
  })) {
    out.push(d);
  }
  assert.equal(out.join(""), "searching");
  const call = rf.calls[0];
  assert.match(call.url, /models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(call.init.headers["x-goog-api-key"], "AIza_test");
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.equal(body.contents[0].parts[0].text, "find jobs");
});

test("non-2xx surfaces the provider status + a bounded body snippet", async () => {
  const bad = sseResponse([], 401);
  const rf = recordingFetch(() => bad);
  await assert.rejects(
    () => streamChat({ provider: "openrouter", model: "m", apiKey: "k", prompt: "p", fetchFn: rf.fn }).next(),
    (e) => /401/.test(e.message) && /quota exceeded/.test(e.message),
  );
});

test("unknown provider and missing key fail fast without any request", async () => {
  const rf = recordingFetch(() => sseResponse([]));
  await assert.rejects(
    () => streamChat({ provider: "nope", model: "m", apiKey: "k", prompt: "p", fetchFn: rf.fn }).next(),
    /unknown provider/,
  );
  await assert.rejects(
    () => streamChat({ provider: "groq", model: "m", apiKey: "  ", prompt: "p", fetchFn: rf.fn }).next(),
    /no API key/,
  );
  assert.equal(rf.calls.length, 0);
});

test("maskedKey never leaks the middle", () => {
  assert.equal(maskedKey(""), "");
  assert.equal(maskedKey("short"), "•••••");
  assert.equal(maskedKey("sk-ant-verysecret1234"), "sk-a…1234");
});

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-keys-test-"));
}

test("key store: write/read/delete roundtrip, validation, defaults", () => {
  const root = tmpRoot();
  assert.equal(readAiKeys(root), null);

  writeAiKeys(root, { provider: "nvidia", model: "", apiKey: " nvapi-x " });
  const cfg = readAiKeys(root);
  assert.equal(cfg.provider, "nvidia");
  assert.equal(cfg.model, ""); // blank = auto; attemptModels applies the default
  assert.deepEqual(attemptModels({ spec: providerSpec("nvidia"), model: cfg.model }), [
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "mistralai/mixtral-8x7b-instruct-v0.1",
  ]);
  assert.equal(cfg.apiKey, "nvapi-x"); // trimmed

  assert.throws(() => writeAiKeys(root, { provider: "nope", model: "", apiKey: "k" }), /unknown provider/);
  assert.throws(() => writeAiKeys(root, { provider: "groq", model: "", apiKey: " " }), /apiKey/);

  assert.ok(fs.existsSync(aiKeysPath(root)));
  assert.equal(deleteAiKeys(root), true);
  assert.equal(readAiKeys(root), null);
});

test("key store: garbage or keyless files read as unconfigured", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(aiKeysPath(root), "not json{");
  assert.equal(readAiKeys(root), null);
  fs.writeFileSync(aiKeysPath(root), JSON.stringify({ provider: "groq", apiKey: "" }));
  assert.equal(readAiKeys(root), null);
});

test("key store: custom provider allows empty key but requires a base URL", () => {
  const root = tmpRoot();
  assert.throws(
    () => writeAiKeys(root, { provider: "custom", model: "m", apiKey: "", baseUrl: " " }),
    /base URL/,
  );
  writeAiKeys(root, { provider: "custom", model: "", apiKey: "", baseUrl: "http://localhost:11434/v1" });
  const cfg = readAiKeys(root);
  assert.equal(cfg.provider, "custom");
  assert.equal(cfg.apiKey, ""); // local servers need no auth
  assert.equal(cfg.baseUrl, "http://localhost:11434/v1");
});

test("attemptModels: explicit wins, auto walks the free chain first", () => {
  const groq = providerSpec("groq");
  assert.deepEqual(attemptModels({ spec: groq, model: "mine" }), ["mine"]);
  assert.deepEqual(attemptModels({ spec: groq, model: "" }), groq.freeModels);
  assert.deepEqual(attemptModels({ spec: groq, model: "auto" }), groq.freeModels);
  assert.deepEqual(attemptModels({ spec: providerSpec("openai"), model: "" }), ["gpt-4o-mini"]);
  assert.deepEqual(attemptModels({ spec: providerSpec("custom"), model: "" }), []);
});

test("auto-switch: 429 on the first free model hops to the next, narrated", async () => {
  let n = 0;
  const rf = recordingFetch(() => {
    n += 1;
    if (n === 1) return sseResponse([], 429);
    return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']);
  });
  const switches = [];
  const out = [];
  for await (const d of streamChatWithFallback({
    provider: "groq",
    apiKey: "gsk_x",
    model: "",
    prompt: "p",
    fetchFn: rf.fn,
    onSwitch: (m, e, kind) => switches.push([m, kind]),
  })) {
    out.push(d);
  }
  assert.equal(out.join(""), "ok");
  assert.equal(rf.calls.length, 2);
  assert.deepEqual(switches[0], ["llama-3.3-70b-versatile", "switch"]);
  assert.match(rf.calls[1].init.body, /llama-3.1-8b-instant/); // free chain order
});

function failingAfterFirstDelta(first) {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream({
    async pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(enc.encode(first));
        return;
      }
      c.error(new Error("connection reset mid-stream"));
    },
  });
  return { ok: true, status: 200, body, text: async () => "" };
}

test("no mid-stream switch: once a delta streamed, errors propagate", async () => {
  const rf = recordingFetch(() =>
    failingAfterFirstDelta('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'),
  );
  const out = [];
  await assert.rejects(async () => {
    for await (const d of streamChatWithFallback({
      provider: "groq",
      apiKey: "gsk_x",
      model: "",
      prompt: "p",
      fetchFn: rf.fn,
    })) {
      out.push(d);
    }
  }, /connection reset/);
  assert.equal(out.join(""), "par");
  assert.equal(rf.calls.length, 1); // second model never tried
});

test("custom provider: saved base URL used, no auth header when keyless", async () => {
  const rf = recordingFetch(() => sseResponse(['data: {"choices":[{"delta":{"content":"local"}}]}\n\n']));
  const out = [];
  for await (const d of streamChatWithFallback({
    provider: "custom",
    model: "llama3.1",
    apiKey: "",
    baseUrl: "http://localhost:11434/v1",
    prompt: "p",
    fetchFn: rf.fn,
  })) {
    out.push(d);
  }
  assert.equal(out.join(""), "local");
  assert.equal(rf.calls[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(rf.calls[0].init.headers.authorization, undefined);
});

test("custom 404 auto-pulls the model Ollama-style, then retries the same model", async () => {
  const urls = [];
  const fn = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith("/api/pull")) return { ok: true, status: 200, body: null, text: async () => "" };
    const attempt = urls.filter((u) => u.endsWith("/chat/completions")).length;
    if (attempt === 1) return sseResponse(["model not found"], 404);
    return sseResponse(['data: {"choices":[{"delta":{"content":"pulled"}}]}\n\n']);
  };
  const kinds = [];
  const out = [];
  for await (const d of streamChatWithFallback({
    provider: "custom",
    model: "llama3.1",
    apiKey: "",
    baseUrl: "http://localhost:11434/v1",
    prompt: "p",
    fetchFn: fn,
    onSwitch: (m, e, k) => kinds.push(k),
  })) {
    out.push(d);
  }
  assert.equal(out.join(""), "pulled");
  assert.deepEqual(kinds, ["pulled"]);
  assert.ok(urls.some((u) => u === "http://localhost:11434/api/pull"));
});

test("isRetriableError: upstream shapes switch, random code errors don't", () => {
  assert.ok(isRetriableError({ status: 429 }));
  assert.ok(isRetriableError({ status: 404 }));
  assert.ok(isRetriableError({ status: 500 }));
  assert.ok(isRetriableError(new TypeError("fetch failed")));
  assert.ok(!isRetriableError(new Error("boom")));
  assert.ok(!isRetriableError({ status: 400 }));
});
