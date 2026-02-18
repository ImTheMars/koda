/**
 * Memory tools — Supermemory with circuit breaker and SQLite fallback.
 *
 * Uses the actual Supermemory SDK v4 API:
 *   client.documents.add(), client.search.memories(), client.settings.update()
 *
 * "Profile" is approximated via two search queries (static facts + dynamic context).
 * Conversation ingestion stores an assistant-memory entry after each exchange.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import Supermemory from "supermemory";
import { messages as dbMessages, state as dbState } from "../db.js";
import { log } from "../log.js";

// --- Circuit breaker ---

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
        // Static profile = general facts about the user
        // Dynamic context = recent/current situation, if there's a query
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
        return {
          static: staticFacts,
          dynamic: [],
          memories: queryMemories,
        };
      } catch (err) {
        recordFailure();
        console.error("[memory] Profile fetch failed:", err);
        return { static: [], dynamic: [], memories: [] };
      }
    },

    async ingestConversation(sessionKey, userId, messages) {
      if (isCircuitOpen()) { log("memory", "ingest: circuit open, skipping"); return; }
      // Only ingest the last user+assistant pair to avoid excessive API calls
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
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
      // Supermemory SDK v4 doesn't expose containerTags.update() — skip this step
      // Entity context is applied implicitly via the filter prompt set at boot
      dbState.set(stateKey, true);
      log("memory", "entity context skipped (not in SDK v4), marked as done for user %s", userId);
    },

    async healthCheck() {
      try {
        await client.search.memories({ q: "health", limit: 1 });
        return true;
      } catch {
        return false;
      }
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
