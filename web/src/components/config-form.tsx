"use client";

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  TerminalSquare,
  Terminal,
  Loader2,
  CircleDashed,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { CadenceSettings } from "@/components/followups/cadence-settings";
import { persistCliId, readSavedCliId } from "@/lib/saved-cli";
import { AI_PROVIDERS, providerSpec } from "@/lib/ai-providers.mjs";

type Cli = {
  id: string;
  name: string;
  run: string;
  url: string;
  installed: boolean;
  path: string | null;
};

type Mode = "cli" | "key" | "manual";

const STORAGE_KEY = "career-ops:config";

export function ConfigForm() {
  const [mode, setMode] = useState<Mode>("cli");
  const [clis, setClis] = useState<Cli[] | null>(null);
  const [cliId, setCliId] = useState<string>("");
  const [provider, setProvider] = useState("google");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyOnServer, setKeyOnServer] = useState<null | { masked: string }>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; text: string }>(null);
  const [logos, setLogos] = useState(true);
  const [saved, setSaved] = useState(false);

  // Load saved prefs + whether a key engine already lives on the server.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (v.mode === "cli" || v.mode === "key") setMode(v.mode);
        if (v.cliId) setCliId(v.cliId);
        if (v.provider) setProvider(v.provider);
        if (typeof v.model === "string") setModel(v.model);
        if (typeof v.baseUrl === "string") setBaseUrl(v.baseUrl);
        if (typeof v.logos === "boolean") setLogos(v.logos);
      }
    } catch {
      /* ignore */
    }
    fetch("/api/config/ai-keys")
      .then((r) => r.json())
      .then((d) => {
        if (d?.configured) {
          setKeyOnServer({ masked: d.maskedKey ?? "" });
          if (d.provider) setProvider(d.provider);
          setModel((m) => m || d.model || "");
          setBaseUrl((b) => b || d.baseUrl || "");
        }
      })
      .catch(() => {
        /* server-side store unreachable — the panel still works */
      });
  }, []);

  // Detect installed CLIs
  useEffect(() => {
    fetch("/api/clis")
      .then((r) => r.json())
      .then((d) => {
        const list: Cli[] = d.clis ?? [];
        setClis(list);
        // Highlight + persist the only installed CLI when Config was never saved.
        // Highlight-only used to look configured while jobs still read empty localStorage.
        setCliId((prev) => {
          if (prev) return prev;
          const only = list.filter((c) => c.installed);
          if (only.length !== 1) return list.find((c) => c.installed)?.id || "";
          if (!readSavedCliId()) persistCliId(only[0].id);
          return only[0].id;
        });
      })
      .catch(() => setClis([]));
  }, []);

  function save() {
    // The API key NEVER touches localStorage — it goes to the server's
    // gitignored, Mongo-synced config/ai-keys.json; the browser only keeps
    // non-secret prefs (mode/provider/model/logos).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, cliId, provider, model, baseUrl, logos }));
    const wantsServerSave =
      mode === "key" && (apiKey.trim() || providerSpec(provider)?.optionalKey);
    if (wantsServerSave) {
      fetch("/api/config/ai-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model: model || undefined, apiKey, baseUrl: baseUrl || undefined }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d?.configured) {
            setApiKey("");
            setKeyOnServer({ masked: "saved" });
          }
        })
        .catch(() => {
          /* the saved banner below still reflects local prefs */
        });
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function testKey() {
    setTesting(true);
    setTestResult(null);
    fetch("/api/config/ai-keys/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        apiKey.trim() || providerSpec(provider)?.optionalKey
          ? { provider, model: model || undefined, apiKey, baseUrl: baseUrl || undefined }
          : {},
      ),
    })
      .then((r) => r.json())
      .then((d) =>
        setTestResult(
          d?.ok
            ? { ok: true, text: `${d.provider}/${d.model} replied: “${d.sample}”` }
            : { ok: false, text: d?.error || "test failed" },
        ),
      )
      .catch(() => setTestResult({ ok: false, text: "could not reach the server" }))
      .finally(() => setTesting(false));
  }

  const installed = clis?.filter((c) => c.installed) ?? [];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Config</h1>
      <p className="mt-1 text-sm text-muted">
        Run career-ops on your own AI, right on your computer. Your CV and data never leave your machine.
      </p>

      {/* Engine mode */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        AI Engine
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <ModeCard
          active={mode === "cli"}
          onClick={() => setMode("cli")}
          icon={Terminal}
          title="Use an AI tool you have"
          hint="Recommended"
        />
        <ModeCard
          active={mode === "key"}
          onClick={() => setMode("key")}
          icon={KeyRound}
          title="Paste an AI key"
          hint="Gemini · OpenRouter · Groq · NIM"
        />
        <ModeCard
          active={mode === "manual"}
          onClick={() => setMode("manual")}
          icon={TerminalSquare}
          title="No setup needed"
          hint="Coming soon"
          disabled
        />
      </div>

      <div className="mt-6">
        {mode === "cli" && (
          <div>
            <p className="mb-1 text-sm text-muted">
              career-ops uses an AI tool you already have — signed in, your own usage, nothing to paste.
            </p>
            <p className="mb-3 text-xs text-faint">Works with Claude Code, Codex, OpenCode and more — free ones work great.</p>
            {clis === null ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Checking what&apos;s on your computer…
              </div>
            ) : installed.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                No AI tool yet? Free options like <span className="text-foreground">OpenCode</span> with Qwen or GLM work great.{" "}
                <a href="https://career-ops.org/docs/free-ai-engine" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">
                  Get one free <ExternalLink className="size-3" />
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                {clis.map((c) => {
                  const selected = c.id === cliId;
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors",
                        selected
                          ? "border-brand/50 bg-brand-soft"
                          : c.installed
                            ? "border-border bg-surface/50"
                            : "border-border/60 bg-surface/20",
                      )}
                    >
                      {c.installed ? (
                        <Check className="size-4 shrink-0 text-emerald-400" />
                      ) : (
                        <CircleDashed className="size-4 shrink-0 text-faint" />
                      )}
                      <button
                        type="button"
                        disabled={!c.installed}
                        onClick={() => setCliId(c.id)}
                        className={cn(
                          "flex flex-1 items-center gap-2 text-left max-sm:min-h-[44px]",
                          c.installed ? "" : "cursor-default",
                        )}
                      >
                        <span
                          className={cn(
                            "font-medium",
                            selected ? "text-foreground" : c.installed ? "" : "text-muted",
                          )}
                        >
                          {c.name}
                        </span>
                        <span className="font-mono text-xs text-faint">{c.run}</span>
                      </button>
                      {c.installed ? (
                        <span className="hidden max-w-[40%] shrink-0 truncate text-xs text-faint sm:block">
                          {c.path}
                        </span>
                      ) : (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex shrink-0 items-center justify-center gap-1 text-xs text-brand hover:underline max-sm:min-h-[44px]"
                        >
                          Install <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  );
                })}
                {installed.length === 0 && (
                  <p className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-xs text-muted">
                    No supported CLI found on your PATH. Install one (e.g. Claude Code, Gemini CLI, OpenCode) to get started.
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  Best on <span className="text-muted">Claude Code</span> (live progress, the agentic apply + AI search,
                  reliable evaluation persistence). Other CLIs work for the core flows with reduced features.
                </p>
              </div>
            )}
          </div>
        )}

        {mode === "key" && (
          <div className="space-y-5">
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Provider
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {AI_PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProvider(p.id);
                      setModel("");
                      setTestResult(null);
                    }}
                    className={cn(
                      "rounded-xl border px-4 py-2.5 text-left text-sm transition-colors",
                      provider === p.id
                        ? "border-brand/50 bg-brand-soft text-foreground"
                        : "border-border bg-surface/50 text-muted hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {providerSpec(provider)?.keyUrl ? (
                <p className="mt-2 text-xs text-faint">
                  No key yet?{" "}
                  <a
                    href={providerSpec(provider)?.keyUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-brand hover:underline"
                  >
                    Get one free <ExternalLink className="size-3" />
                  </a>
                </p>
              ) : null}
            </div>
            {provider === "custom" && (
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  Base URL
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  autoComplete="off"
                  className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
                />
                <p className="mt-1 text-xs text-faint">
                  Any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, llama.cpp server, your own
                  gateway. A missing local model is auto-pulled when the server supports it (Ollama).
                </p>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={
                  provider === "custom"
                    ? "e.g. llama3.1, qwen2.5-coder (required)"
                    : (providerSpec(provider)?.defaultModel ?? "default")
                }
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
              />
              <p className="mt-1 text-xs text-faint">
                Blank = <span className="text-muted">auto</span>: free-first model chain, switching
                automatically when a model is rate-limited, gone or down
                {providerSpec(provider)?.freeModels?.length
                  ? ` (${providerSpec(provider)!.freeModels.join(" → ")})`
                  : ""}
                .
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Paste an AI key
              </label>
              <p className="mb-2 text-xs text-faint">
                {keyOnServer
                  ? `A key is saved on the server (${keyOnServer.masked}) — paste a new one to replace it.`
                  : "Bring a key from your provider; it powers AI search on any host, including a Render deploy."}
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={providerSpec(provider)?.keyHint ?? "sk-…"}
                  autoComplete="off"
                  className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
                />
                <button
                  type="button"
                  onClick={testKey}
                  disabled={testing}
                  className="shrink-0 rounded-xl border border-border bg-surface/50 px-4 py-2 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
                >
                  {testing ? "Testing…" : "Test key"}
                </button>
              </div>
              {testResult ? (
                <p className={cn("mt-2 text-xs", testResult.ok ? "text-emerald-400" : "text-red-400")}>
                  {testResult.text}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-faint">
                Stored server-side in <span className="font-mono">config/ai-keys.json</span> — gitignored and
                Mongo-synced, never in this browser. Gemini is grounded with live Google Search; the others
                propose from model knowledge (candidates stay unverified until scanned).
              </p>
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
            The easiest way in — no keys, nothing to set up. On the roadmap.
          </div>
        )}
      </div>

      {/* Appearance / privacy */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        Appearance
      </label>
      <button
        type="button"
        onClick={() => setLogos((v) => !v)}
        className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-surface/50 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">Company logos</span>
          <span className="mt-0.5 block text-xs text-faint">
            Show each company&apos;s real logo. Fetched once through your local server and cached on
            disk — only the employer domain is sent to a third party. Off = colored monograms only.
          </span>
        </span>
        <span
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors",
            logos ? "bg-brand" : "bg-surface-hover",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform",
              logos ? "translate-x-[1.375rem]" : "translate-x-0.5",
            )}
          />
        </span>
      </button>

      <CadenceSettings />

      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
        >
          {saved ? <Check className="size-4" /> : null}
          {saved ? "Saved" : "Save config"}
        </button>
        <span className="text-xs text-faint">Local-first · on our roadmap</span>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-surface/30 opacity-55"
          : active
            ? "border-brand/50 bg-brand-soft"
            : "border-border bg-surface/50 hover:bg-surface-hover",
      )}
    >
      <Icon className={cn("size-4", active && !disabled ? "text-brand" : "text-muted")} />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs text-faint">{hint}</span>
    </button>
  );
}
