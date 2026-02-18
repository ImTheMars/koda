/**
 * Memory tools — Supermemory with user profiles, conversation ingestion, circuit breaker, and SQLite fallback.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import Supermemory from "supermemory";
import { messages as dbMessages, state as dbState } from "../db.js";
import { log } from "../log.js";

// --- Circuit breaker (inline) ---

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
  readonly client: Supermemory;
}

export function createMemoryProvider(apiKey: string): MemoryProvider {
  const client = new Supermemory({ apiKey });

  return {
    get isDegraded() { return isCircuitOpen(); },
    get client() { return client; },

    async store(userId, content, tags) {
      if (isCircuitOpen()) { log("memory", "circuit breaker tripped"); return { id: "unavailable" }; }
      log("memory", "store key=%s", content.slice(0, 80));
      try {
        const result = await client.memories.add({
          content,
          containerTag: `user-${userId}`,
          metadata: { user_id: userId, ...(tags?.length ? { tags: tags.join(",") } : {}) },
        });
        recordSuccess();
        return { id: result.id };
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
        log("memory", "recall: %d results", response.results.length);
        return response.results.map((r) => (r as any).memory ?? (r as any).chunk ?? "").filter(Boolean);
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
        const result = await (client as any).profile({
          containerTag: `user-${userId}`,
          ...(query ? { q: query } : {}),
          ...(query ? { threshold: 0.6 } : {}),
        });
        recordSuccess();
        const profile = result?.profile ?? {};
        const searchResults = result?.searchResults?.results ?? [];
        log("memory", "profile: static=%d dynamic=%d memories=%d", profile.static?.length ?? 0, profile.dynamic?.length ?? 0, searchResults.length);
        return {
          static: profile.static ?? [],
          dynamic: profile.dynamic ?? [],
          memories: searchResults.map((r: any) => r.memory ?? r.chunk ?? "").filter(Boolean),
        };
      } catch (err) {
        recordFailure();
        console.error("[memory] Profile fetch failed:", err);
        return { static: [], dynamic: [], memories: [] };
      }
    },

    async ingestConversation(sessionKey, userId, messages) {
      if (isCircuitOpen()) { log("memory", "ingest: circuit open, skipping"); return; }
      if (!messages.length) return;
      try {
        await (client as any).conversations.ingestOrUpdate({
          conversationId: sessionKey,
          containerTags: [`user-${userId}`],
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        recordSuccess();
        log("memory", "ingest: conversation %s (%d msgs)", sessionKey, messages.length);
      } catch (err) {
        recordFailure();
        console.error("[memory] Ingest failed:", err);
      }
    },

    async setupEntityContext(userId) {
      const stateKey = `sm_entity_ctx_${userId}`;
      if (dbState.get(stateKey)) return;
      if (isCircuitOpen()) return;
      try {
        await (client as any).containerTags.update(`user-${userId}`, {
          entityContext: `Ongoing conversations between this user and Koda (personal AI assistant). Focus on the user's preferences, corrections, personal facts, habits, and project context. Koda is their assistant — extract what matters for personalization.`,
        });
        dbState.set(stateKey, true);
        recordSuccess();
        log("memory", "entity context set for user %s", userId);
      } catch (err) {
        console.error("[memory] Entity context setup failed:", err);
      }
    },

    async healthCheck() {
      try { await client.search.memories({ q: "health", limit: 1 }); return true; }
      catch { return false; }
    },
  };
}

// --- Tools ---

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
