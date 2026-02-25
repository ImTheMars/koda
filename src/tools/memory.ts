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
import { addToolCost } from "./index.js";

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
  /** Delete a memory by searching for matching content. */
  deleteByContent?(userId: string, query: string): Promise<boolean>;
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

// --- LLM-based memory extraction ---

interface MemoryFact {
  content: string;
  type: "preference" | "personal" | "project" | "decision" | "action" | "opinion";
  confidence: number;
}

async function extractMemoryFacts(
  messages: Array<{ role: string; content: string }>,
  existingFacts: string[],
  config: Config,
): Promise<MemoryFact[]> {
  try {
    const lastMessages = messages.slice(-6);
    const conversation = lastMessages.map((m) => `${m.role}: ${m.content.slice(0, 400)}`).join("\n");
    const existingStr = existingFacts.slice(0, 20).map((f) => `- ${f}`).join("\n");

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openrouter.fastModel,
        messages: [{
          role: "user",
          content: `Extract important facts from this conversation that are worth remembering long-term. Skip transient context, greetings, and small talk.

Each fact should be a single clear sentence. Types: preference, personal, project, decision, action, opinion.

Already known facts (DO NOT duplicate):
${existingStr || "(none)"}

Conversation:
${conversation}

Return JSON array of objects with {content, type, confidence} where confidence is 0.0-1.0. Return [] if nothing worth remembering. Only return the JSON array, nothing else.`,
        }],
        max_tokens: 500,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() ?? "[]";
    // Parse JSON — handle markdown code blocks
    const cleaned = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "");
    const facts = JSON.parse(cleaned) as MemoryFact[];
    addToolCost(0.001);
    return Array.isArray(facts) ? facts.filter((f) => f.content && f.confidence >= 0.5) : [];
  } catch (err) {
    log("memory", "extraction failed: %s", (err as Error).message);
    return [];
  }
}

function isDuplicate(newFact: string, existingFacts: string[]): boolean {
  const normalized = newFact.toLowerCase().trim();
  for (const existing of existingFacts) {
    const norm = existing.toLowerCase().trim();
    // Exact/near-exact match
    if (norm === normalized) return true;
    // Substring containment
    if (norm.includes(normalized) || normalized.includes(norm)) return true;
    // Word overlap
    const newWords = new Set(normalized.split(/\s+/));
    const existWords = new Set(norm.split(/\s+/));
    const intersection = [...newWords].filter((w) => existWords.has(w));
    const union = new Set([...newWords, ...existWords]);
    if (union.size > 0 && intersection.length / union.size > 0.8) return true;
  }
  return false;
}

// Rate limit: only run extraction every 3rd call per session
// Capped at 500 entries — evict oldest half when limit is reached
const ingestCallCounts = new Map<string, number>();
const INGEST_COUNT_CAP = 500;

function bumpIngestCount(sessionKey: string): number {
  const count = (ingestCallCounts.get(sessionKey) ?? 0) + 1;
  ingestCallCounts.set(sessionKey, count);
  if (ingestCallCounts.size > INGEST_COUNT_CAP) {
    // Delete the oldest half (Map iteration order = insertion order)
    const evict = Math.floor(INGEST_COUNT_CAP / 2);
    let i = 0;
    for (const key of ingestCallCounts.keys()) {
      if (i++ >= evict) break;
      ingestCallCounts.delete(key);
    }
  }
  return count;
}

function createSupermemoryProvider(apiKey: string, config?: Config): MemoryProvider {
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

      // Rate limit: only extract every 3rd call
      const count = bumpIngestCount(sessionKey);

      if (count % 3 !== 0 || !config) {
        // Fallback to simple excerpt storage
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
        return;
      }

      // Smart extraction: use LLM to extract structured facts
      try {
        const existingResults = await client.search.memories({
          q: "user preferences facts personal info",
          containerTag: `user-${userId}`,
          limit: 20,
        });
        recordSuccess();
        const existingFacts = ((existingResults as any).results ?? [])
          .map((r: any) => r.memory ?? r.chunk ?? r.content ?? "")
          .filter(Boolean);

        const facts = await extractMemoryFacts(msgs, existingFacts, config);
        let stored = 0;

        for (const fact of facts) {
          if (isDuplicate(fact.content, existingFacts)) {
            log("memory", "ingest: skipping duplicate: %s", fact.content.slice(0, 60));
            continue;
          }
          try {
            await client.documents.add({
              content: fact.content,
              containerTag: `user-${userId}`,
              metadata: {
                session: sessionKey,
                type: fact.type,
                confidence: String(fact.confidence),
                extracted: "true",
              },
            });
            existingFacts.push(fact.content);
            stored++;
          } catch (err) {
            recordFailure();
            console.error("[memory] Fact store failed:", err);
          }
        }
        if (stored > 0) log("memory", "ingest: extracted and stored %d facts for session %s", stored, sessionKey);
      } catch (err) {
        recordFailure();
        console.error("[memory] Smart ingest failed:", err);
      }
    },

    async deleteByContent(userId: string, query: string): Promise<boolean> {
      if (isCircuitOpen()) return false;
      try {
        const results = await client.search.memories({
          q: query,
          containerTag: `user-${userId}`,
          limit: 1,
        });
        recordSuccess();
        const docs = (results as any).results ?? [];
        if (docs.length === 0) return false;
        const docId = docs[0].id ?? docs[0].documentId;
        if (!docId) return false;
        await (client as any).documents.delete(docId);
        return true;
      } catch (err) {
        recordFailure();
        console.error("[memory] Delete failed:", err);
        return false;
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
  return createSupermemoryProvider(config.supermemory.apiKey, config);
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

  const deleteMemory = tool({
    description: "Delete a specific memory from long-term storage by searching for it.",
    inputSchema: z.object({
      query: z.string().describe("Search query to find the memory to delete"),
    }),
    execute: async ({ query }) => {
      if (!memory.deleteByContent) return { success: false, error: "Delete not supported" };
      const deleted = await memory.deleteByContent(getUserId(), query);
      return { success: deleted, message: deleted ? "Memory deleted" : "Memory not found" };
    },
  });

  return { remember, recall, deleteMemory };
}
