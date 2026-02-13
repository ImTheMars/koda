/**
 * Memory tools — Supermemory with inline circuit breaker + SQLite fallback.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import Supermemory from "supermemory";
import { messages as dbMessages } from "../db.js";

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

// --- Provider ---

export interface MemoryProvider {
  store(userId: string, content: string, tags?: string[]): Promise<{ id: string }>;
  recall(userId: string, query: string, limit?: number): Promise<string[]>;
  delete(memoryId: string): Promise<boolean>;
  healthCheck(): Promise<boolean>;
  readonly isDegraded: boolean;
}

export function createMemoryProvider(apiKey: string): MemoryProvider {
  const client = new Supermemory({ apiKey });

  return {
    get isDegraded() { return isCircuitOpen(); },

    async store(userId, content, tags) {
      if (isCircuitOpen()) return { id: "unavailable" };
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

    async recall(userId, query, limit = 5) {
      if (isCircuitOpen()) {
        // SQLite fallback — keyword search on messages table
        const history = dbMessages.getHistory(`telegram_${userId}`, 50);
        const lower = query.toLowerCase();
        return history
          .filter((m) => m.content.toLowerCase().includes(lower))
          .slice(0, limit)
          .map((m) => m.content);
      }
      try {
        const response = await client.search.memories({ q: query, containerTag: `user-${userId}`, limit });
        recordSuccess();
        return response.results.map((r) => r.memory ?? "");
      } catch (err) {
        recordFailure();
        console.error("[memory] Recall failed:", err);
        return [];
      }
    },

    async delete(memoryId) {
      try { await client.memories.delete(memoryId); return true; }
      catch { return false; }
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

  const deleteMemory = tool({
    description: "Delete a specific memory by ID.",
    inputSchema: z.object({ memoryId: z.string() }),
    execute: async ({ memoryId }) => ({ success: await memory.delete(memoryId) }),
  });

  return { remember, recall, deleteMemory };
}
