// Boot-time hook for opt-in MongoDB sync (see src/lib/mongo-sync.mjs).
//
// When MONGODB_URI is set, restore the user's tracked files from MongoDB
// before the server starts answering, then keep the store in sync in the
// background. Without MONGODB_URI this is a no-op — local-first mode is
// exactly as it was.

export async function register(): Promise<void> {
  // instrumentation runs once per runtime; the sync needs the Node server.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.MONGODB_URI?.trim()) return;
  const { startMongoSync } = await import("@/lib/mongo-sync.mjs");
  try {
    await startMongoSync();
  } catch (err) {
    // Mongo being unreachable must never take the app down — degrade to
    // file-only mode and let the operator see why in the logs.
    console.error("mongo-sync: startup failed, continuing without MongoDB:", err);
  }
}
