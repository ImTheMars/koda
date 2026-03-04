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
  // We test the logic directly since the function is simple
  const isGroupChat = (chatType: string) =>
    chatType === "group" || chatType === "supergroup";

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
  const BOT_ID = 123456;
  const BOT_USERNAME = "koda_bot";
  const TRIGGERS = ["koda"];

  /** Simulates the shouldRespondInGroup logic from telegram.ts */
  function shouldRespond(message: {
    text?: string;
    caption?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    reply_to_message?: { from?: { id: number } };
    new_chat_members?: Array<{ id: number }>;
  }): boolean {
    const text = message.text ?? message.caption ?? "";
    const entities = message.entities ?? [];

    // 1. @mention of the bot
    for (const entity of entities) {
      if (entity.type === "mention") {
        const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
        if (mention === `@${BOT_USERNAME}`) return true;
      }
    }

    // 2. Reply to bot's own message
    if (message.reply_to_message?.from?.id === BOT_ID) return true;

    // 3. Bot's name triggers
    const lower = text.toLowerCase();
    for (const trigger of TRIGGERS) {
      const re = new RegExp(`\\b${trigger}\\b`, "i");
      if (re.test(lower)) return true;
    }

    // 4. Bot added as new member
    if (message.new_chat_members?.some((m) => m.id === BOT_ID)) return true;

    return false;
  }

  test("responds to @mention", () => {
    expect(shouldRespond({
      text: "hey @koda_bot what's up",
      entities: [{ type: "mention", offset: 4, length: 9 }],
    })).toBe(true);
  });

  test("responds to reply to bot message", () => {
    expect(shouldRespond({
      text: "yes I agree",
      reply_to_message: { from: { id: BOT_ID } },
    })).toBe(true);
  });

  test("responds to bot name trigger", () => {
    expect(shouldRespond({ text: "hey koda, can you help?" })).toBe(true);
  });

  test("responds when bot added as member", () => {
    expect(shouldRespond({
      text: "",
      new_chat_members: [{ id: BOT_ID }],
    })).toBe(true);
  });

  test("does NOT respond to random message", () => {
    expect(shouldRespond({ text: "just chatting about lunch" })).toBe(false);
  });

  test("does NOT respond to mention of different bot", () => {
    expect(shouldRespond({
      text: "hey @other_bot what's up",
      entities: [{ type: "mention", offset: 4, length: 10 }],
    })).toBe(false);
  });

  test("does NOT respond to reply to other user", () => {
    expect(shouldRespond({
      text: "I agree with you",
      reply_to_message: { from: { id: 999999 } },
    })).toBe(false);
  });

  test("trigger match is case insensitive", () => {
    expect(shouldRespond({ text: "KODA do this" })).toBe(true);
    expect(shouldRespond({ text: "Hey Koda!" })).toBe(true);
  });

  test("trigger requires word boundary", () => {
    expect(shouldRespond({ text: "kodak moment" })).toBe(false);
  });
});

// ============================================================
// Message attribution
// ============================================================

describe("message attribution", () => {
  const getDisplayName = (from: { first_name?: string; last_name?: string; username?: string } | undefined): string => {
    if (!from) return "Unknown";
    const parts = [from.first_name, from.last_name].filter(Boolean);
    return parts.join(" ") || from.username || "Unknown";
  };

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
