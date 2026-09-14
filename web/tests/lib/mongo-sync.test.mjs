// Tests for the MongoDB sync layer (web/src/lib/mongo-sync.mjs) — pure logic
// against a fake collection + temp dirs; no real cluster involved.
//
// Run:  node --test tests/lib/mongo-sync.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createMongoSync,
  walkTracked,
  encodeContent,
  decodeContent,
  sha256,
  isTrackedPath,
  isSkippedName,
} from "../../src/lib/mongo-sync.mjs";

/** In-memory stand-in for the Mongo collection (the exact subset used). */
function fakeCollection(seed = []) {
  const docs = new Map(seed.map((d) => [d.path, { ...d, _id: d.path }]));
  return {
    docs,
    find: () => ({ toArray: async () => [...docs.values()].map((d) => ({ ...d })) }),
    updateOne: async (filter, update, opts) => {
      assert.ok(opts?.upsert, "test fake only models upserts");
      const prev = docs.get(filter._id) || {};
      docs.set(filter._id, { ...prev, ...update.$set, _id: filter._id });
      return { upsertedCount: prev._id ? 0 : 1 };
    },
    deleteOne: async (filter) => {
      const had = docs.delete(filter._id);
      return { deletedCount: had ? 1 : 0 };
    },
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mongo-sync-test-"));
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function mongoDoc(rel, content) {
  const buf = Buffer.from(content, "utf8");
  const { content: encoded, encoding } = encodeContent(buf);
  return { path: rel, content: encoded, encoding, sha256: sha256(buf), size: buf.length };
}

test("pull seeds an empty checkout from Mongo, and only tracked paths", async () => {
  const root = tmpRoot();
  const collection = fakeCollection([
    mongoDoc("data/pipeline.md", "| a tracker |\n"),
    mongoDoc("reports/001-acme.md", "# report"),
    mongoDoc("cv.md", "# me"),
    // Hostile/irrelevant docs that must NOT materialize:
    { path: "../evil.md", content: "x", encoding: "utf8", sha256: "e", size: 1 },
    { path: "server.js", content: "x", encoding: "utf8", sha256: "e", size: 1 },
    { path: "config/plugins.yml", content: "toggles: []", encoding: "utf8", sha256: "e", size: 1 },
  ]);
  const sync = createMongoSync({ root, collection });
  const res = await sync.pull();
  assert.equal(res.pulled, true);
  // 4 of 6 docs restored: the two hostile/irrelevant ones are skipped, and
  // config/plugins.yml counts — it's a tracked personal file.
  assert.equal(res.files, 4);
  assert.equal(fs.readFileSync(path.join(root, "data/pipeline.md"), "utf8"), "| a tracker |\n");
  assert.equal(fs.readFileSync(path.join(root, "reports/001-acme.md"), "utf8"), "# report");
  assert.equal(fs.readFileSync(path.join(root, "cv.md"), "utf8"), "# me");
  assert.equal(fs.existsSync(path.join(root, "..", "evil.md")), false);
  assert.equal(fs.existsSync(path.join(root, "server.js")), false);
  // tracked FILES are restored too (config/plugins.yml is in the list):
  assert.equal(fs.readFileSync(path.join(root, "config/plugins.yml"), "utf8"), "toggles: []");
});

test("a fresh clone (only repo scaffolding) still counts as empty and seeds", async () => {
  // The Render deploy bug: every fresh clone ships writing-samples/README.md
  // and interview-prep/sessions/README.md inside the tracked dirs, which used
  // to trip the "checkout not empty" guard and skip the Mongo seed pull.
  const root = tmpRoot();
  writeFile(root, "writing-samples/README.md", "system-owned");
  writeFile(root, "interview-prep/sessions/README.md", "system-owned");
  writeFile(root, "data/.gitkeep", "");
  const collection = fakeCollection([
    mongoDoc("data/pipeline.md", "| tracker |"),
    mongoDoc("writing-samples/README.md", "stale cloud copy of scaffolding"),
  ]);
  const sync = createMongoSync({ root, collection });
  const res = await sync.pull();
  assert.equal(res.pulled, true);
  assert.equal(res.files, 1); // only the user's file; scaffolding untouched
  assert.equal(fs.readFileSync(path.join(root, "data/pipeline.md"), "utf8"), "| tracker |");
  assert.equal(
    fs.readFileSync(path.join(root, "writing-samples/README.md"), "utf8"),
    "system-owned",
  );
});

test("seed mode never clobbers a checkout that already has data", async () => {
  const root = tmpRoot();
  writeFile(root, "cv.md", "local truth");
  const collection = fakeCollection([mongoDoc("cv.md", "cloud copy")]);
  const sync = createMongoSync({ root, collection });
  const res = await sync.pull();
  assert.equal(res.pulled, false);
  assert.match(res.reason, /not empty/);
  assert.equal(fs.readFileSync(path.join(root, "cv.md"), "utf8"), "local truth");
});

test("forced pull overwrites local files with the cloud copy", async () => {
  const root = tmpRoot();
  writeFile(root, "cv.md", "local truth");
  const collection = fakeCollection([mongoDoc("cv.md", "cloud copy")]);
  const sync = createMongoSync({ root, collection });
  const res = await sync.pull({ force: true });
  assert.equal(res.pulled, true);
  assert.equal(fs.readFileSync(path.join(root, "cv.md"), "utf8"), "cloud copy");
});

test("flush upserts new and changed files, leaves unchanged ones alone", async () => {
  const root = tmpRoot();
  const collection = fakeCollection();
  const sync = createMongoSync({ root, collection });
  await sync.pull(); // empty store, empty checkout

  writeFile(root, "data/pipeline.md", "v1");
  writeFile(root, "cv.md", "cv v1");
  const first = await sync.flush();
  assert.equal(first.upserted, 2);
  assert.equal(collection.docs.get("data/pipeline.md").content, "v1");
  assert.equal(collection.docs.get("cv.md").sha256, sha256(Buffer.from("cv v1")));

  // Nothing changed → nothing written.
  const second = await sync.flush();
  assert.equal(second.upserted, 0);

  // Mutate one file → only that one is upserted.
  fs.writeFileSync(path.join(root, "data/pipeline.md"), "v2");
  const third = await sync.flush();
  assert.equal(third.upserted, 1);
  assert.equal(collection.docs.get("data/pipeline.md").content, "v2");
});

test("flush skips scaffolding, scratch files and oversize files", async () => {
  const root = tmpRoot();
  const collection = fakeCollection();
  const sync = createMongoSync({ root, collection, maxFileBytes: 10 });
  await sync.pull();
  writeFile(root, "data/.gitkeep", "");
  writeFile(root, "data/pipeline.md.tmp-123-abc", "scratch");
  writeFile(root, "reports/001.md.bak-2026", "backup");
  writeFile(root, "data/huge.md", "x".repeat(11));
  writeFile(root, "data/ok.md", "fine");
  const res = await sync.flush();
  assert.equal(res.upserted, 1);
  assert.deepEqual([...collection.docs.keys()], ["data/ok.md"]);
});

test("flush deletes remote orphans only after a real pull", async () => {
  // After seeding from Mongo, a file deleted locally also leaves Mongo.
  const root = tmpRoot();
  const collection = fakeCollection([mongoDoc("data/pipeline.md", "v1"), mongoDoc("cv.md", "me")]);
  const sync = createMongoSync({ root, collection });
  await sync.pull();
  fs.rmSync(path.join(root, "cv.md"));
  const res = await sync.flush();
  assert.equal(res.deleted, 1);
  assert.equal(collection.docs.has("cv.md"), false);
  assert.equal(collection.docs.has("data/pipeline.md"), true);
});

test("flush keeps remote orphans when the seed was skipped", async () => {
  // Local checkout had its own data, pull was skipped: Mongo may legitimately
  // hold files this checkout doesn't know about — never delete them.
  const root = tmpRoot();
  writeFile(root, "cv.md", "local truth");
  const collection = fakeCollection([mongoDoc("data/pipeline.md", "cloud only")]);
  const sync = createMongoSync({ root, collection });
  await sync.pull(); // skipped: checkout not empty
  const res = await sync.flush();
  assert.equal(res.deleted, 0);
  assert.equal(collection.docs.has("data/pipeline.md"), true);
  assert.equal(collection.docs.get("cv.md").content, "local truth");
});

test("binary content round-trips through base64; text stays utf8", () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x80, 0x7f]); // not valid utf8
  const enc = encodeContent(bytes);
  assert.equal(enc.encoding, "base64");
  assert.ok(decodeContent(enc).equals(bytes));

  const text = Buffer.from("# CV — ünïcodé ✓\n", "utf8");
  const encText = encodeContent(text);
  assert.equal(encText.encoding, "utf8");
  assert.equal(decodeContent(encText).toString("utf8"), "# CV — ünïcodé ✓\n");
});

