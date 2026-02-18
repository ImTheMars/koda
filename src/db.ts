/**
 * SQLite persistence layer via bun:sqlite.
 *
 * Tables: messages, tasks, usage, learnings, state
 * WAL mode for concurrent reads.
 */

import { Database } from "bun:sqlite";

let db: Database | null = null;
let stmtAppendMessage: ReturnType<Database["prepare"]> | null = null;
let stmtGetHistory: ReturnType<Database["prepare"]> | null = null;
let stmtTrackUsage: ReturnType<Database["prepare"]> | null = null;

const SCHEMA_VERSION = 2;

export function initDb(dbPath: string): Database {
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

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('episodic','semantic','factual','procedural','reflective')),
      content TEXT NOT NULL,
      summary TEXT,
      tags TEXT,
      session_key TEXT,
      event_at TEXT NOT NULL,
      remembered_at TEXT NOT NULL DEFAULT (datetime('now')),
      valid_until TEXT,
      strength REAL NOT NULL DEFAULT 1.0,
      recall_count INTEGER NOT NULL DEFAULT 0,
      last_recalled_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, archived, strength);
    CREATE INDEX IF NOT EXISTS idx_memories_sector ON memories(user_id, sector, archived);

    CREATE TABLE IF NOT EXISTS memory_entities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      attributes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, type, name)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_user ON memory_entities(user_id);

    CREATE TABLE IF NOT EXISTS memory_relations (
      id TEXT PRIMARY KEY,
      from_entity TEXT NOT NULL,
      to_entity TEXT,
      to_memory TEXT,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_entity);
  `);

  stmtAppendMessage = db.prepare("INSERT INTO messages (session_key, role, content, tools_used) VALUES (?, ?, ?, ?)");
  stmtGetHistory = db.prepare("SELECT role, content FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?");
  stmtTrackUsage = db.prepare("INSERT INTO usage (user_id, model, input_tokens, output_tokens, cost, tools_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");

  runMigrations(db);

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

  // v2: memory tables added via CREATE TABLE IF NOT EXISTS in initDb above
  if (currentVersion < 2) {
    database.run(
      "INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '2', datetime('now'))",
    );
    console.log("[db] Migrated to schema version 2");
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
  track(data: { userId: string; model: string; inputTokens: number; outputTokens: number; cost: number; toolsUsed?: string[] }): void {
    if (!stmtTrackUsage) throw new Error("Database statements not initialized");
    stmtTrackUsage.run(
      data.userId,
      data.model,
      data.inputTokens,
      data.outputTokens,
      data.cost,
      data.toolsUsed?.length ? JSON.stringify(data.toolsUsed) : null,
      new Date().toISOString(),
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

// --- Memories ---

export type MemorySector = "episodic" | "semantic" | "factual" | "procedural" | "reflective";

export interface MemoryRow {
  id: string;
  userId: string;
  sector: MemorySector;
  content: string;
  summary: string | null;
  tags: string | null;
  sessionKey: string | null;
  eventAt: string;
  rememberedAt: string;
  validUntil: string | null;
  strength: number;
  recallCount: number;
  lastRecalledAt: string | null;
  archived: number;
}

export const memories = {
  insert(row: Omit<MemoryRow, "rememberedAt" | "archived" | "recallCount" | "lastRecalledAt">): void {
    getDb().run(
      `INSERT OR REPLACE INTO memories
        (id, user_id, sector, content, summary, tags, session_key, event_at, valid_until, strength)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.userId, row.sector, row.content, row.summary ?? null, row.tags ?? null,
       row.sessionKey ?? null, row.eventAt, row.validUntil ?? null, row.strength],
    );
  },

  getById(id: string): MemoryRow | null {
    return getDb().query(
      `SELECT id, user_id as userId, sector, content, summary, tags, session_key as sessionKey,
              event_at as eventAt, remembered_at as rememberedAt, valid_until as validUntil,
              strength, recall_count as recallCount, last_recalled_at as lastRecalledAt, archived
       FROM memories WHERE id = ?`,
    ).get(id) as MemoryRow | null;
  },

  listByUser(userId: string, opts?: { sector?: MemorySector; minStrength?: number; limit?: number; includeArchived?: boolean }): MemoryRow[] {
    const conditions = ["user_id = ?"];
    const params: unknown[] = [userId];
    if (!opts?.includeArchived) { conditions.push("archived = 0"); }
    if (opts?.sector) { conditions.push("sector = ?"); params.push(opts.sector); }
    if (opts?.minStrength !== undefined) { conditions.push("strength >= ?"); params.push(opts.minStrength); }
    const limit = opts?.limit ?? 100;
    return getDb()
      .query(`SELECT id, user_id as userId, sector, content, summary, tags, session_key as sessionKey,
                     event_at as eventAt, remembered_at as rememberedAt, valid_until as validUntil,
                     strength, recall_count as recallCount, last_recalled_at as lastRecalledAt, archived
              FROM memories WHERE ${conditions.join(" AND ")} ORDER BY strength DESC LIMIT ?`)
      .all([...params, limit]) as MemoryRow[];
  },

  updateStrength(id: string, strength: number): void {
    getDb().run(
      `UPDATE memories SET strength = ?, recall_count = recall_count + 1,
       last_recalled_at = datetime('now') WHERE id = ?`,
      [Math.min(1, Math.max(0, strength)), id],
    );
  },

  archive(id: string): void {
    getDb().run("UPDATE memories SET archived = 1 WHERE id = ?", [id]);
  },

  archiveBatch(ids: string[]): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    getDb().run(`UPDATE memories SET archived = 1 WHERE id IN (${placeholders})`, ids);
  },

  getStats(userId: string): { total: number; bySector: Record<string, number>; avgStrength: number; archived: number } {
    const rows = getDb()
      .query("SELECT sector, COUNT(*) as cnt, AVG(strength) as avg FROM memories WHERE user_id = ? AND archived = 0 GROUP BY sector")
      .all(userId) as Array<{ sector: string; cnt: number; avg: number }>;
    const archivedRow = getDb()
      .query("SELECT COUNT(*) as cnt FROM memories WHERE user_id = ? AND archived = 1")
      .get(userId) as { cnt: number } | null;
    const bySector: Record<string, number> = {};
    let total = 0;
    let totalStrengthSum = 0;
    let totalCount = 0;
    for (const r of rows) {
      bySector[r.sector] = r.cnt;
      total += r.cnt;
      totalStrengthSum += r.avg * r.cnt;
      totalCount += r.cnt;
    }
    return {
      total,
      bySector,
      avgStrength: totalCount > 0 ? totalStrengthSum / totalCount : 0,
      archived: archivedRow?.cnt ?? 0,
    };
  },

  search(userId: string, query: string, limit = 10): MemoryRow[] {
    return getDb()
      .query(
        `SELECT id, user_id as userId, sector, content, summary, tags, session_key as sessionKey,
                event_at as eventAt, remembered_at as rememberedAt, valid_until as validUntil,
                strength, recall_count as recallCount, last_recalled_at as lastRecalledAt, archived
         FROM memories WHERE user_id = ? AND archived = 0
         AND (content LIKE ? OR summary LIKE ? OR tags LIKE ?)
         ORDER BY strength DESC LIMIT ?`,
      )
      .all(userId, `%${query}%`, `%${query}%`, `%${query}%`, limit) as MemoryRow[];
  },

  getWeak(userId: string, threshold: number): MemoryRow[] {
    return getDb()
      .query(
        `SELECT id, user_id as userId, sector, content, summary, tags, session_key as sessionKey,
                event_at as eventAt, remembered_at as rememberedAt, valid_until as validUntil,
                strength, recall_count as recallCount, last_recalled_at as lastRecalledAt, archived
         FROM memories WHERE user_id = ? AND archived = 0 AND strength < ?`,
      )
      .all(userId, threshold) as MemoryRow[];
  },

  getForDecay(userId: string): MemoryRow[] {
    return getDb()
      .query(
        `SELECT id, user_id as userId, sector, content, summary, tags, session_key as sessionKey,
                event_at as eventAt, remembered_at as rememberedAt, valid_until as validUntil,
                strength, recall_count as recallCount, last_recalled_at as lastRecalledAt, archived
         FROM memories WHERE user_id = ? AND archived = 0`,
      )
      .all(userId) as MemoryRow[];
  },

  getForReflection(userId: string, sector: MemorySector, minAge: number, limit: number): MemoryRow[] {
    const cutoff = new Date(Date.now() - minAge * 24 * 60 * 60 * 1000).toISOString();
    return getDb()
      .query(
        `SELECT id, user_id as userId, sector, content, summary, tags, session_key as sessionKey,
                event_at as eventAt, remembered_at as rememberedAt, valid_until as validUntil,
                strength, recall_count as recallCount, last_recalled_at as lastRecalledAt, archived
         FROM memories WHERE user_id = ? AND sector = ? AND archived = 0
         AND remembered_at <= ? ORDER BY strength ASC LIMIT ?`,
      )
      .all(userId, sector, cutoff, limit) as MemoryRow[];
  },

  count(userId: string): number {
    const row = getDb()
      .query("SELECT COUNT(*) as cnt FROM memories WHERE user_id = ? AND archived = 0")
      .get(userId) as { cnt: number } | null;
    return row?.cnt ?? 0;
  },
};

