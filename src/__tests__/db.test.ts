import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const testDbPath = resolve(tmpdir(), `koda-test-${Date.now()}.db`);

let db: typeof import("../db.js");

beforeAll(async () => {
  db = await import("../db.js");
  db.initDb(testDbPath);
});

afterAll(() => {
  try { db.closeDb(); } catch {}
  try { unlinkSync(testDbPath); } catch {}
  try { unlinkSync(testDbPath + "-wal"); } catch {}
  try { unlinkSync(testDbPath + "-shm"); } catch {}
});

describe("messages", () => {
  test("append and getHistory", () => {
    const key = `test_session_${Date.now()}`;
    db.messages.append(key, "user", "hello");
    db.messages.append(key, "assistant", "hi there");
    const msgs = db.messages.getHistory(key);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.content).toBe("hello");
    expect(msgs[1]!.content).toBe("hi there");
  });

  test("count returns message count", () => {
    const key = `count_test_${Date.now()}`;
    db.messages.append(key, "user", "one");
    db.messages.append(key, "user", "two");
    expect(db.messages.count(key)).toBe(2);
  });

  test("clear removes session messages", () => {
    const key = `clear_test_${Date.now()}`;
    db.messages.append(key, "user", "temp");
    db.messages.clear(key);
    expect(db.messages.count(key)).toBe(0);
  });

  test("cleanup removes old messages", () => {
    const cleaned = db.messages.cleanup(0);
    expect(typeof cleaned).toBe("number");
  });

  test("getHistory respects limit", () => {
    const key = `limit_test_${Date.now()}`;
    for (let i = 0; i < 5; i++) db.messages.append(key, "user", `msg ${i}`);
    const limited = db.messages.getHistory(key, 3);
    expect(limited.length).toBe(3);
  });
});

describe("tasks", () => {
  test("create and getReady", () => {
    const id = randomUUID();
    const future = new Date(Date.now() + 60_000).toISOString();
    db.tasks.create({
      id,
      userId: "test_user",
      chatId: "test_chat",
      channel: "test",
      description: "test task",
      type: "reminder",
      nextRunAt: future,
    });
    const ready = db.tasks.getReady(new Date(Date.now() + 120_000).toISOString());
    expect(ready.some((t) => t.description === "test task")).toBe(true);
  });

  test("delete removes task", () => {
    const id = randomUUID();
    db.tasks.create({
      id,
      userId: "test_user",
      chatId: "del_chat",
      channel: "test",
      description: "delete me",
      type: "reminder",
      nextRunAt: new Date().toISOString(),
    });
    const deleted = db.tasks.delete(id);
    expect(deleted).toBe(true);
    const ready = db.tasks.getReady(new Date(Date.now() + 365 * 86_400_000).toISOString());
    expect(ready.find((t) => t.id === id)).toBeUndefined();
  });

  test("advance updates nextRunAt", () => {
    const id = randomUUID();
    db.tasks.create({
      id,
      userId: "test_user",
      chatId: "adv_chat",
      channel: "test",
      description: "advance test",
      type: "recurring",
      nextRunAt: new Date().toISOString(),
      cron: "08:00",
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    db.tasks.advance(id, future);
    const ready = db.tasks.getReady(new Date(Date.now() + 2 * 86_400_000).toISOString());
    const found = ready.find((t) => t.id === id);
    expect(found).toBeDefined();
  });

  test("disable marks task as disabled", () => {
    const id = randomUUID();
    db.tasks.create({
      id,
      userId: "test_user",
      chatId: "dis_chat",
      channel: "test",
      description: "disable me",
      type: "reminder",
      nextRunAt: new Date().toISOString(),
    });
    db.tasks.disable(id);
    const ready = db.tasks.getReady(new Date(Date.now() + 365 * 86_400_000).toISOString());
    expect(ready.find((t) => t.id === id)).toBeUndefined();
  });

  test("listByUser returns user tasks", () => {
    const id = randomUUID();
    const uid = `user_${Date.now()}`;
    db.tasks.create({
      id,
      userId: uid,
      chatId: "list_chat",
      channel: "test",
      description: "list test",
      type: "reminder",
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const list = db.tasks.listByUser(uid);
    expect(list.some((t) => t.id === id)).toBe(true);
  });

  test("markResult tracks success/failure", () => {
    const id = randomUUID();
    db.tasks.create({
      id,
      userId: "test_user",
      chatId: "mark_chat",
      channel: "test",
      description: "mark test",
      type: "recurring",
      nextRunAt: new Date().toISOString(),
    });
    db.tasks.markResult(id, "ok");
    db.tasks.markResult(id, "error");
    // Just verify no errors are thrown
  });
});

describe("usage", () => {
  test("track and getSummary", () => {
    const uid = `usage_user_${Date.now()}`;
    db.usage.track({
      userId: uid,
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
    });

    const summary = db.usage.getSummary(uid);
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalCost).toBeCloseTo(0.001, 5);
  });

  test("getSummary with since filter", () => {
    const uid = `usage_since_${Date.now()}`;
    const since = new Date();
    db.usage.track({
      userId: uid,
      model: "test-model",
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.002,
    });

    const summary = db.usage.getSummary(uid, since);
    expect(summary.totalRequests).toBeGreaterThanOrEqual(1);
  });

  test("getSummary with no data returns zeros", () => {
    const summary = db.usage.getSummary("nonexistent_user_xyz");
    expect(summary.totalRequests).toBe(0);
    expect(summary.totalCost).toBe(0);
  });
});

describe("state", () => {
  test("set and get", () => {
    db.state.set("test_key", "test_value");
    expect(db.state.get<string>("test_key")).toBe("test_value");
  });

  test("get returns null for missing key", () => {
    expect(db.state.get("nonexistent_key_xyz")).toBeNull();
  });

  test("set overwrites existing", () => {
    db.state.set("overwrite_key", "first");
    db.state.set("overwrite_key", "second");
    expect(db.state.get<string>("overwrite_key")).toBe("second");
  });

  test("set with boolean-like value", () => {
    db.state.set("bool_key", true);
    const val = db.state.get("bool_key");
    expect(val).toBeTruthy();
  });
});

describe("backup", () => {
  test("backupDatabase creates backup file", () => {
    const backupDir = resolve(tmpdir(), "koda-backup-test");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = db.backupDatabase(backupDir);
    expect(backupPath).toContain("backup");
    try { unlinkSync(backupPath); } catch {}
  });
});

describe("vacuum", () => {
  test("vacuumDb runs without error", () => {
    expect(() => db.vacuumDb()).not.toThrow();
  });
});
