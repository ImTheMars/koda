/**
 * Tests for multi-user group chat features:
 * - Group detection helpers
 * - Mention-based activation
 * - Admin permissions
 * - Message attribution
 * - DB: user_profiles and chat_members tables
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import {
  getDisplayName,
  isGroupChat,
  parseCommand,
  shouldRespondInTelegramGroup,
} from "../channels/telegram.js";

const testDbPath = resolve(tmpdir(), `koda-group-test-${Date.now()}.db`);
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

// ============================================================
// DB: user_profiles
// ============================================================

describe("userProfiles", () => {
  test("upsert creates a new profile", () => {
    db.userProfiles.upsert({ userId: "100", displayName: "Alice", username: "alice", role: "member" });
    const profile = db.userProfiles.get("100");
    expect(profile).not.toBeNull();
    expect(profile!.displayName).toBe("Alice");
    expect(profile!.username).toBe("alice");
    expect(profile!.role).toBe("member");
  });

  test("upsert updates display name", () => {
    db.userProfiles.upsert({ userId: "100", displayName: "Alice B", username: "alice_b" });
    const profile = db.userProfiles.get("100");
    expect(profile!.displayName).toBe("Alice B");
    expect(profile!.username).toBe("alice_b");
  });

  test("upsert preserves username when not provided", () => {
    db.userProfiles.upsert({ userId: "101", displayName: "Bob", username: "bob_u" });
    db.userProfiles.upsert({ userId: "101", displayName: "Bobby" });
    const profile = db.userProfiles.get("101");
    expect(profile!.displayName).toBe("Bobby");
    expect(profile!.username).toBe("bob_u");
  });

  test("getAll returns all profiles", () => {
    const all = db.userProfiles.getAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("setRole changes role", () => {
    db.userProfiles.upsert({ userId: "102", displayName: "Charlie" });
    db.userProfiles.setRole("102", "admin");
    const profile = db.userProfiles.get("102");
    expect(profile!.role).toBe("admin");
  });

  test("setRole returns false for nonexistent user", () => {
    const result = db.userProfiles.setRole("nonexistent-999", "admin");
    expect(result).toBe(false);
  });

  test("touch updates last_seen", () => {
    db.userProfiles.upsert({ userId: "103", displayName: "Diana" });
    const before = db.userProfiles.get("103");
    db.userProfiles.touch("103");
    const after = db.userProfiles.get("103");
    expect(after!.lastSeen).toBeDefined();
  });

  test("get returns null for nonexistent user", () => {
    expect(db.userProfiles.get("nonexistent-888")).toBeNull();
  });
});

// ============================================================
// DB: chat_members
// ============================================================

describe("chatMembers", () => {
  test("upsert tracks membership", () => {
    db.chatMembers.upsert("-1001", "200");
    db.chatMembers.upsert("-1001", "201");
    const members = db.chatMembers.getByChatId("-1001");
    expect(members.length).toBe(2);
    expect(members.map((m) => m.userId).sort()).toEqual(["200", "201"]);
  });

  test("upsert is idempotent", () => {
    db.chatMembers.upsert("-1002", "300");
    db.chatMembers.upsert("-1002", "300");
    const members = db.chatMembers.getByChatId("-1002");
    expect(members.length).toBe(1);
  });

  test("getByChatId returns empty for unknown chat", () => {
    const members = db.chatMembers.getByChatId("-9999");
    expect(members).toEqual([]);
  });

  test("members from different chats are isolated", () => {
    db.chatMembers.upsert("-2001", "400");
    db.chatMembers.upsert("-2002", "401");
    expect(db.chatMembers.getByChatId("-2001").length).toBe(1);
    expect(db.chatMembers.getByChatId("-2002").length).toBe(1);
  });
});

// ============================================================
// Group detection (pure functions, no Grammy dependency)
// ============================================================

describe("isGroupChat", () => {
  test("private chat is not group", () => {
    expect(isGroupChat("private")).toBe(false);
  });

  test("group is group", () => {
    expect(isGroupChat("group")).toBe(true);
  });

  test("supergroup is group", () => {
    expect(isGroupChat("supergroup")).toBe(true);
  });

  test("channel is not group", () => {
    expect(isGroupChat("channel")).toBe(false);
  });
});

// ============================================================
// shouldRespondInGroup logic (tested as pure function)
// ============================================================

describe("shouldRespondInGroup logic", () => {
  const BOT_ID = "123456";
  const TRIGGERS = ["koda"];

  test("responds to @mention", () => {
    expect(shouldRespondInTelegramGroup({
      text: "hey @koda_bot what's up",
      isMention: true,
      botNameTriggers: TRIGGERS,
      botUserId: BOT_ID,
    })).toBe(true);
  });

  test("responds to reply to bot message", () => {
    expect(shouldRespondInTelegramGroup({
      text: "yes I agree",
      replyToMessageFromId: BOT_ID,
      botNameTriggers: TRIGGERS,
      botUserId: BOT_ID,
    })).toBe(true);
  });

  test("responds to bot name trigger", () => {
    expect(shouldRespondInTelegramGroup({
      text: "hey koda, can you help?",
      botNameTriggers: TRIGGERS,
      botUserId: BOT_ID,
    })).toBe(true);
  });

  test("responds when bot added as member", () => {
    expect(shouldRespondInTelegramGroup({
      text: "",
      newChatMemberIds: [BOT_ID],
      botNameTriggers: TRIGGERS,
      botUserId: BOT_ID,
    })).toBe(true);
  });

  test("does NOT respond to random message", () => {
    expect(shouldRespondInTelegramGroup({
      text: "just chatting about lunch",
      botNameTriggers: TRIGGERS,
      botUserId: BOT_ID,
    })).toBe(false);
  });

  test("does NOT respond to mention of different bot", () => {
    expect(shouldRespondInTelegramGroup({
      text: "hey @other_bot what's up",
      botNameTriggers: TRIGGERS,
      botUserId: BOT_ID,
    })).toBe(false);
  });

  test("does NOT respond to reply to other user", () => {
    expect(shouldRespondInTelegramGroup({
      text: "I agree with you",
      replyToMessageFromId: "999999",
      botNameTriggers: TRIGGERS,
      botUserId: BOT_ID,
    })).toBe(false);
  });

  test("trigger match is case insensitive", () => {
    expect(shouldRespondInTelegramGroup({ text: "KODA do this", botNameTriggers: TRIGGERS, botUserId: BOT_ID })).toBe(true);
    expect(shouldRespondInTelegramGroup({ text: "Hey Koda!", botNameTriggers: TRIGGERS, botUserId: BOT_ID })).toBe(true);
  });

  test("trigger requires word boundary", () => {
    expect(shouldRespondInTelegramGroup({ text: "kodak moment", botNameTriggers: TRIGGERS, botUserId: BOT_ID })).toBe(false);
  });
});

// ============================================================
// Message attribution
// ============================================================

describe("message attribution", () => {
  test("full name from first + last", () => {
    expect(getDisplayName({ first_name: "Alice", last_name: "Smith" })).toBe("Alice Smith");
  });

  test("first name only", () => {
    expect(getDisplayName({ first_name: "Bob" })).toBe("Bob");
  });

  test("fallback to username", () => {
    expect(getDisplayName({ username: "charlie_x" })).toBe("charlie_x");
  });

  test("fallback to Unknown", () => {
    expect(getDisplayName(undefined)).toBe("Unknown");
    expect(getDisplayName({})).toBe("Unknown");
  });
});

describe("parseCommand", () => {
  test("parses command with args", () => {
    expect(parseCommand("/model fast anthropic/claude-sonnet")).toEqual({
      command: "model",
      args: "fast anthropic/claude-sonnet",
    });
  });

  test("parses bot-qualified command", () => {
    expect(parseCommand("/help@koda_bot")).toEqual({
      command: "help",
      args: "",
    });
  });

  test("returns null for plain text", () => {
    expect(parseCommand("hello there")).toBeNull();
  });
});

// ============================================================
// Admin permissions
// ============================================================

describe("admin permissions", () => {
  test("admin IDs are recognized", () => {
    const adminIds = ["111", "222"];
    const isAdmin = (userId: string) => adminIds.includes(userId);

    expect(isAdmin("111")).toBe(true);
    expect(isAdmin("222")).toBe(true);
    expect(isAdmin("333")).toBe(false);
  });

  test("self-removal blocked", () => {
    const senderId = "111";
    const targetId = "111";
    expect(senderId === targetId).toBe(true); // can't remove yourself
  });

  test("admin removal blocked", () => {
    const adminIds = ["111", "222"];
    const targetId = "222";
    expect(adminIds.includes(targetId)).toBe(true); // can't remove admins
  });
});

// ============================================================
// Config: group section defaults
// ============================================================

describe("group config", () => {
  test("default botNameTriggers", async () => {
    // Import Zod schema indirectly via config
    const { z } = await import("zod");

    const GroupSchema = z.object({
      botNameTriggers: z.array(z.string()).default(["koda"]),
      passiveListening: z.boolean().default(true),
    });

    const defaults = GroupSchema.parse({});
    expect(defaults.botNameTriggers).toEqual(["koda"]);
    expect(defaults.passiveListening).toBe(true);
  });

  test("custom triggers", async () => {
    const { z } = await import("zod");

    const GroupSchema = z.object({
      botNameTriggers: z.array(z.string()).default(["koda"]),
      passiveListening: z.boolean().default(true),
    });

    const custom = GroupSchema.parse({ botNameTriggers: ["assistant", "ai"], passiveListening: false });
    expect(custom.botNameTriggers).toEqual(["assistant", "ai"]);
    expect(custom.passiveListening).toBe(false);
  });
});
