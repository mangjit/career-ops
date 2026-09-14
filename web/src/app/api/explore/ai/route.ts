import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { assembleDedupContext } from "@/lib/core/discover";
import { readAiKeys } from "@/lib/ai-key-store.mjs";
import { streamChatWithFallback } from "@/lib/ai-client.mjs";

// AI search orchestrates modes/discover.md by running the USER'S configured CLI
// headless (CLI-agnostic, like the assistant). Web hunting is slow → generous
// budget. The agent is a PROPOSER: Write/Edit/Bash are disabled so it structurally
// cannot persist; the only writes happen when the user later ADDs a candidate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

type CodexCapabilityCacheEntry = {
  mtimeMs: number;
  size: number;
  probe: Promise<boolean>;
};

const codexCapabilityCache = new Map<string, CodexCapabilityCacheEntry>();

function readCodexHelp(binPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(output);
    };

    const appendBounded = (current: string, chunk: Buffer) =>
      (current + chunk.toString()).slice(-64_000);

    const child = spawnHeadlessCli(binPath, args, {
      env: { ...process.env, NO_COLOR: "1" },
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on("error", () => finish(""));
    child.on("close", () => finish(`${stdout}
${stderr}`));

    timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort capability-probe cleanup */
      }
      finish("");
    }, 5_000);
  });
}

function supportsSafeCodexExec(binPath: string): Promise<boolean> {
  let mtimeMs: number;
  let size: number;

  try {
    ({ mtimeMs, size } = fs.statSync(binPath));
  } catch {
    return Promise.resolve(false);
  }

  const cached = codexCapabilityCache.get(binPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.probe;
  }

  let entry: CodexCapabilityCacheEntry;
  const probe = Promise.all([
    readCodexHelp(binPath, ["--help"]),
    readCodexHelp(binPath, ["exec", "--help"]),
  ])
    // Deliberately fail closed: help/flag drift means "unsupported", never a
    // weaker Codex invocation that could bypass the required safety contract.
    .then(([globalHelp, execHelp]) =>
      globalHelp.includes("--ask-for-approval") &&
      globalHelp.includes("--search") &&
      execHelp.includes("--sandbox") &&
      execHelp.includes("read-only") &&
      execHelp.includes("--strict-config") &&
      execHelp.includes("--ignore-user-config") &&
      execHelp.includes("--ephemeral") &&
      execHelp.includes("--skip-git-repo-check") &&
      execHelp.includes("--output-last-message"),
    )
    .catch(() => false)
    .then((supported) => {
      // Only successes stay cached. A transient/negative probe retries next time,
      // but must not delete a newer entry installed after the binary changed.
      if (!supported && codexCapabilityCache.get(binPath) === entry) {
        codexCapabilityCache.delete(binPath);
      }
      return supported;
    });

  // Concurrent cold requests share the same in-flight probe. mtime+size makes a
  // Codex upgrade at the same path invalidate a previously successful result.
  entry = { mtimeMs, size, probe };
  codexCapabilityCache.set(binPath, entry);
  return probe;
}

const OUTPUT_CONTRACT = `

--- OUTPUT CONTRACT (the career-ops WEB is parsing your stream) ---
Follow modes/discover.md exactly. You are running headless for the web:
- You are a PROPOSER — never write a file (Write/Edit/Bash are disabled).
- Emit each candidate as ONE line, never inside a code fence:
  <<offer:{"url":"…","title":"…","company":"…","location":"…","source":"ai-search","why":"…","postedHint":"…","ats":"…","verification":"unconfirmed"}>>
  Valid JSON, one per line, the moment you're confident — stream them as you go.
- Between envelopes, narrate briefly (plain text) what you're searching — shown live as your reasoning.
- Be frugal (~3–6 searches, stop at a strong set). EVERY candidate is UNVERIFIED.
- Be a GENEROUS FINDER, not a judge: when a constraint (location, seniority, stage) can't be confirmed from the shallow signal, INCLUDE + flag the uncertainty in "why" — don't discard. NEVER score or judge fit; the A–F evaluation does that later, with the full JD.
- DEDUP: skip anything already known below; don't re-propose the user's existing companies.
`;

type AiKeyCfg = { provider: string; model: string; apiKey: string; baseUrl: string };

/** Canonical discover prompt for BOTH engines — one source of truth. */
function buildDiscoverPrompt(query: string): { prompt?: string; missing?: Response } {
  let mode: string;
  try {
    // Read the CANONICAL mode at request time — never a homegrown prompt.
    // Missing (older core) → graceful 400 so the Scan tab stays usable.
    mode = fs.readFileSync(path.join(careerOpsRoot(), "modes", "discover.md"), "utf8");
  } catch {
    return {
      missing: Response.json(
        { code: "MODE_MISSING", error: "AI search needs a newer career-ops — update to enable it." },
        { status: 400 },
      ),
    };
  }
  const { lines } = assembleDedupContext();
  const memory = readMemory();
  const memoryLine = memory.trim()
    ? `\n\nWHAT YOU KNOW ABOUT THE USER (persistent memory):\n${memory.trim()}`
    : "";
  const knownBlock = lines.length
    ? `\n\n--- ALREADY KNOWN (dedup — do NOT propose these) ---\n${lines.join("\n")}`
    : "";
  return { prompt: `${mode}${OUTPUT_CONTRACT}${memoryLine}${knownBlock}\n\n--- USER INTENT ---\n${query}\n` };
}

