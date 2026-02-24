/**
 * Memory tools — Supermemory cloud provider with circuit-breaker.
 *
 * If no Supermemory API key is configured, memory is gracefully disabled (no-op).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import Supermemory from "supermemory";
import { messages as dbMessages, state as dbState } from "../db.js";
import { log } from "../log.js";
import type { Config } from "../config.js";

// --- Types ---

export interface UserProfile {
  static: string[];
  dynamic: string[];
  memories: string[];
}

export interface MemoryProvider {
  store(userId: string, content: string, tags?: string[]): Promise<{ id: string }>;
  recall(userId: string, query: string, limit?: number, sessionKey?: string): Promise<string[]>;
  getProfile(userId: string, query?: string, sessionKey?: string): Promise<UserProfile>;
  ingestConversation(sessionKey: string, userId: string, messages: Array<{ role: string; content: string }>): Promise<void>;
  setupEntityContext(userId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  readonly isDegraded: boolean;
  /** Optional Supermemory-specific one-time filter prompt setup. */
  setupCloudFilter?(): Promise<void>;
}

// ============================================================
// Supermemory (cloud, circuit-breaker guarded)
// ============================================================

let failures = 0;
let lastFailureTime = 0;
const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT_MS = 60_000;

function isCircuitOpen(): boolean {
  if (failures < FAILURE_THRESHOLD) return false;
  if (Date.now() - lastFailureTime >= RESET_TIMEOUT_MS) { failures = 0; return false; }
  return true;
}

function recordFailure(): void { failures++; lastFailureTime = Date.now(); }
function recordSuccess(): void { failures = 0; }

function createSupermemoryProvider(apiKey: string): MemoryProvider {
  const client = new Supermemory({ apiKey });

  return {
    get isDegraded() { return isCircuitOpen(); },

    async store(userId, content, tags) {
      if (isCircuitOpen()) { log("memory", "circuit breaker tripped"); return { id: "unavailable" }; }
      log("memory", "store user=%s len=%d", userId, content.length);
      try {
        const result = await client.documents.add({
          content,
          containerTag: `user-${userId}`,
          metadata: { user_id: userId, ...(tags?.length ? { tags: tags.join(",") } : {}) },
        });
        recordSuccess();
        return { id: (result as any).id ?? "ok" };
      } catch (err) {
        recordFailure();
        console.error("[memory] Store failed:", err);
        return { id: "unavailable" };
      }
    },

    async recall(userId, query, limit = 5, sessionKey) {
      if (isCircuitOpen()) {
        log("memory", "sqlite fallback");
        const history = dbMessages.getHistory(sessionKey ?? `telegram_${userId}`, 50);
        const lower = query.toLowerCase();
        return history
          .filter((m) => m.content.toLowerCase().includes(lower))
          .slice(0, limit)
          .map((m) => m.content);
      }
      try {
        const response = await client.search.memories({ q: query, containerTag: `user-${userId}`, limit });
        recordSuccess();
        const results = (response as any).results ?? [];
        log("memory", "recall: %d results", results.length);
        return results.map((r: any) => r.memory ?? r.chunk ?? r.content ?? "").filter(Boolean);
      } catch (err) {
        recordFailure();
        console.error("[memory] Recall failed:", err);
        return [];
      }
    },

    async getProfile(userId, query?, sessionKey?) {
      if (isCircuitOpen()) {
        log("memory", "profile: circuit open, sqlite fallback");
        const history = dbMessages.getHistory(sessionKey ?? `telegram_${userId}`, 30);
        const lower = query?.toLowerCase() ?? "";
        const fallbackMemories = lower
          ? history.filter((m) => m.content.toLowerCase().includes(lower)).slice(0, 5).map((m) => m.content)
          : [];
        return { static: [], dynamic: [], memories: fallbackMemories };
      }
      try {
        const [staticRes, dynamicRes] = await Promise.all([
          client.search.memories({ q: `who is this user, their background, preferences, and facts`, containerTag: `user-${userId}`, limit: 8 }),
          query ? client.search.memories({ q: query, containerTag: `user-${userId}`, limit: 5 }) : Promise.resolve(null),
        ]);
        recordSuccess();

        const toStrings = (res: any) =>
          ((res?.results ?? []) as any[]).map((r: any) => r.memory ?? r.chunk ?? r.content ?? "").filter(Boolean);

        const staticFacts = toStrings(staticRes);
        const queryMemories = dynamicRes ? toStrings(dynamicRes) : [];

        log("memory", "profile: static=%d memories=%d", staticFacts.length, queryMemories.length);
        return { static: staticFacts, dynamic: [], memories: queryMemories };
      } catch (err) {
        recordFailure();
        console.error("[memory] Profile fetch failed:", err);
        return { static: [], dynamic: [], memories: [] };
      }
    },

    async ingestConversation(sessionKey, userId, msgs) {
      if (isCircuitOpen()) { log("memory", "ingest: circuit open, skipping"); return; }
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      if (!lastUser || !lastAssistant) return;

      const summary = `Conversation excerpt:\nUser: ${lastUser.content.slice(0, 300)}\nKoda: ${lastAssistant.content.slice(0, 300)}`;
      try {
        await client.documents.add({
          content: summary,
          containerTag: `user-${userId}`,
          metadata: { session: sessionKey, type: "conversation" },
        });
        recordSuccess();
        log("memory", "ingest: stored conversation excerpt for session %s", sessionKey);
      } catch (err) {
        recordFailure();
        console.error("[memory] Ingest failed:", err);
      }
    },

    async setupEntityContext(userId) {
      const stateKey = `sm_entity_ctx_${userId}`;
      if (dbState.get(stateKey)) return;
      if (isCircuitOpen()) return;
      dbState.set(stateKey, true);
      log("memory", "entity context marked done for user %s", userId);
    },

    async healthCheck() {
      try {
        await client.search.memories({ q: "health", limit: 1 });
        return true;
      } catch {
        return false;
      }
    },

    async setupCloudFilter() {
      const FILTER_KEY = "supermemory_filter_set_v1";
      if (dbState.get(FILTER_KEY)) return;
      try {
        await (client as any).settings.update({
          shouldLLMFilter: true,
          filterPrompt: `Personal AI assistant called Koda. Prioritize:
- User preferences and habits (response style, tools, languages, workflows)
- Corrections and clarifications the user makes to Koda's responses
- Important personal facts (name, timezone, projects, roles, goals)
- Action items and outcomes (what worked, what didn't)
- Recurring topics and interests

Skip:
- Casual greetings and small talk with no informational content
- Tool call noise and intermediate processing steps
- System messages and error outputs
- Duplicate information already captured`,
        });
        dbState.set(FILTER_KEY, true);
        console.log("[boot] Supermemory filter prompt configured");
      } catch (err) {
        console.warn("[boot] Supermemory filter setup skipped:", (err as Error).message);
      }
    },
  };
}

