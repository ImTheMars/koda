/**
 * SQLite persistence layer via bun:sqlite.
 *
 * Tables: messages, tasks, usage, state, subagents, vector_memories (learnings dropped in v0.9.0)
 * WAL mode for concurrent reads.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, readdirSync, unlinkSync } from "fs";
import { resolve, basename } from "path";

let db: Database | null = null;
let currentDbPath: string | null = null;
let stmtAppendMessage: ReturnType<Database["prepare"]> | null = null;
let stmtGetHistory: ReturnType<Database["prepare"]> | null = null;
let stmtTrackUsage: ReturnType<Database["prepare"]> | null = null;

const SCHEMA_VERSION = 3;

export function initDb(dbPath: string): Database {
  currentDbPath = dbPath;
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      tools_used TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('reminder', 'recurring')),
      description TEXT NOT NULL,
      prompt TEXT,
      cron TEXT,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      one_shot INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_next ON tasks(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      tools_used TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at);

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subagents (
      session_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      tools_used TEXT,
      cost REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_name ON subagents(name, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subagents_updated ON subagents(updated_at DESC);

    CREATE TABLE IF NOT EXISTS vector_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vector_user ON vector_memories(user_id, id DESC);
  `);

  stmtAppendMessage = db.prepare("INSERT INTO messages (session_key, role, content, tools_used) VALUES (?, ?, ?, ?)");
  stmtGetHistory = db.prepare("SELECT role, content FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?");

  // Prepare stmtTrackUsage AFTER migrations so the tool_cost column exists
  runMigrations(db);

  stmtTrackUsage = db.prepare("INSERT INTO usage (user_id, model, input_tokens, output_tokens, cost, tool_cost, tools_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

  return db;
}

function runMigrations(database: Database): void {
  const versionRow = database.query("SELECT value FROM state WHERE key = 'schema_version'").get() as { value: string } | null;
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  if (currentVersion < 1) {
    database.run(
      "INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '1', datetime('now'))",
    );
    console.log("[db] Migrated to schema version 1");
  }

  if (currentVersion < 2) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS subagents (
        session_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        tools_used TEXT,
        cost REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_subagents_name ON subagents(name, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagents_updated ON subagents(updated_at DESC);

      CREATE TABLE IF NOT EXISTS vector_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_vector_user ON vector_memories(user_id, id DESC);
    `);
    database.run(
      "INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '2', datetime('now'))",
    );
    console.log("[db] Migrated to schema version 2");
  }

  if (currentVersion < 3) {
    // Add tool_cost column to track external API costs (Exa, etc.) separately from LLM cost
    try {
      database.exec("ALTER TABLE usage ADD COLUMN tool_cost REAL NOT NULL DEFAULT 0");
    } catch {
      // Column already exists — safe to ignore
    }
    database.run(
      "INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '3', datetime('now'))",
    );
    console.log("[db] Migrated to schema version 3");
  }
}

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
  stmtAppendMessage = null;
  stmtGetHistory = null;
  stmtTrackUsage = null;
}

// --- Messages ---

export const messages = {
  append(sessionKey: string, role: "user" | "assistant" | "system", content: string, toolsUsed?: string[]): void {
    if (!stmtAppendMessage) throw new Error("Database statements not initialized");
    stmtAppendMessage.run(sessionKey, role, content, toolsUsed?.length ? JSON.stringify(toolsUsed) : null);
  },

  getHistory(sessionKey: string, limit = 30): Array<{ role: string; content: string }> {
    if (!stmtGetHistory) throw new Error("Database statements not initialized");
    const rows = stmtGetHistory.all(sessionKey, limit) as Array<{ role: string; content: string }>;
    return rows.reverse();
  },

  clear(sessionKey: string): void {
    getDb().run("DELETE FROM messages WHERE session_key = ?", [sessionKey]);
  },

  count(sessionKey: string): number {
    const row = getDb()
      .query("SELECT COUNT(*) as cnt FROM messages WHERE session_key = ?")
      .get(sessionKey) as { cnt: number } | null;
    return row?.cnt ?? 0;
  },

  cleanup(daysOld = 90): number {
    const result = getDb().run(
      "DELETE FROM messages WHERE datetime(created_at) < datetime('now', ?)",
      [`-${daysOld} days`],
    );
    return result.changes;
  },
};

// --- Tasks ---

type TaskInput = {
  id: string;
  userId: string;
  chatId: string;
  channel: string;
  type: "reminder" | "recurring";
  description: string;
  prompt?: string;
  cron?: string;
  nextRunAt: string;
  enabled?: boolean;
  oneShot?: boolean;
};

export const tasks = {
  create(task: TaskInput): void {
    getDb().run(
      "INSERT INTO tasks (id, user_id, chat_id, channel, type, description, prompt, cron, next_run_at, enabled, one_shot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [task.id, task.userId, task.chatId, task.channel, task.type, task.description, task.prompt ?? null, task.cron ?? null, task.nextRunAt, task.enabled !== false ? 1 : 0, task.oneShot ? 1 : 0],
    );
  },

  createBatch(items: TaskInput[]): void {
    const d = getDb();
    const stmt = d.prepare(
      "INSERT INTO tasks (id, user_id, chat_id, channel, type, description, prompt, cron, next_run_at, enabled, one_shot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertAll = d.transaction(() => {
      for (const t of items) stmt.run(t.id, t.userId, t.chatId, t.channel, t.type, t.description, t.prompt ?? null, t.cron ?? null, t.nextRunAt, t.enabled !== false ? 1 : 0, t.oneShot ? 1 : 0);
    });
    insertAll();
  },

  getReady(now: string): Array<{
    id: string; userId: string; chatId: string; channel: string;
    type: string; description: string; prompt: string | null; cron: string | null;
    nextRunAt: string; oneShot: boolean; lastRunAt: string | null;
  }> {
    return (getDb()
      .query("SELECT id, user_id as userId, chat_id as chatId, channel, type, description, prompt, cron, next_run_at as nextRunAt, one_shot as oneShot, last_run_at as lastRunAt FROM tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC")
      .all(now) as Array<any>).map((r) => ({ ...r, oneShot: r.oneShot === 1 }));
  },

  advance(id: string, nextRunAt: string): void {
    getDb().run("UPDATE tasks SET next_run_at = ?, last_run_at = datetime('now') WHERE id = ?", [nextRunAt, id]);
  },

  disable(id: string): void {
    getDb().run("UPDATE tasks SET enabled = 0 WHERE id = ?", [id]);
  },

  delete(id: string): boolean {
    return getDb().run("DELETE FROM tasks WHERE id = ?", [id]).changes > 0;
  },

  deleteForUser(id: string, userId: string): boolean {
    return getDb().run("DELETE FROM tasks WHERE id = ? AND user_id = ?", [id, userId]).changes > 0;
  },

  listByUser(userId: string): Array<{
    id: string; type: string; description: string; cron: string | null;
    nextRunAt: string; lastRunAt: string | null;
  }> {
    return getDb()
      .query("SELECT id, type, description, cron, next_run_at as nextRunAt, last_run_at as lastRunAt FROM tasks WHERE user_id = ? AND enabled = 1 ORDER BY next_run_at")
      .all(userId) as any[];
  },
};

// --- Usage ---

export const usage = {
  track(data: { userId: string; model: string; inputTokens: number; outputTokens: number; cost: number; toolCost?: number; toolsUsed?: string[] }): void {
    if (!stmtTrackUsage) throw new Error("Database statements not initialized");
    stmtTrackUsage.run(
      data.userId,
      data.model,
      data.inputTokens,
      data.outputTokens,
      data.cost,
      data.toolCost ?? 0,
      data.toolsUsed?.length ? JSON.stringify(data.toolsUsed) : null,
      new Date().toISOString(),
    );
  },

  getSummary(userId: string, since?: Date): { totalRequests: number; totalCost: number; totalToolCost: number; totalInputTokens: number; totalOutputTokens: number } {
    const sinceStr = since?.toISOString() ?? "1970-01-01";
    const row = getDb()
      .query("SELECT COUNT(*) as cnt, COALESCE(SUM(cost), 0) as totalCost, COALESCE(SUM(tool_cost), 0) as totalToolCost, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as out FROM usage WHERE user_id = ? AND datetime(created_at) >= datetime(?)")
      .get(userId, sinceStr) as { cnt: number; totalCost: number; totalToolCost: number; inp: number; out: number } | null;
    return { totalRequests: row?.cnt ?? 0, totalCost: row?.totalCost ?? 0, totalToolCost: row?.totalToolCost ?? 0, totalInputTokens: row?.inp ?? 0, totalOutputTokens: row?.out ?? 0 };
  },
};

// --- Sub-agents ---

export interface SpawnRow {
  sessionKey: string;
  name: string;
  status: "running" | "done" | "error" | "timeout" | "killed";
  toolsUsed: string[];
  cost: number;
  durationMs: number;
  startedAt: string;
  timestamp: string;
}

export const subagents = {
  upsert(row: { sessionKey: string; name: string; startedAt: string }): void {
    getDb().run(
      `INSERT INTO subagents (session_key, name, status, started_at, updated_at)
       VALUES (?, ?, 'running', ?, datetime('now'))
       ON CONFLICT(session_key) DO NOTHING`,
      [row.sessionKey, row.name, row.startedAt],
    );
  },

  markCompleted(sessionKey: string, update: {
    status: "done" | "error" | "timeout" | "killed";
    toolsUsed: string[];
    cost: number;
    durationMs: number;
  }): void {
    getDb().run(
      "UPDATE subagents SET status = ?, tools_used = ?, cost = ?, duration_ms = ?, updated_at = datetime('now') WHERE session_key = ?",
      [update.status, JSON.stringify(update.toolsUsed), update.cost, update.durationMs, sessionKey],
    );
  },

  listRecent(limit = 50): SpawnRow[] {
    const rows = getDb()
      .query("SELECT session_key, name, status, tools_used, cost, duration_ms, started_at, updated_at FROM subagents ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<{
        session_key: string; name: string; status: string;
        tools_used: string | null; cost: number; duration_ms: number;
        started_at: string; updated_at: string;
      }>;
    return rows.map((r) => ({
      sessionKey: r.session_key,
      name: r.name,
      status: r.status as SpawnRow["status"],
      toolsUsed: r.tools_used ? (JSON.parse(r.tools_used) as string[]) : [],
      cost: r.cost,
      durationMs: r.duration_ms,
      startedAt: r.started_at,
      timestamp: r.updated_at,
    }));
  },

  getByName(name: string): { sessionKey: string; name: string } | null {
    const row = getDb()
      .query("SELECT session_key, name FROM subagents WHERE lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1")
      .get(name) as { session_key: string; name: string } | null;
    if (!row) return null;
    return { sessionKey: row.session_key, name: row.name };
  },

  getRunning(): SpawnRow[] {
    return subagents.listRecent(200).filter((r) => r.status === "running");
  },
};

// --- Vector memories ---

export const vectorMemories = {
  insert(userId: string, content: string, embedding: Float32Array): void {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    getDb().run(
      "INSERT INTO vector_memories (user_id, content, embedding) VALUES (?, ?, ?)",
      [userId, content, blob],
    );
  },

  listByUser(userId: string): Array<{ id: number; content: string; embedding: Buffer }> {
    return getDb()
      .query("SELECT id, content, embedding FROM vector_memories WHERE user_id = ? ORDER BY id DESC")
      .all(userId) as any[];
  },

  count(userId: string): number {
    const row = getDb()
      .query("SELECT COUNT(*) as cnt FROM vector_memories WHERE user_id = ?")
      .get(userId) as { cnt: number } | null;
    return row?.cnt ?? 0;
  },

  deleteOldest(userId: string, keepCount: number): void {
    getDb().run(
      `DELETE FROM vector_memories WHERE user_id = ? AND id NOT IN
       (SELECT id FROM vector_memories WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      [userId, userId, keepCount],
    );
  },
};

// --- Backup ---

export function backupDatabase(backupDir: string, maxBackups = 7): string {
  const d = getDb();
  if (!currentDbPath) throw new Error("Database path not set");
  d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupDir, `koda-${timestamp}.db`);
  copyFileSync(currentDbPath, backupPath);

  // Prune old backups beyond maxBackups
  try {
    const files = readdirSync(backupDir)
      .filter((f) => f.startsWith("koda-") && f.endsWith(".db"))
      .sort();
    while (files.length > maxBackups) {
      const oldest = files.shift()!;
      unlinkSync(resolve(backupDir, oldest));
    }
  } catch {}

  return backupPath;
}

// --- Maintenance ---

export function vacuumDb(): void {
  const d = getDb();
  d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  d.exec("VACUUM");
}

// --- State (key-value) ---

export const state = {
  get<T>(key: string): T | null {
    const row = getDb().query("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | null;
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
  },

  set<T>(key: string, value: T): void {
    getDb().run(
      "INSERT INTO state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, JSON.stringify(value)],
    );
  },

  delete(key: string): void {
    getDb().run("DELETE FROM state WHERE key = ?", [key]);
  },
};