// --- Memory Entities ---

export interface EntityRow {
  id: string;
  userId: string;
  type: string;
  name: string;
  attributes: string | null;
  createdAt: string;
}

export const entities = {
  upsert(row: Omit<EntityRow, "createdAt">): string {
    getDb().run(
      `INSERT INTO memory_entities (id, user_id, type, name, attributes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, type, name) DO UPDATE SET attributes = excluded.attributes`,
      [row.id, row.userId, row.type, row.name, row.attributes ?? null],
    );
    const existing = getDb()
      .query("SELECT id FROM memory_entities WHERE user_id = ? AND type = ? AND name = ?")
      .get(row.userId, row.type, row.name) as { id: string } | null;
    return existing?.id ?? row.id;
  },

  listByUser(userId: string): EntityRow[] {
    return getDb()
      .query("SELECT id, user_id as userId, type, name, attributes, created_at as createdAt FROM memory_entities WHERE user_id = ?")
      .all(userId) as EntityRow[];
  },

  getByName(userId: string, name: string): EntityRow | null {
    return getDb()
      .query("SELECT id, user_id as userId, type, name, attributes, created_at as createdAt FROM memory_entities WHERE user_id = ? AND name LIKE ?")
      .get(userId, `%${name}%`) as EntityRow | null;
  },

  count(userId: string): number {
    const row = getDb()
      .query("SELECT COUNT(*) as cnt FROM memory_entities WHERE user_id = ?")
      .get(userId) as { cnt: number } | null;
    return row?.cnt ?? 0;
  },
};

// --- Memory Relations ---

export interface RelationRow {
  id: string;
  fromEntity: string;
  toEntity: string | null;
  toMemory: string | null;
  relation: string;
  createdAt: string;
}

export const relations = {
  insert(row: Omit<RelationRow, "createdAt">): void {
    getDb().run(
      `INSERT OR IGNORE INTO memory_relations (id, from_entity, to_entity, to_memory, relation)
       VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.fromEntity, row.toEntity ?? null, row.toMemory ?? null, row.relation],
    );
  },

  listFromEntity(entityId: string): RelationRow[] {
    return getDb()
      .query("SELECT id, from_entity as fromEntity, to_entity as toEntity, to_memory as toMemory, relation, created_at as createdAt FROM memory_relations WHERE from_entity = ?")
      .all(entityId) as RelationRow[];
  },

  listForMemory(memoryId: string): RelationRow[] {
    return getDb()
      .query("SELECT id, from_entity as fromEntity, to_entity as toEntity, to_memory as toMemory, relation, created_at as createdAt FROM memory_relations WHERE to_memory = ?")
      .all(memoryId) as RelationRow[];
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
