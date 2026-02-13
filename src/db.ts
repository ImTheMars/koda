/**
 * SQLite persistence layer via bun:sqlite.
 *
 * Tables: messages, tasks, usage, learnings, state
 * WAL mode for concurrent reads.
 */

import { Database } from "bun:sqlite";

let db: Database | null = null;

export function initDb(dbPath: string): Database {
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
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

    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('correction', 'preference')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_learnings_user ON learnings(user_id);

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

// --- Messages ---

export const messages = {
  append(sessionKey: string, role: "user" | "assistant" | "system", content: string, toolsUsed?: string[]): void {
    getDb().run(
      "INSERT INTO messages (session_key, role, content, tools_used) VALUES (?, ?, ?, ?)",
      [sessionKey, role, content, toolsUsed?.length ? JSON.stringify(toolsUsed) : null],
    );
  },

  getHistory(sessionKey: string, limit = 30): Array<{ role: string; content: string }> {
    const rows = getDb()
      .query("SELECT role, content FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?")
      .all(sessionKey, limit) as Array<{ role: string; content: string }>;
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

  rewrite(sessionKey: string, newHistory: Array<{ role: string; content: string }>): void {
    const d = getDb();
    d.run("DELETE FROM messages WHERE session_key = ?", [sessionKey]);
    const stmt = d.prepare("INSERT INTO messages (session_key, role, content) VALUES (?, ?, ?)");
    for (const msg of newHistory) stmt.run(sessionKey, msg.role, msg.content);
  },
};

// --- Tasks ---

export const tasks = {
  create(task: {
    id: string; userId: string; chatId: string; channel: string;
    type: "reminder" | "recurring"; description: string; prompt?: string;
    cron?: string; nextRunAt: string; enabled?: boolean; oneShot?: boolean;
  }): void {
    getDb().run(
      "INSERT INTO tasks (id, user_id, chat_id, channel, type, description, prompt, cron, next_run_at, enabled, one_shot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [task.id, task.userId, task.chatId, task.channel, task.type, task.description, task.prompt ?? null, task.cron ?? null, task.nextRunAt, task.enabled !== false ? 1 : 0, task.oneShot ? 1 : 0],
    );
  },

  createBatch(items: Array<Parameters<typeof tasks.create>[0]>): void {
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
  track(data: { userId: string; model: string; inputTokens: number; outputTokens: number; cost: number; toolsUsed?: string[] }): void {
    getDb().run(
      "INSERT INTO usage (user_id, model, input_tokens, output_tokens, cost, tools_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [data.userId, data.model, data.inputTokens, data.outputTokens, data.cost, data.toolsUsed?.length ? JSON.stringify(data.toolsUsed) : null, new Date().toISOString()],
    );
  },

  getSummary(userId: string, since?: Date): { totalRequests: number; totalCost: number; totalInputTokens: number; totalOutputTokens: number } {
    const sinceStr = since?.toISOString() ?? "1970-01-01";
    const row = getDb()
      .query("SELECT COUNT(*) as cnt, COALESCE(SUM(cost), 0) as totalCost, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as out FROM usage WHERE user_id = ? AND datetime(created_at) >= datetime(?)")
      .get(userId, sinceStr) as { cnt: number; totalCost: number; inp: number; out: number } | null;
    return { totalRequests: row?.cnt ?? 0, totalCost: row?.totalCost ?? 0, totalInputTokens: row?.inp ?? 0, totalOutputTokens: row?.out ?? 0 };
  },
};

// --- Learnings ---

export const learnings = {
  add(userId: string, type: "correction" | "preference", content: string): void {
    getDb().run("INSERT INTO learnings (user_id, type, content) VALUES (?, ?, ?)", [userId, type, content]);
  },

  getRecent(userId: string, limit = 10): Array<{ type: string; content: string }> {
    return getDb()
      .query("SELECT type, content FROM learnings WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, limit) as any[];
  },
};

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
