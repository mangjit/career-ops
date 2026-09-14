// ai-providers.mjs — the key-based AI engines the Config page offers.
//
// Client-safe on purpose (NO node imports): the Config form renders this
// list in the browser while the server routes use the same registry to
// talk to the chosen provider, so labels/defaults can never drift.
//
// Two wires cover the whole field:
//   "openai" — OpenAI-compatible /chat/completions (OpenRouter, Groq,
//              NVIDIA NIM, OpenAI itself, and any compatible gateway).
//   "gemini" — Google's native generateContent REST, with the google_search
//              server tool so AI search can actually look at the live web.

export const AI_PROVIDERS = [
  {
    id: "google",
    label: "Google (Gemini)",
    wire: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    // 2.5-flash/-lite were deprecated 2026-06/07 (see gemini-eval.mjs table) —
    // the 3.x flash line is the free-tier current.
    defaultModel: "gemini-3.6-flash",
    // Free-tier chain, best-first: "auto" walks it, switching on failure.
    freeModels: ["gemini-3.6-flash", "gemini-3.5-flash"],
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/app/apikey",
    searchTool: true, // models ground answers in live Google Search results
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    wire: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    // The :free pool rotates; auto-switching is the point of the chain.
    freeModels: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemma-3-27b-it:free",
      "mistralai/mistral-7b-instruct:free",
      "openrouter/auto",
    ],
    keyHint: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq",
    wire: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    freeModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemma2-9b-it"],
    keyHint: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    wire: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    freeModels: [
      "meta/llama-3.3-70b-instruct",
      "meta/llama-3.1-8b-instruct",
      "mistralai/mixtral-8x7b-instruct-v0.1",
    ],
    keyHint: "nvapi-…",
    keyUrl: "https://build.nvidia.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    wire: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    freeModels: [], // no free tier — auto falls back to defaultModel
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "custom",
    label: "Custom / local",
    wire: "openai",
    baseUrl: "", // supplied by the user: any OpenAI-compatible endpoint
    defaultModel: "",
    freeModels: [], // auto = the configured model; missing local models get pulled
    keyHint: "optional for local servers",
    keyUrl: null,
    optionalKey: true, // Ollama/LM Studio/vLLM usually need no auth
  },
];

export function providerSpec(id) {
  return AI_PROVIDERS.find((p) => p.id === id) ?? null;
}