/** Stream a key-provider completion into the same text response the UI parses. */
function keyEngineResponse(prompt: string, cfg: AiKeyCfg, signal: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      try {
        for await (const delta of streamChatWithFallback({
          provider: cfg.provider,
          model: cfg.model,
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          prompt,
          signal: signal ?? undefined,
          onSwitch: (m: string, e: unknown, kind: string) => {
            // Narrate hops into the same trace the UI renders for CLI runs.
            const status = (e as { status?: number } | null)?.status;
            safeEnqueue(
              kind === "pulled"
                ? `\n[auto-pull: fetching model '${m}' on your local server, retrying…]\n`
                : `\n[auto-switch: ${m} failed (${status ?? "network"}) — trying next free model…]\n`,
            );
          },
        })) {
          safeEnqueue(delta);
        }
      } catch (e) {
        // Same shape the CLI path reports transport failures in — the client's
        // envelope parser surfaces bracketed lines as trace, never as offers.
        safeEnqueue(`\n[AI key error: ${e instanceof Error ? e.message : "request failed"}]\n`);
      }
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream);
}

export async function POST(req: Request) {
  let body: { query?: string; cliId?: string; engine?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const query = (body.query || "").trim();
  const cliId = body.cliId;
  const engine = body.engine === "key" ? "key" : "cli";
  if (!query || (engine === "cli" && !cliId))
    return Response.json({ error: "query and cliId required" }, { status: 400 });

  if (engine === "key") {
    // Key-based engine (Config → "Paste an AI key"): same canonical mode +
    // dedup context, streamed from the provider instead of a spawned CLI.
    const cfg = readAiKeys(careerOpsRoot());
    if (!cfg)
      return Response.json(
        {
          code: "KEY_MISSING",
          error: "No AI key configured — open Config, pick “Paste an AI key”, and save one.",
        },
        { status: 400 },
      );
    const built = buildDiscoverPrompt(query);
    if (built.missing) return built.missing;
    return keyEngineResponse(built.prompt!, cfg, req.signal);
  }

  const resolved = resolveCli(cliId!);
  if (!resolved) return Response.json({ error: `CLI '${cliId}' not found on this machine` }, { status: 404 });
  const { spec, binPath } = resolved;

  const built = buildDiscoverPrompt(query);
  if (built.missing) return built.missing;
  const prompt = built.prompt!;

  const isClaude = cliId === "claude";
  const isCodex = cliId === "codex";

  if (isCodex && !(await supportsSafeCodexExec(binPath))) {
    return Response.json(
      {
        code: "CODEX_UNSUPPORTED",
        error:
          "Codex CLI does not support the required read-only execution flags. Update Codex and try again.",
      },
      { status: 400 },
    );
  }

  // The complete mode, memory and dedup context are embedded in `prompt`.
  // Codex runs in an empty temporary cwd and writes only its final assistant
  // response to a dedicated file. Its normal console transcript includes the
  // full prompt and must never be forwarded to the Web UI.
  let childCwd: string;

  if (isCodex) {
    try {
      childCwd = fs.mkdtempSync(
        path.join(os.tmpdir(), "career-ops-codex-"),
      );
    } catch {
      return Response.json(
        {
          code: "CODEX_TEMP_DIR_FAILED",
          error: "AI search could not create an isolated Codex workspace.",
        },
        { status: 400 },
      );
    }
  } else {
    childCwd = careerOpsRoot();
  }

  const codexResultFile = isCodex
    ? path.join(childCwd, "final-response.txt")
    : undefined;

  const args = isClaude
    ? [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,WebFetch,WebSearch,Glob,Grep", // WebSearch ADDED vs the read-only assistant
        "--disallowedTools",
        "Bash,Write,Edit,NotebookEdit,Task", // proposer-not-writer, by construction
      ]
    : isCodex
      ? [
          "--ask-for-approval",
          "never",
          "--search",
          "exec",
          "--strict-config",
          "--ignore-user-config",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--skip-git-repo-check",
          "--output-last-message",
          codexResultFile!,
          prompt,
        ]
      : spec.args(prompt);

  // POSIX detached children become process-group leaders. Keeping stdio
  // piped means Node still tracks the Codex process normally.
  const useCodexProcessGroup =
    isCodex && process.platform !== "win32";

  const child = spawnHeadlessCli(binPath, args, {
    cwd: childCwd,
    env: process.env,
    detached: useCodexProcessGroup,
  });

  const cleanupChildCwd = () => {
    if (!isCodex) return;
    try {
      fs.rmSync(childCwd, { recursive: true, force: true });
    } catch {
      /* best-effort temporary-directory cleanup */
    }
  };

  const encoder = new TextEncoder();
  // `closed` + kill timer in the OUTER scope so cancel() can flip `closed` before
  // the child's late handlers run — otherwise they enqueue onto an already-closed
  // controller and throw an uncaught "Controller is already closed" (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;

  const isCodexProcessGroupAlive = () => {
    if (!useCodexProcessGroup || !child.pid) return false;

    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const clearTerminationTimers = () => {
    if (killer) {
      clearTimeout(killer);
      killer = undefined;
    }

    // If the group leader exited but a descendant ignored SIGTERM, retain the
    // SIGKILL fallback until the remaining process group is gone.
    if (forceKill && !isCodexProcessGroupAlive()) {
      clearTimeout(forceKill);
      forceKill = undefined;
    }
  };

  const signalChild = (signal: NodeJS.Signals): boolean => {
    if (useCodexProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        /* group may already be gone; fall back to the direct child */
      }
    }

    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };

  const terminateChild = () => {
    const termSent = signalChild("SIGTERM");

    if (!isCodex || !termSent || forceKill) return;

    forceKill = setTimeout(() => {
      signalChild("SIGKILL");
      forceKill = undefined;
    }, 5_000);

    forceKill.unref?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      let codexStderr = "";
      killer = setTimeout(() => {
        terminateChild();
      }, 480_000);
      const safeClose = () => {
        if (!closed) {
          closed = true;
          clearTerminationTimers();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const safeEnqueue = (s: string): boolean => {
        if (closed || !s) return false;
        try {
          controller.enqueue(encoder.encode(s));
          return true;
        } catch {
          closed = true; // controller already closed underneath us — stop, never crash
          return false;
        }
      };
      const emit = (s: string) => {
        if (safeEnqueue(s)) emitted = true;
      };

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;

        // Codex's authoritative response is read from codexResultFile after
        // process completion. Drain but do not forward its console transcript.
        if (isCodex) return;

        if (!isClaude) {
          emit(d.toString());
          return;
        }
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
              const text = obj.event.delta?.text;
              if (typeof text === "string") emit(text);
            }
          } catch {
            /* partial / non-json line — skip */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();

        if (isCodex) {
          // Normal Codex stderr contains session metadata and the complete
          // prompt. Retain only a bounded private diagnostic signal and never
          // stream it during a successful request.
          codexStderr = (codexStderr + s).slice(-16_000);
          return;
        }

        if (/error|not found|denied|fatal/i.test(s)) {
          safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
        }
      });
      child.on("error", (e) => {
        safeEnqueue(`
[error launching ${spec.name}: ${e.message}]`);
        cleanupChildCwd();
        safeClose();
      });

      child.on("close", (code) => {
        clearTerminationTimers();

        if (closed) {
          cleanupChildCwd();
          return;
        }

        if (isCodex) {
          let finalText = "";

          try {
            if (codexResultFile && fs.existsSync(codexResultFile)) {
              finalText = fs.readFileSync(codexResultFile, "utf8").trim();
            }
          } catch {
            /* handled below as missing final output */
          }

          if (finalText) {
            emit(finalText);
          } else if (code !== 0) {
            const diagnosticText = codexStderr.trim();
            const diagnosticsCaptured = diagnosticText.length > 0;

            if (diagnosticsCaptured) {
              const lowerDiagnostics = diagnosticText.toLowerCase();
              const diagnosticMarkers = [
                "error",
                "fatal",
                "failed",
                "denied",
                "not found",
                "invalid",
                "unsupported",
              ].filter((marker) => lowerDiagnostics.includes(marker));

              // Codex stderr may contain the complete user prompt. Log only
              // bounded metadata and marker categories, never its contents.
              console.error("[Codex AI search exited without a final response]", {
                exitCode: code ?? "unknown",
                stderrBytes: Buffer.byteLength(diagnosticText, "utf8"),
                stderrLines: diagnosticText.split(/\r?\n/).length,
                diagnosticMarkers,
              });
            }

            safeEnqueue(
              `
[Codex exited with code ${code ?? "unknown"}${
                diagnosticsCaptured ? "; diagnostic output captured" : ""
              }]
`,
            );
          } else if (!emitted) {
            safeEnqueue("_(no final output from Codex)_");
          }

          cleanupChildCwd();
          safeClose();
          return;
        }

        if (!emitted) safeEnqueue("_(no output — is the CLI authenticated?)_");
        safeClose();
      });
    },
    cancel() {
      closed = true;

      if (killer) {
        clearTimeout(killer);
        killer = undefined;
      }

      terminateChild();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
