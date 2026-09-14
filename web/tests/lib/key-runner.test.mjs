// Tests for the key-engine → core runner mapping (web/src/lib/key-runner.mjs).
//
// Run:  node --test tests/lib/key-runner.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeyRunner, compatChatUrl } from "../../src/lib/key-runner.mjs";

const ROOT = "/checkout";
const EXEC = "/usr/bin/node";

test("compatChatUrl: Gemini goes through the official OpenAI bridge", () => {
  assert.equal(
    compatChatUrl({ provider: "google" }),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
});

test("compatChatUrl: native OpenAI-wire providers and custom base URLs", () => {
  assert.equal(compatChatUrl({ provider: "groq" }), "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(
    compatChatUrl({ provider: "custom", baseUrl: "http://localhost:11434/v1/" }),
    "http://localhost:11434/v1/chat/completions",
  );
});

test("buildKeyRunner: argv runs the core runner, env carries creds + pinned model", () => {
  const run = buildKeyRunner({
    cfg: { provider: "nvidia", model: "", apiKey: "nvapi-x", baseUrl: "" },
    root: ROOT,
    input: "https://acme.example/jobs/1",
    execPath: EXEC,
  });
  assert.equal(run.binPath, EXEC);
  assert.deepEqual(run.args, [`${ROOT}/openrouter-runner.mjs`, "evaluate", "https://acme.example/jobs/1"]);
  assert.equal(run.env.OPENROUTER_API_KEY, "nvapi-x");
  assert.equal(run.env.OPENROUTER_API_URL, "https://integrate.api.nvidia.com/v1/chat/completions");
  // blank model → free-first chain head, pinned so OR list endpoint is skipped
  assert.equal(run.env.CAREER_OPS_MODEL, "meta/llama-3.3-70b-instruct");
  assert.match(run.name, /nvidia/);
});

test("buildKeyRunner: explicit model wins; Gemini defaults are the 3.x line", () => {
  const explicit = buildKeyRunner({
    cfg: { provider: "groq", model: "gemma2-9b-it", apiKey: "k", baseUrl: "" },
    root: ROOT,
    input: "u",
    execPath: EXEC,
  });
  assert.equal(explicit.env.CAREER_OPS_MODEL, "gemma2-9b-it");

  const gem = buildKeyRunner({
    cfg: { provider: "google", model: "", apiKey: "AIza", baseUrl: "" },
    root: ROOT,
    input: "u",
    execPath: EXEC,
  });
  assert.equal(gem.env.CAREER_OPS_MODEL, "gemini-3.6-flash"); // not the deprecated 2.5 line
  assert.equal(
    gem.env.OPENROUTER_API_URL,
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
});

test("buildKeyRunner: custom without a model is refused, unknown provider too", () => {
  assert.throws(
    () => buildKeyRunner({ cfg: { provider: "custom", model: "", apiKey: "", baseUrl: "http://x/v1" }, root: ROOT, input: "u", execPath: EXEC }),
    /model/,
  );
  assert.throws(
    () => buildKeyRunner({ cfg: { provider: "nope", model: "m", apiKey: "k", baseUrl: "" }, root: ROOT, input: "u", execPath: EXEC }),
    /unknown provider/,
  );
});
