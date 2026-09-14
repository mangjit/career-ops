// mongo-sync.mjs — opt-in MongoDB-backed durability for the file-first data.
//
// career-ops is file-first: the CLI and the web app read and write plain files
// under the checkout (data/, reports/, config/, cv.md…). That model is what
// makes it auditable and local-first, but on an ephemeral host (e.g. a Render
// web service, whose filesystem is wiped on every redeploy) those files would
// vanish. This module lets a MongoDB (e.g. a free Atlas M0 cluster) stand in
// for a mounted disk as the durable copy:
//
//   - At boot (web/src/instrumentation.ts): pull the tracked files out of
//     Mongo into the checkout. Seed mode (default) only writes when the
//     checkout has no tracked files at all, so a local checkout with real
//     data is never clobbered by the cloud copy (CAREER_OPS_MONGO_PULL=always
//     overrides).
//   - In the background: diff the tracked files against the last known
//     sha256 hashes and upsert whatever changed, so a redeploy loses at most
//     one sync interval of work.
//
// Everything is dependency-injected (root + collection + options) so the
// logic is unit-testable with a fake collection and a temp dir — no real
// cluster needed. The `mongodb` driver is imported lazily, only when
// MONGODB_URI is set, so local-first installs pay nothing.
//
// Single-instance by design: two web servers syncing the same collection
// concurrently would race on last-write-wins. Run one instance.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_DB = "career-ops";
export const DEFAULT_COLLECTION = "files";
export const DEFAULT_SYNC_INTERVAL_MS = 30_000;
export const MIN_SYNC_INTERVAL_MS = 5_000;
// MongoDB's 16 MB document cap minus headroom for the base64 expansion (+33%)
// and envelope fields — a PDF CV stays well under this.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

// Personal, gitignored state — exactly the files a fresh clone is missing.
// (Verify against .gitignore; system-owned files like */README.md and
// .gitkeep stay out of the store.)
export const DEFAULT_TRACKED_DIRS = [
  "data",
  "reports",
  "jds",
  "output",
  "interview-prep",
  "writing-samples",
];
export const DEFAULT_TRACKED_FILES = [
  "cv.md",
  "article-digest.md",
  "voice-dna.md",
  "portals.yml",
  "modes/_profile.md",
  "modes/_custom.md",
  "modes/_brief.md",
  "config/profile.yml",
  "config/cv-facts.json",
  "config/benchmarks.yml",
  "config/plugins.yml",
  "config/local-paths.txt",
  "config/ai-keys.json", // key-based AI engine (web Config) — survives redeploys
];

// Repo-owned scaffolding that git tracks INSIDE the tracked dirs (verify with
// `git ls-files data reports jds output interview-prep writing-samples`).
// Every fresh clone has these, so they are never user data: they must not be
// synced to/from Mongo, and — critically — they must not make a fresh deploy
// look like a "checkout with data" (that skips the seed pull and the user's
// Mongo data never gets restored — the Render deploy bug this list closes).
export const SCAFFOLD_PATHS = new Set([
  "writing-samples/README.md",
  "interview-prep/sessions/README.md",
]);

