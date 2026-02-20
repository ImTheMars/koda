/**
 * Memory tools — dual-provider: Supermemory cloud or local SQLite + Ollama embeddings.
 *
 * Provider selection (in priority order):
 *   1. Local embeddings  — if config.embeddings.enabled (Ollama + cosine similarity)
 *   2. Supermemory cloud — if config.supermemory.apiKey is set
 *   3. Stub (SQLite keyword fallback) — if neither is configured
 *
 * All providers implement the same MemoryProvider interface, so the rest of the
 * codebase is completely unaware of which backend is active.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import Supermemory from "supermemory";
import { messages as dbMessages, state as dbState, vectorMemories } from "../db.js";
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
// Provider 1: Supermemory (cloud, circuit-breaker guarded)
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
// Provider 2: Local (Ollama embeddings + SQLite + cosine sim)
// ============================================================

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA * normB) || 1);
}

async function ollamaEmbed(ollamaUrl: string, model: string, text: string): Promise<Float32Array> {
  const res = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
  const data = await res.json() as { embedding: number[] };
  if (!Array.isArray(data.embedding)) throw new Error("Ollama embed: missing embedding field");
  return new Float32Array(data.embedding);
}

function createLocalMemoryProvider(ollamaUrl: string, embeddingModel: string, maxMemoriesPerUser: number): MemoryProvider {
  async function storeVec(userId: string, content: string): Promise<void> {
    const vec = await ollamaEmbed(ollamaUrl, embeddingModel, content);
    vectorMemories.insert(userId, content, vec);
    if (vectorMemories.count(userId) > maxMemoriesPerUser) {
      vectorMemories.deleteOldest(userId, maxMemoriesPerUser);
    }
  }

  async function recallVec(userId: string, query: string, limit: number): Promise<string[]> {
    const queryVec = await ollamaEmbed(ollamaUrl, embeddingModel, query);
    const rows = vectorMemories.listByUser(userId);
    const scored = rows.map((row) => {
      const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      return { content: row.content, score: cosineSimilarity(queryVec, emb) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((r) => r.content);
  }

  return {
    get isDegraded() { return false; },

    async store(userId, content) {
      try {
        await storeVec(userId, content);
        return { id: "local" };
      } catch (err) {
        console.error("[memory:local] store failed:", (err as Error).message);
        return { id: "unavailable" };
      }
    },

    async recall(userId, query, limit = 5) {
      try {
        return await recallVec(userId, query, limit);
      } catch (err) {
        console.error("[memory:local] recall failed:", (err as Error).message);
        return [];
      }
    },

    async getProfile(userId, query?) {
      try {
        const [staticResults, dynamicResults] = await Promise.all([
          recallVec(userId, "user preferences background facts interests goals", 5),
          query ? recallVec(userId, query, 5) : Promise.resolve([]),
        ]);
        return { static: staticResults, dynamic: [], memories: dynamicResults };
      } catch {
        return { static: [], dynamic: [], memories: [] };
      }
    },

    async ingestConversation(sessionKey, userId, msgs) {
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      if (!lastUser || !lastAssistant) return;
      const summary = `Session ${sessionKey}:\nUser: ${lastUser.content.slice(0, 300)}\nKoda: ${lastAssistant.content.slice(0, 300)}`;
      try {
        await storeVec(userId, summary);
        log("memory", "local ingest: stored for session %s", sessionKey);
      } catch (err) {
        console.error("[memory:local] ingest failed:", (err as Error).message);
      }
    },

    async setupEntityContext() {
      // No-op: local provider has no external entity context concept
    },

    async healthCheck() {
      try {
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

// ============================================================
// Provider 3: Stub (SQLite keyword search, no vector ops)
// ============================================================

function createStubMemoryProvider(): MemoryProvider {
  return {
    get isDegraded() { return true; },

    async store() {
      return { id: "unavailable" };
    },

    async recall(userId, query, limit = 5, sessionKey) {
      const history = dbMessages.getHistory(sessionKey ?? `sqlite_${userId}`, 50);
      const lower = query.toLowerCase();
      return history
        .filter((m) => m.content.toLowerCase().includes(lower))
        .slice(0, limit)
        .map((m) => m.content);
    },

    async getProfile(userId, query?, sessionKey?) {
      const memories = query
        ? (await this.recall(userId, query, 5, sessionKey))
        : [];
      return { static: [], dynamic: [], memories };
    },

    async ingestConversation() {
      // No-op: stub cannot persist semantics without a vector store
    },

    async setupEntityContext() {},

    async healthCheck() { return false; },
  };
}

// ============================================================
// Factory — selects provider based on config
// ============================================================

export function createMemoryProvider(config: Config): MemoryProvider {
  if (config.embeddings?.enabled) {
    const { ollamaUrl, model, maxMemories } = config.embeddings;
    console.log(`[memory] Using local embeddings (Ollama: ${model} @ ${ollamaUrl})`);
    return createLocalMemoryProvider(ollamaUrl, model, maxMemories);
  }

  if (config.supermemory?.apiKey) {
    console.log("[memory] Using Supermemory cloud provider");
    return createSupermemoryProvider(config.supermemory.apiKey);
  }

  console.log("[memory] No vector store configured — using SQLite keyword fallback");
  return createStubMemoryProvider();
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
