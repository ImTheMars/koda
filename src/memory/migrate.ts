/**
 * v2 → v3 memory migration.
 *
 * Runs automatically on first boot (gated by state KV "memory_v3_migrated").
 * 1. Backs up koda.db → koda.db.v2.bak
 * 2. Migrates learnings → semantic memories
 * 3. Migrates last 500 message pairs → episodic memories
 * 4. Embeddings happen in the background via the provider (non-blocking)
 */

import { copyFile } from "fs/promises";
import { resolve } from "path";
import { getDb, state as dbState, memories as dbMemories } from "../db.js";
import { log } from "../log.js";

const MIGRATION_KEY = "memory_v3_migrated";

export async function runV3Migration(workspaceDir: string): Promise<void> {
  if (dbState.get(MIGRATION_KEY)) return;

  log("migrate", "starting v2 → v3 memory migration");

  // Backup the database first
  const dbPath = resolve(workspaceDir, "koda.db");
  const backupPath = resolve(workspaceDir, "koda.db.v2.bak");
  try {
    await copyFile(dbPath, backupPath);
    log("migrate", "backup created: %s", backupPath);
  } catch (err) {
    log("migrate", "backup failed (continuing): %s", (err as Error).message);
  }

  const db = getDb();

  // 1. Migrate learnings → semantic memories
  let learningsMigrated = 0;
  try {
    const rows = db.query("SELECT user_id, type, content, created_at FROM learnings ORDER BY id").all() as Array<{
      user_id: string;
      type: string;
      content: string;
      created_at: string;
    }>;

    for (const row of rows) {
      const id = `mem_mig_l_${row.user_id}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
      dbMemories.insert({
        id,
        userId: row.user_id,
        sector: "semantic",
        content: row.content,
        summary: null,
        tags: JSON.stringify([row.type, "migrated-v2"]),
        sessionKey: null,
        eventAt: row.created_at,
        validUntil: null,
        strength: 0.8,
      });
      learningsMigrated++;
      // Small delay to ensure unique IDs
      await Bun.sleep(1);
    }
    log("migrate", "learnings migrated: %d", learningsMigrated);
  } catch (err) {
    log("migrate", "learnings migration skipped: %s", (err as Error).message);
  }

  // 2. Migrate last 500 message pairs → episodic memories
  let messagesMigrated = 0;
  try {
    const rows = db
      .query(
        `SELECT session_key, role, content, created_at FROM messages
         ORDER BY id DESC LIMIT 500`,
      )
      .all() as Array<{ session_key: string; role: string; content: string; created_at: string }>;

    // Group into user+assistant pairs
    const bySession: Record<string, typeof rows> = {};
    for (const row of rows) {
      if (!bySession[row.session_key]) bySession[row.session_key] = [];
      bySession[row.session_key]!.push(row);
    }

    for (const [sessionKey, msgs] of Object.entries(bySession)) {
      const userId = sessionKey.split("_").slice(1).join("_") || "owner";
      const sorted = msgs.reverse();

      for (let i = 0; i < sorted.length - 1; i++) {
        const curr = sorted[i]!;
        const next = sorted[i + 1]!;
        if (curr.role !== "user" || next.role !== "assistant") continue;

        const summary = `User: ${curr.content.slice(0, 200)}\nKoda: ${next.content.slice(0, 200)}`;
        const id = `mem_mig_m_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
        dbMemories.insert({
          id,
          userId,
          sector: "episodic",
          content: summary,
          summary: null,
          tags: JSON.stringify(["migrated-v2", "conversation"]),
          sessionKey,
          eventAt: curr.created_at,
          validUntil: null,
          strength: 0.5,
        });
        messagesMigrated++;
        i++; // skip the assistant message
        await Bun.sleep(1);
      }
    }
    log("migrate", "message pairs migrated: %d", messagesMigrated);
  } catch (err) {
    log("migrate", "messages migration skipped: %s", (err as Error).message);
  }

  dbState.set(MIGRATION_KEY, { learnings: learningsMigrated, messages: messagesMigrated, at: new Date().toISOString() });
  console.log(`[migrate] v2→v3 complete: ${learningsMigrated} learnings + ${messagesMigrated} message pairs → memory`);
}