/** Mongo keys always use forward slashes, whatever the host OS. */
export function slash(p) {
  return p.split(path.sep).join("/");
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Repo scaffolding and atomicWrite scratch/backup files stay out of Mongo. */
export function isSkippedName(name) {
  return (
    name === ".gitkeep" ||
    name === "node_modules" ||
    name === ".git" ||
    name === ".next" ||
    name.includes(".tmp-") ||
    name.includes(".bak-")
  );
}

/** Is this relative path inside the tracked surface at all? */
export function isTrackedPath(rel, opts = {}) {
  const { trackedDirs = DEFAULT_TRACKED_DIRS, trackedFiles = DEFAULT_TRACKED_FILES } = opts;
  const p = slash(rel);
  if (!p || p.includes("..")) return false;
  if (trackedFiles.includes(p)) return true;
  return trackedDirs.some((d) => p === d || p.startsWith(`${d}/`));
}

/**
 * UTF-8 when the bytes round-trip cleanly (readable in Atlas), base64
 * otherwise (PDFs, images). The `encoding` field makes decode unambiguous.
 */
export function encodeContent(buf) {
  const asText = buf.toString("utf8");
  if (Buffer.from(asText, "utf8").equals(buf)) return { content: asText, encoding: "utf8" };
  return { content: buf.toString("base64"), encoding: "base64" };
}

export function decodeContent(doc) {
  return doc.encoding === "base64"
    ? Buffer.from(doc.content ?? "", "base64")
    : Buffer.from(doc.content ?? "", "utf8");
}

/**
 * Walk the tracked surface under `root`. Returns `{ rel, abs }` — rel is the
 * slash-normalized Mongo key. Tracked files that don't exist are just absent.
 */
export function walkTracked(root, opts = {}) {
  const { trackedDirs = DEFAULT_TRACKED_DIRS, trackedFiles = DEFAULT_TRACKED_FILES } = opts;
  const found = [];
  for (const dir of trackedDirs) {
    const base = path.join(root, dir);
    let st;
    try {
      st = fs.statSync(base);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const stack = [base];
    while (stack.length > 0) {
      const cur = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (isSkippedName(e.name)) continue;
        const abs = path.join(cur, e.name);
        if (e.isDirectory()) {
          stack.push(abs);
        } else if (e.isFile()) {
          const rel = slash(path.relative(root, abs));
          if (SCAFFOLD_PATHS.has(rel)) continue;
          found.push({ rel, abs });
        }
      }
    }
  }
  for (const rel of trackedFiles) {
    const abs = path.join(root, rel);
    try {
      if (fs.statSync(abs).isFile()) found.push({ rel: slash(rel), abs });
    } catch {
      /* not present yet — fine */
    }
  }
  const seen = new Set();
  return found.filter((f) => (seen.has(f.rel) ? false : (seen.add(f.rel), true)));
}

/**
 * Build a syncer over an injected Mongo collection and checkout root.
 * The collection needs only `find().toArray()`, `updateOne(f, {$set}, {upsert})`
 * and `deleteOne(f)` — the subset the fake in the tests implements.
 */
export function createMongoSync(opts) {
  const {
    root,
    collection,
    trackedDirs = DEFAULT_TRACKED_DIRS,
    trackedFiles = DEFAULT_TRACKED_FILES,
    pullMode = "seed", // "seed" (default) or "always"
    maxFileBytes = MAX_FILE_BYTES,
    log = () => {},
  } = opts;

  const trackOpts = { trackedDirs, trackedFiles };
  const hashes = new Map(); // rel -> sha256 of the last known-good state
  let pulled = false; // a successful pull happened (hashes mirror Mongo)
  let orphanDeletes = false; // remote docs absent locally may be deleted

  async function pull({ force = false } = {}) {
    const docs = await collection.find({}).toArray();
    const local = walkTracked(root, trackOpts);
    const doPull = force || pullMode === "always" || local.length === 0;
    if (!doPull) {
      // Real data already on disk: keep it, and let the first flush push it
      // up to Mongo (the local checkout is the source of truth here). Never
      // delete remote docs we haven't seen locally — this checkout may
      // legitimately know only a subset of what Mongo holds. Deliberately do
      // NOT seed `hashes` from local files: a hash here means "known to
      // Mongo", and nothing is yet.
      pulled = true;
      orphanDeletes = false;
      return {
        pulled: false,
        files: 0,
        reason: "checkout not empty; seed skipped (set CAREER_OPS_MONGO_PULL=always to override)",
      };
    }
    let written = 0;
    for (const doc of docs) {
      if (!doc || typeof doc.path !== "string" || !isTrackedPath(doc.path, trackOpts)) continue;
      if (SCAFFOLD_PATHS.has(doc.path)) continue; // repo owns these, never restore
      const abs = path.join(root, doc.path);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const buf = decodeContent(doc);
        fs.writeFileSync(abs, buf);
        hashes.set(slash(doc.path), doc.sha256 || sha256(buf));
        written += 1;
      } catch (err) {
        log(`mongo-sync: failed to restore ${doc.path}: ${err.message}`);
      }
    }
    pulled = true;
    orphanDeletes = true;
    return { pulled: true, files: written, docs: docs.length };
  }

  async function flush() {
    const local = walkTracked(root, trackOpts);
    const seen = new Set();
    let upserted = 0;
    for (const f of local) {
      seen.add(f.rel);
      let buf;
      try {
        buf = fs.readFileSync(f.abs);
      } catch {
        continue; // vanished mid-walk
      }
      if (buf.length > maxFileBytes) {
        log(`mongo-sync: skipping ${f.rel} (${buf.length} bytes > ${maxFileBytes} limit)`);
        continue;
      }
      const h = sha256(buf);
      if (hashes.get(f.rel) === h) continue; // unchanged since last sync
      const { content, encoding } = encodeContent(buf);
      await collection.updateOne(
        { _id: f.rel },
        {
          $set: {
            path: f.rel,
            content,
            encoding,
            sha256: h,
            size: buf.length,
            updatedAt: new Date().toISOString(),
          },
        },
        { upsert: true },
      );
      hashes.set(f.rel, h);
      upserted += 1;
    }
    let deleted = 0;
    if (pulled && orphanDeletes) {
      for (const rel of [...hashes.keys()]) {
        if (seen.has(rel)) continue;
        await collection.deleteOne({ _id: rel });
        hashes.delete(rel);
        deleted += 1;
      }
    }
    return { checked: local.length, upserted, deleted };
  }

  return { pull, flush, snapshot: () => new Map(hashes) };
}

