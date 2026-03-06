/**
 * SQLite persistence layer via bun:sqlite.
 *
 * Tables: messages, tasks, usage, state, subagents, assessment_*, plans
 * WAL mode for concurrent reads.
 */

import { Database } from "bun:sqlite";
import { log } from "./log.js";
import { copyFileSync, readdirSync, unlinkSync } from "fs";
import { resolve, basename } from "path";

let db: Database | null = null;
let currentDbPath: string | null = null;
let stmtAppendMessage: ReturnType<Database["prepare"]> | null = null;
let stmtGetHistory: ReturnType<Database["prepare"]> | null = null;
let stmtTrackUsage: ReturnType<Database["prepare"]> | null = null;

const SCHEMA_VERSION = 8;

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

    CREATE TABLE IF NOT EXISTS assessment_goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'done', 'cancelled')),
      target_date TEXT,
      success_criteria TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_assessment_goals_user ON assessment_goals(user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS assessment_observations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      statement TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      contradicts TEXT,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_assessment_observations_user ON assessment_observations(user_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS assessment_interventions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      goal_id TEXT,
      recommendation TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'active', 'done', 'abandoned')),
      start_date TEXT,
      follow_up_at TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(goal_id) REFERENCES assessment_goals(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assessment_interventions_user ON assessment_interventions(user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS assessment_reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      findings TEXT NOT NULL,
      risks TEXT,
      wins TEXT,
      next_actions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_assessment_reviews_user ON assessment_reviews(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'blocked', 'done', 'cancelled')),
      success_criteria TEXT,
      verification_strategy TEXT,
      risk_level TEXT NOT NULL DEFAULT 'medium' CHECK(risk_level IN ('low', 'medium', 'high')),
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      blocked_reason TEXT,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plans_run ON plans(status, next_run_at);

    CREATE TABLE IF NOT EXISTS plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'failed', 'cancelled')),
      expected_artifact TEXT,
      verification_hint TEXT,
      assigned_agent TEXT,
      notes TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, step_order);

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
    log("db", "Migrated to schema version 1");
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
    `);
    database.run(
      "INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '2', datetime('now'))",
    );
    log("db", "Migrated to schema version 2");
  }

  if (currentVersion < 3) {
    // Add tool_cost column to track external API costs (Exa, etc.) separately from LLM cost
    try {
      database.exec("ALTER TABLE usage ADD COLUMN tool_cost REAL NOT NULL DEFAULT 0");
    } catch {
      // Column already exists (duplicate table) — safe to ignore
    }
    database.run(
      "INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '3', datetime('now'))",
    );
    log("db", "Migrated to schema version 3");
  }

  if (currentVersion < 4) {
    try { database.exec("ALTER TABLE tasks ADD COLUMN last_status TEXT DEFAULT NULL"); } catch { /* column already exists */ }
    try { database.exec("ALTER TABLE tasks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
    database.run("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '4', datetime('now'))");
    log("db", "Migrated to schema version 4");
  }

  if (currentVersion < 5) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        message_range_start INTEGER NOT NULL,
        message_range_end INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON conversation_summaries(session_key);

      CREATE TABLE IF NOT EXISTS tool_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        approach TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        error_snippet TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_tool ON tool_outcomes(tool_name, success);
    `);
    database.run("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '5', datetime('now'))");
    log("db", "Migrated to schema version 5");
  }

  if (currentVersion < 6) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        username TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
        first_seen TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_active TEXT DEFAULT (datetime('now')),
        PRIMARY KEY(chat_id, user_id)
      );
    `);
    database.run("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '6', datetime('now'))");
    log("db", "Migrated to schema version 6");
  }

  if (currentVersion < 7) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS assessment_goals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        domain TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'done', 'cancelled')),
        target_date TEXT,
        success_criteria TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_assessment_goals_user ON assessment_goals(user_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS assessment_observations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        statement TEXT NOT NULL,
        source TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        contradicts TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_assessment_observations_user ON assessment_observations(user_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS assessment_interventions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        goal_id TEXT,
        recommendation TEXT NOT NULL,
        rationale TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'active', 'done', 'abandoned')),
        start_date TEXT,
        follow_up_at TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(goal_id) REFERENCES assessment_goals(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assessment_interventions_user ON assessment_interventions(user_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS assessment_reviews (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        findings TEXT NOT NULL,
        risks TEXT,
        wins TEXT,
        next_actions TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_assessment_reviews_user ON assessment_reviews(user_id, created_at DESC);
    `);
    database.run("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '7', datetime('now'))");
    log("db", "Migrated to schema version 7");
  }

  if (currentVersion < 8) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'blocked', 'done', 'cancelled')),
        success_criteria TEXT,
        verification_strategy TEXT,
        risk_level TEXT NOT NULL DEFAULT 'medium' CHECK(risk_level IN ('low', 'medium', 'high')),
        requires_approval INTEGER NOT NULL DEFAULT 0,
        approved_at TEXT,
        blocked_reason TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plans_run ON plans(status, next_run_at);

      CREATE TABLE IF NOT EXISTS plan_steps (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'failed', 'cancelled')),
        expected_artifact TEXT,
        verification_hint TEXT,
        assigned_agent TEXT,
        notes TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, step_order);
    `);
    database.run("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('schema_version', '8', datetime('now'))");
    log("db", "Migrated to schema version 8");
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

  markResult(id: string, status: "ok" | "error"): void {
    if (status === "ok") {
      getDb().run("UPDATE tasks SET last_status = 'ok', consecutive_failures = 0 WHERE id = ?", [id]);
    } else {
      getDb().run("UPDATE tasks SET last_status = 'error', consecutive_failures = consecutive_failures + 1 WHERE id = ?", [id]);
    }
  },

  getReady(now: string): Array<{
    id: string; userId: string; chatId: string; channel: string;
    type: string; description: string; prompt: string | null; cron: string | null;
    nextRunAt: string; oneShot: boolean; lastRunAt: string | null;
    lastStatus: string | null; consecutiveFailures: number;
  }> {
    type TaskRow = {
      id: string; userId: string; chatId: string; channel: string;
      type: string; description: string; prompt: string | null; cron: string | null;
      nextRunAt: string; oneShot: number; lastRunAt: string | null;
      lastStatus: string | null; consecutiveFailures: number;
    };
    return (getDb()
      .query("SELECT id, user_id as userId, chat_id as chatId, channel, type, description, prompt, cron, next_run_at as nextRunAt, one_shot as oneShot, last_run_at as lastRunAt, last_status as lastStatus, consecutive_failures as consecutiveFailures FROM tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC")
      .all(now) as TaskRow[]).map((r) => ({ ...r, oneShot: r.oneShot === 1 }));
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
    lastStatus: string | null; consecutiveFailures: number;
  }> {
    return getDb()
      .query("SELECT id, type, description, cron, next_run_at as nextRunAt, last_run_at as lastRunAt, last_status as lastStatus, consecutive_failures as consecutiveFailures FROM tasks WHERE user_id = ? AND enabled = 1 ORDER BY next_run_at")
      .all(userId) as Array<{
        id: string; type: string; description: string; cron: string | null;
        nextRunAt: string; lastRunAt: string | null;
        lastStatus: string | null; consecutiveFailures: number;
      }>;
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
  } catch { /* backup dir may not exist yet — safe to skip */ }

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

// --- Conversation Summaries ---

export const summaries = {
  store(sessionKey: string, summary: string, rangeStart: number, rangeEnd: number): void {
    getDb().run(
      "INSERT INTO conversation_summaries (session_key, summary, message_range_start, message_range_end) VALUES (?, ?, ?, ?)",
      [sessionKey, summary, rangeStart, rangeEnd],
    );
  },

  getLatest(sessionKey: string, limit = 3): Array<{
    summary: string;
    messageRangeStart: number;
    messageRangeEnd: number;
    createdAt: string;
  }> {
    return getDb()
      .query("SELECT summary, message_range_start as messageRangeStart, message_range_end as messageRangeEnd, created_at as createdAt FROM conversation_summaries WHERE session_key = ? ORDER BY id DESC LIMIT ?")
      .all(sessionKey, limit) as Array<{
        summary: string;
        messageRangeStart: number;
        messageRangeEnd: number;
        createdAt: string;
      }>;
  },
};

// --- Tool Outcomes ---

export const toolOutcomes = {
  record(data: {
    userId: string;
    toolName: string;
    approach: string;
    success: boolean;
    errorSnippet?: string;
  }): void {
    getDb().run(
      "INSERT INTO tool_outcomes (user_id, tool_name, approach, success, error_snippet) VALUES (?, ?, ?, ?, ?)",
      [data.userId, data.toolName, data.approach, data.success ? 1 : 0, data.errorSnippet ?? null],
    );
  },

  getRecentFailures(userId: string, hoursBack = 24): Array<{
    toolName: string;
    errorSnippet: string;
    count: number;
  }> {
    return getDb()
      .query(`SELECT tool_name as toolName, error_snippet as errorSnippet, COUNT(*) as count
              FROM tool_outcomes
              WHERE user_id = ? AND success = 0
                AND datetime(created_at) >= datetime('now', ?)
              GROUP BY tool_name, error_snippet
              HAVING COUNT(*) >= 3
              ORDER BY count DESC
              LIMIT 5`)
      .all(userId, `-${hoursBack} hours`) as Array<{
        toolName: string;
        errorSnippet: string;
        count: number;
      }>;
  },
};

// --- User Profiles ---

export interface UserProfileRow {
  userId: string;
  displayName: string;
  username: string | null;
  role: "admin" | "member";
  firstSeen: string;
  lastSeen: string;
}

export const userProfiles = {
  upsert(data: { userId: string; displayName: string; username?: string; role?: "admin" | "member" }): void {
    getDb().run(
      `INSERT INTO user_profiles (user_id, display_name, username, role)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = excluded.display_name,
         username = COALESCE(excluded.username, user_profiles.username),
         last_seen = datetime('now')`,
      [data.userId, data.displayName, data.username ?? null, data.role ?? "member"],
    );
  },

  get(userId: string): UserProfileRow | null {
    const row = getDb()
      .query("SELECT user_id as userId, display_name as displayName, username, role, first_seen as firstSeen, last_seen as lastSeen FROM user_profiles WHERE user_id = ?")
      .get(userId) as UserProfileRow | null;
    return row;
  },

  getAll(): UserProfileRow[] {
    return getDb()
      .query("SELECT user_id as userId, display_name as displayName, username, role, first_seen as firstSeen, last_seen as lastSeen FROM user_profiles ORDER BY last_seen DESC")
      .all() as UserProfileRow[];
  },

  setRole(userId: string, role: "admin" | "member"): boolean {
    return getDb().run("UPDATE user_profiles SET role = ? WHERE user_id = ?", [role, userId]).changes > 0;
  },

  touch(userId: string): void {
    getDb().run("UPDATE user_profiles SET last_seen = datetime('now') WHERE user_id = ?", [userId]);
  },
};

// --- Chat Members ---

export interface ChatMemberRow {
  chatId: string;
  userId: string;
  lastActive: string;
}

export const chatMembers = {
  upsert(chatId: string, userId: string): void {
    getDb().run(
      `INSERT INTO chat_members (chat_id, user_id)
       VALUES (?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET last_active = datetime('now')`,
      [chatId, userId],
    );
  },

  getByChatId(chatId: string): ChatMemberRow[] {
    return getDb()
      .query("SELECT chat_id as chatId, user_id as userId, last_active as lastActive FROM chat_members WHERE chat_id = ? ORDER BY last_active DESC")
      .all(chatId) as ChatMemberRow[];
  },
};

// --- Assessment State ---

export interface GoalRow {
  id: string;
  userId: string;
  title: string;
  domain: string;
  status: "active" | "paused" | "done" | "cancelled";
  targetDate: string | null;
  successCriteria: string | null;
  confidence: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObservationRow {
  id: string;
  userId: string;
  domain: string;
  statement: string;
  source: string;
  evidenceType: string;
  confidence: number;
  contradicts: string | null;
  observedAt: string;
  createdAt: string;
}

export interface InterventionRow {
  id: string;
  userId: string;
  goalId: string | null;
  recommendation: string;
  rationale: string | null;
  status: "planned" | "active" | "done" | "abandoned";
  startDate: string | null;
  followUpAt: string | null;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRow {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  findings: string;
  risks: string | null;
  wins: string | null;
  nextActions: string | null;
  createdAt: string;
}

export const assessment = {
  upsertGoal(input: {
    id: string;
    userId: string;
    title: string;
    domain: string;
    status?: GoalRow["status"];
    targetDate?: string | null;
    successCriteria?: string | null;
    confidence?: number;
    notes?: string | null;
  }): void {
    getDb().run(
      `INSERT INTO assessment_goals (id, user_id, title, domain, status, target_date, success_criteria, confidence, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         domain = excluded.domain,
         status = excluded.status,
         target_date = excluded.target_date,
         success_criteria = excluded.success_criteria,
         confidence = excluded.confidence,
         notes = excluded.notes,
         updated_at = datetime('now')`,
      [
        input.id,
        input.userId,
        input.title,
        input.domain,
        input.status ?? "active",
        input.targetDate ?? null,
        input.successCriteria ?? null,
        input.confidence ?? 0.5,
        input.notes ?? null,
      ],
    );
  },

  listGoals(userId: string, status?: GoalRow["status"]): GoalRow[] {
    const query = status
      ? "SELECT id, user_id as userId, title, domain, status, target_date as targetDate, success_criteria as successCriteria, confidence, notes, created_at as createdAt, updated_at as updatedAt FROM assessment_goals WHERE user_id = ? AND status = ? ORDER BY updated_at DESC"
      : "SELECT id, user_id as userId, title, domain, status, target_date as targetDate, success_criteria as successCriteria, confidence, notes, created_at as createdAt, updated_at as updatedAt FROM assessment_goals WHERE user_id = ? ORDER BY updated_at DESC";
    return status
      ? getDb().query(query).all(userId, status) as GoalRow[]
      : getDb().query(query).all(userId) as GoalRow[];
  },

  addObservation(input: {
    id: string;
    userId: string;
    domain: string;
    statement: string;
    source: string;
    evidenceType: string;
    confidence?: number;
    contradicts?: string | null;
    observedAt: string;
  }): void {
    getDb().run(
      `INSERT INTO assessment_observations (id, user_id, domain, statement, source, evidence_type, confidence, contradicts, observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        input.id,
        input.userId,
        input.domain,
        input.statement,
        input.source,
        input.evidenceType,
        input.confidence ?? 0.5,
        input.contradicts ?? null,
        input.observedAt,
      ],
    );
  },

  listObservations(userId: string, limit = 25): ObservationRow[] {
    return getDb()
      .query("SELECT id, user_id as userId, domain, statement, source, evidence_type as evidenceType, confidence, contradicts, observed_at as observedAt, created_at as createdAt FROM assessment_observations WHERE user_id = ? ORDER BY observed_at DESC, created_at DESC LIMIT ?")
      .all(userId, limit) as ObservationRow[];
  },

  addIntervention(input: {
    id: string;
    userId: string;
    goalId?: string | null;
    recommendation: string;
    rationale?: string | null;
    status?: InterventionRow["status"];
    startDate?: string | null;
    followUpAt?: string | null;
    outcome?: string | null;
  }): void {
    getDb().run(
      `INSERT INTO assessment_interventions (id, user_id, goal_id, recommendation, rationale, status, start_date, follow_up_at, outcome, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        input.id,
        input.userId,
        input.goalId ?? null,
        input.recommendation,
        input.rationale ?? null,
        input.status ?? "planned",
        input.startDate ?? null,
        input.followUpAt ?? null,
        input.outcome ?? null,
      ],
    );
  },

  listInterventions(userId: string, status?: InterventionRow["status"]): InterventionRow[] {
    const query = status
      ? "SELECT id, user_id as userId, goal_id as goalId, recommendation, rationale, status, start_date as startDate, follow_up_at as followUpAt, outcome, created_at as createdAt, updated_at as updatedAt FROM assessment_interventions WHERE user_id = ? AND status = ? ORDER BY updated_at DESC"
      : "SELECT id, user_id as userId, goal_id as goalId, recommendation, rationale, status, start_date as startDate, follow_up_at as followUpAt, outcome, created_at as createdAt, updated_at as updatedAt FROM assessment_interventions WHERE user_id = ? ORDER BY updated_at DESC";
    return status
      ? getDb().query(query).all(userId, status) as InterventionRow[]
      : getDb().query(query).all(userId) as InterventionRow[];
  },

  addReview(input: {
    id: string;
    userId: string;
    periodStart: string;
    periodEnd: string;
    findings: string;
    risks?: string | null;
    wins?: string | null;
    nextActions?: string | null;
  }): void {
    getDb().run(
      `INSERT INTO assessment_reviews (id, user_id, period_start, period_end, findings, risks, wins, next_actions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [input.id, input.userId, input.periodStart, input.periodEnd, input.findings, input.risks ?? null, input.wins ?? null, input.nextActions ?? null],
    );
  },

  listReviews(userId: string, limit = 10): ReviewRow[] {
    return getDb()
      .query("SELECT id, user_id as userId, period_start as periodStart, period_end as periodEnd, findings, risks, wins, next_actions as nextActions, created_at as createdAt FROM assessment_reviews WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as ReviewRow[];
  },

  buildSummary(userId: string): {
    goals: GoalRow[];
    observations: ObservationRow[];
    interventions: InterventionRow[];
    reviews: ReviewRow[];
  } {
    return {
      goals: assessment.listGoals(userId).slice(0, 5),
      observations: assessment.listObservations(userId, 6),
      interventions: assessment.listInterventions(userId).slice(0, 5),
      reviews: assessment.listReviews(userId, 3),
    };
  },
};

// --- Plans ---

export interface PlanRow {
  id: string;
  userId: string;
  chatId: string;
  title: string;
  goal: string;
  status: "draft" | "active" | "blocked" | "done" | "cancelled";
  successCriteria: string | null;
  verificationStrategy: string | null;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  approvedAt: string | null;
  blockedReason: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanStepRow {
  id: string;
  planId: string;
  stepOrder: number;
  title: string;
  instructions: string | null;
  status: "pending" | "in_progress" | "done" | "blocked" | "failed" | "cancelled";
  expectedArtifact: string | null;
  verificationHint: string | null;
  assignedAgent: string | null;
  notes: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const plans = {
  create(input: {
    id: string;
    userId: string;
    chatId: string;
    title: string;
    goal: string;
    status?: PlanRow["status"];
    successCriteria?: string | null;
    verificationStrategy?: string | null;
    riskLevel?: PlanRow["riskLevel"];
    requiresApproval?: boolean;
    approvedAt?: string | null;
    blockedReason?: string | null;
    nextRunAt?: string | null;
  }): void {
    getDb().run(
      `INSERT INTO plans (id, user_id, chat_id, title, goal, status, success_criteria, verification_strategy, risk_level, requires_approval, approved_at, blocked_reason, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        input.id,
        input.userId,
        input.chatId,
        input.title,
        input.goal,
        input.status ?? "draft",
        input.successCriteria ?? null,
        input.verificationStrategy ?? null,
        input.riskLevel ?? "medium",
        input.requiresApproval ? 1 : 0,
        input.approvedAt ?? null,
        input.blockedReason ?? null,
        input.nextRunAt ?? null,
      ],
    );
  },

  addSteps(planId: string, steps: Array<{
    id: string;
    title: string;
    instructions?: string | null;
    expectedArtifact?: string | null;
    verificationHint?: string | null;
    assignedAgent?: string | null;
  }>): void {
    const d = getDb();
    const stmt = d.prepare(
      `INSERT INTO plan_steps (id, plan_id, step_order, title, instructions, expected_artifact, verification_hint, assigned_agent, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
    );
    const tx = d.transaction(() => {
      steps.forEach((step, index) => {
        stmt.run(step.id, planId, index + 1, step.title, step.instructions ?? null, step.expectedArtifact ?? null, step.verificationHint ?? null, step.assignedAgent ?? null);
      });
    });
    tx();
  },

  listByUser(userId: string, status?: PlanRow["status"]): PlanRow[] {
    const query = status
      ? "SELECT id, user_id as userId, chat_id as chatId, title, goal, status, success_criteria as successCriteria, verification_strategy as verificationStrategy, risk_level as riskLevel, requires_approval as requiresApproval, approved_at as approvedAt, blocked_reason as blockedReason, next_run_at as nextRunAt, last_run_at as lastRunAt, created_at as createdAt, updated_at as updatedAt FROM plans WHERE user_id = ? AND status = ? ORDER BY updated_at DESC"
      : "SELECT id, user_id as userId, chat_id as chatId, title, goal, status, success_criteria as successCriteria, verification_strategy as verificationStrategy, risk_level as riskLevel, requires_approval as requiresApproval, approved_at as approvedAt, blocked_reason as blockedReason, next_run_at as nextRunAt, last_run_at as lastRunAt, created_at as createdAt, updated_at as updatedAt FROM plans WHERE user_id = ? ORDER BY updated_at DESC";
    const rows = status
      ? getDb().query(query).all(userId, status) as Array<Omit<PlanRow, "requiresApproval"> & { requiresApproval: number }>
      : getDb().query(query).all(userId) as Array<Omit<PlanRow, "requiresApproval"> & { requiresApproval: number }>;
    return rows.map((row) => ({ ...row, requiresApproval: row.requiresApproval === 1 }));
  },

  get(planId: string): (PlanRow & { steps: PlanStepRow[] }) | null {
    const row = getDb()
      .query("SELECT id, user_id as userId, chat_id as chatId, title, goal, status, success_criteria as successCriteria, verification_strategy as verificationStrategy, risk_level as riskLevel, requires_approval as requiresApproval, approved_at as approvedAt, blocked_reason as blockedReason, next_run_at as nextRunAt, last_run_at as lastRunAt, created_at as createdAt, updated_at as updatedAt FROM plans WHERE id = ?")
      .get(planId) as (Omit<PlanRow, "requiresApproval"> & { requiresApproval: number }) | null;
    if (!row) return null;
    return {
      ...row,
      requiresApproval: row.requiresApproval === 1,
      steps: plans.listSteps(planId),
    };
  },

  listSteps(planId: string): PlanStepRow[] {
    return getDb()
      .query("SELECT id, plan_id as planId, step_order as stepOrder, title, instructions, status, expected_artifact as expectedArtifact, verification_hint as verificationHint, assigned_agent as assignedAgent, notes, last_error as lastError, created_at as createdAt, updated_at as updatedAt FROM plan_steps WHERE plan_id = ? ORDER BY step_order ASC")
      .all(planId) as PlanStepRow[];
  },

  getNextRunnable(limit = 5): Array<PlanRow & { nextStep: PlanStepRow | null }> {
    const rows = getDb()
      .query(`SELECT id FROM plans
              WHERE status = 'active'
                AND (requires_approval = 0 OR approved_at IS NOT NULL)
                AND next_run_at IS NOT NULL
                AND datetime(next_run_at) <= datetime('now')
              ORDER BY next_run_at ASC
              LIMIT ?`)
      .all(limit) as Array<{ id: string }>;
    return rows.map((row) => {
      const plan = plans.get(row.id);
      if (!plan) throw new Error(`Plan ${row.id} missing`);
      const nextStep = plan.steps.find((step) => step.status === "pending" || step.status === "in_progress") ?? null;
      return { ...plan, nextStep };
    });
  },

  setStatus(planId: string, status: PlanRow["status"], opts?: {
    blockedReason?: string | null;
    approvedAt?: string | null;
    nextRunAt?: string | null;
  }): void {
    getDb().run(
      `UPDATE plans
       SET status = ?, blocked_reason = ?, approved_at = COALESCE(?, approved_at), next_run_at = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [status, opts?.blockedReason ?? null, opts?.approvedAt ?? null, opts?.nextRunAt ?? null, planId],
    );
  },

  updateStep(planId: string, stepId: string, update: {
    status?: PlanStepRow["status"];
    notes?: string | null;
    lastError?: string | null;
    assignedAgent?: string | null;
  }): void {
    const existing = getDb()
      .query("SELECT id FROM plan_steps WHERE id = ? AND plan_id = ?")
      .get(stepId, planId) as { id: string } | null;
    if (!existing) return;
    getDb().run(
      `UPDATE plan_steps
       SET status = COALESCE(?, status),
           notes = COALESCE(?, notes),
           last_error = COALESCE(?, last_error),
           assigned_agent = COALESCE(?, assigned_agent),
           updated_at = datetime('now')
       WHERE id = ? AND plan_id = ?`,
      [update.status ?? null, update.notes ?? null, update.lastError ?? null, update.assignedAgent ?? null, stepId, planId],
    );
    plans.refreshProgress(planId);
  },

  markRun(planId: string, nextRunAt?: string | null): void {
    getDb().run(
      "UPDATE plans SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now') WHERE id = ?",
      [nextRunAt ?? null, planId],
    );
  },

  refreshProgress(planId: string): void {
    const steps = plans.listSteps(planId);
    if (steps.length === 0) return;
    const hasFailed = steps.some((step) => step.status === "failed" || step.status === "blocked");
    const allDone = steps.every((step) => step.status === "done" || step.status === "cancelled");
    if (allDone) {
      plans.setStatus(planId, "done", { nextRunAt: null });
      return;
    }
    if (hasFailed) {
      plans.setStatus(planId, "blocked", { blockedReason: "a plan step is blocked or failed", nextRunAt: null });
      return;
    }
    plans.setStatus(planId, "active", { nextRunAt: new Date().toISOString() });
  },
};