// ============================================================
// Factory — Supermemory or disabled
// ============================================================

export function createMemoryProvider(config: Config): MemoryProvider {
  if (!config.supermemory?.apiKey) {
    console.warn("[memory] No Supermemory API key — memory disabled");
    return {
      get isDegraded() { return true; },
      async store() { return { id: "unavailable" }; },
      async recall() { return []; },
      async getProfile() { return { static: [], dynamic: [], memories: [] }; },
      async ingestConversation() {},
      async setupEntityContext() {},
      async healthCheck() { return false; },
    };
  }
  console.log("[memory] Using Supermemory cloud provider");
  return createSupermemoryProvider(config.supermemory.apiKey);
}

// ============================================================
// Tools
// ============================================================

export function registerMemoryTools(deps: { memory: MemoryProvider; getUserId: () => string }): ToolSet {
  const { memory, getUserId } = deps;

  const remember = tool({
    description: "Save important facts about the user to long-term memory. Use for preferences, names, schedules, and other personal info.",
    inputSchema: z.object({
      content: z.string().describe("The fact or information to remember"),
    }),
    execute: async ({ content }) => {
      const result = await memory.store(getUserId(), content);
      return { success: result.id !== "unavailable", id: result.id };
    },
  });

  const recall = tool({
    description: "Search long-term memory for facts and preferences about the user.",
    inputSchema: z.object({
      query: z.string().describe("What to search for in memory"),
      limit: z.number().min(1).max(50).optional().default(5),
    }),
    execute: async ({ query, limit }) => {
      const results = await memory.recall(getUserId(), query, limit);
      return { success: true, memories: results, count: results.length };
    },
  });

  return { remember, recall };
}