/* ------------------------- env-driven singleton -------------------------- */

/** Same resolution as web's careerOpsRoot(): CAREER_OPS_ROOT, else the checkout. */
export function resolveSyncRoot() {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  return path.resolve(process.cwd(), "..");
}

let singleton = null;
export async function getMongoSync() {
  if (singleton) return singleton;
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return null;
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.CAREER_OPS_MONGO_DB?.trim() || DEFAULT_DB);
  const collection = db.collection(
    process.env.CAREER_OPS_MONGO_COLLECTION?.trim() || DEFAULT_COLLECTION,
  );
  const pullMode = process.env.CAREER_OPS_MONGO_PULL?.trim() === "always" ? "always" : "seed";
  singleton = {
    sync: createMongoSync({
      root: resolveSyncRoot(),
      collection,
      pullMode,
      log: (m) => console.warn(m),
    }),
    client,
  };
  return singleton;
}

let background = null;
/**
 * Boot-time entry point (called from instrumentation.ts): pull once, then
 * flush on an interval and on SIGTERM (Render's redeploy signal). Never
 * throws — if Mongo is unreachable the app degrades to file-only mode.
 */
export async function startMongoSync() {
  const got = await getMongoSync();
  if (!got) return null;
  if (background) return background;
  const { sync } = got;
  const pullResult = await sync.pull();
  console.log(
    pullResult.pulled
      ? `mongo-sync: restored ${pullResult.files} of ${pullResult.docs} file(s) from MongoDB`
      : `mongo-sync: pull skipped — ${pullResult.reason}`,
  );
  const intervalMs = Math.max(
    MIN_SYNC_INTERVAL_MS,
    Number(process.env.CAREER_OPS_MONGO_SYNC_INTERVAL_MS) || DEFAULT_SYNC_INTERVAL_MS,
  );
  const timer = setInterval(() => {
    sync.flush().catch((e) => console.warn("mongo-sync: flush failed:", e.message));
  }, intervalMs);
  timer.unref?.();
  const finalFlush = () => {
    // Best effort: on redeploy Render sends SIGTERM then kills shortly after.
    // The interval already bounds the loss window to ~intervalMs.
    sync.flush().catch(() => {});
  };
  process.once("SIGTERM", finalFlush);
  background = {
    pullResult,
    stop: () => {
      clearInterval(timer);
      process.removeListener("SIGTERM", finalFlush);
      background = null;
    },
  };
  return background;
}