test("walkTracked covers nested dirs + root files, dedupes, skips noise and scaffolding", () => {
  const root = tmpRoot();
  writeFile(root, "data/offers/offer-1.md", "offer");
  writeFile(root, "data/parser-output/ashby/x.json", "{}");
  writeFile(root, "data/.gitkeep", "");
  writeFile(root, "cv.md", "cv");
  writeFile(root, "untracked/notes.md", "nope");
  writeFile(root, "writing-samples/README.md", "scaffolding");
  const rels = walkTracked(root).map((f) => f.rel).sort();
  assert.deepEqual(rels, [
    "cv.md",
    "data/offers/offer-1.md",
    "data/parser-output/ashby/x.json",
  ]);
});

test("isTrackedPath / isSkippedName boundaries", () => {
  assert.equal(isTrackedPath("cv.md"), true);
  assert.equal(isTrackedPath("data/pipeline.md"), true);
  assert.equal(isTrackedPath("config/profile.yml"), true);
  assert.equal(isTrackedPath("server.js"), false);
  assert.equal(isTrackedPath("../evil.md"), false);
  assert.equal(isTrackedPath(""), false);
  assert.equal(isSkippedName(".gitkeep"), true);
  assert.equal(isSkippedName("pipeline.md.tmp-1-x"), true);
  assert.equal(isSkippedName("001.md.bak-2026"), true);
  assert.equal(isSkippedName("pipeline.md"), false);
});
