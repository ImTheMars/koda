/**
 * Memory tools — Supermemory cloud provider with circuit-breaker.
 *
 * If no Supermemory API key is configured, memory is gracefully disabled (no-op).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import Supermemory from "supermemory";
import { messages as dbMessages, state as dbState, assessment as dbAssessment } from "../db.js";
import { log, logWarn, logError } from "../log.js";
import type { Config } from "../config.js";
import { addToolCost } from "./index.js";

// --- Types ---

/** Helper to extract search result text from various Supermemory response shapes. */
function extractMemoryText(r: { memory?: string; chunk?: string; content?: string }): string {
  return r.memory ?? r.chunk ?? r.content ?? "";
}

export interface UserProfile {
  static: string[];
  dynamic: string[];
  memories: string[];
}

export interface MemoryProvider {
  store(userId: string, content: string, tags?: string[]): Promise<{ id: string }>;
  recall(userId: string, query: string, limit?: number, sessionKey?: string): Promise<string[]>;
  getProfile(userId: string, query?: string, sessionKey?: string): Promise<UserProfile>;
  ingestConversation(sessionKey: string, userId: string, messages: Array<{ role: string; content: string }>, chatId?: string): Promise<void>;
  setupEntityContext(userId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  readonly isDegraded: boolean;
  /** Delete a memory by searching for matching content. */
  deleteByContent?(userId: string, query: string): Promise<boolean>;
  /** Optional Supermemory-specific one-time filter prompt setup. */
  setupCloudFilter?(): Promise<void>;
  /** Store a fact into shared project memory. */
  storeProject?(chatId: string, content: string, tags?: string[]): Promise<{ id: string }>;
  /** Search shared project memory. */
  recallProject?(chatId: string, query: string, limit?: number): Promise<string[]>;
  /** Get project profile + query-relevant memories for system prompt. */
  getProjectMemories?(chatId: string, query: string): Promise<{ static: string[]; memories: string[] }>;
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
  type: "preference" | "personal" | "project" | "decision" | "action" | "opinion" | "correction";
  confidence: number;
  replaces?: string;
}

function inferDomainFromText(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(work|job|project|team|business|deploy|code|product)\b/.test(lower)) return "work";
  if (/\b(health|sleep|gym|workout|diet|energy|stress)\b/.test(lower)) return "health";
  if (/\b(money|budget|finance|income|expense|debt|savings)\b/.test(lower)) return "finances";
  if (/\b(learn|study|course|read|practice)\b/.test(lower)) return "learning";
  if (/\b(friend|family|partner|relationship)\b/.test(lower)) return "relationships";
  return "general";
}

function maybeExtractGoal(text: string): { title: string; domain: string; successCriteria: string | null } | null {
  const lower = text.toLowerCase();
  const match =
    lower.match(/\b(?:i want to|i'm trying to|i am trying to|my goal is to|i need to|i plan to)\s+(.+)/i) ??
    lower.match(/\bgoal:\s*(.+)/i);
  if (!match) return null;
  const title = text.slice(text.toLowerCase().indexOf(match[1]!.toLowerCase())).trim().replace(/[.]+$/, "");
  if (!title) return null;
  return {
    title,
    domain: inferDomainFromText(title),
    successCriteria: null,
  };
}

function storeAssessmentEvidence(userId: string, fact: MemoryFact, source: string): void {
  const domain = inferDomainFromText(fact.content);
  dbAssessment.addObservation({
    id: `obs-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    domain,
    statement: fact.content,
    source,
    evidenceType: fact.type,
    confidence: fact.confidence,
    contradicts: fact.replaces ?? null,
    observedAt: new Date().toISOString(),
  });

  const goal = maybeExtractGoal(fact.content);
  if (goal) {
    dbAssessment.upsertGoal({
      id: `goal-${crypto.randomUUID().slice(0, 8)}`,
      userId,
      title: goal.title,
      domain: goal.domain,
      status: "active",
      successCriteria: goal.successCriteria,
      confidence: fact.confidence,
      notes: `inferred from ${source}`,
    });
  }
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

Also identify facts that CONTRADICT the existing known facts below. For contradictions, use type: "correction" and include a "replaces" field with the old fact text it replaces.

Already known facts (DO NOT duplicate):
${existingStr || "(none)"}

Conversation:
${conversation}

Return JSON array of objects with {content, type, confidence, replaces?} where confidence is 0.0-1.0. Return [] if nothing worth remembering. Only return the JSON array, nothing else.`,
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

/** Extract project-level facts from a group conversation (decisions, goals, action items, responsibilities). */
async function extractProjectFacts(
  messages: Array<{ role: string; content: string }>,
  config: Config,
): Promise<MemoryFact[]> {
  try {
    const lastMessages = messages.slice(-6);
    const conversation = lastMessages.map((m) => `${m.role}: ${m.content.slice(0, 400)}`).join("\n");

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
          content: `Extract project-level facts from this group conversation. Focus on:
- Decisions made by the team
- Goals and milestones discussed
- Action items and who is responsible
- Business strategy or direction changes
- Key project facts or constraints

Skip personal preferences, greetings, and small talk. Each fact should be a clear sentence.

Conversation:
${conversation}

Return JSON array of objects with {content, type, confidence} where type is one of: decision, action, project, opinion. confidence is 0.0-1.0. Return [] if nothing worth remembering. Only return the JSON array, nothing else.`,
        }],
        max_tokens: 500,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() ?? "[]";
    const cleaned = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "");
    const facts = JSON.parse(cleaned) as MemoryFact[];
    addToolCost(0.001);
    return Array.isArray(facts) ? facts.filter((f) => f.content && f.confidence >= 0.5) : [];
  } catch (err) {
    log("memory", "project extraction failed: %s", (err as Error).message);
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

/** Consolidation pass: merge duplicate/related memories via fast LLM. */
async function consolidateMemories(client: Supermemory, userId: string, config: Config): Promise<void> {
  try {
    const res = await client.search.memories({
      q: "user preferences facts personal info decisions projects",
      containerTag: `user-${userId}`,
      limit: 50,
    });
    const memories = ((res as { results?: Array<{ id?: string; documentId?: string; memory?: string; chunk?: string; content?: string }> }).results ?? [])
      .map((r) => ({ id: r.id ?? r.documentId ?? "", content: extractMemoryText(r) }))
      .filter((m) => m.content && m.id);

    if (memories.length < 10) return; // not enough to consolidate

    const memoryList = memories.map((m, i) => `${i + 1}. ${m.content}`).join("\n");

    const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openrouter.fastModel,
        messages: [{
          role: "user",
          content: `Merge duplicates and combine related facts from this memory list. Return a consolidated JSON array of strings (one fact per string). Remove exact duplicates and merge related facts into single concise statements.

Memories:
${memoryList}

Return only the JSON array of consolidated fact strings, nothing else.`,
        }],
        max_tokens: 1000,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!llmRes.ok) return;
    const data = await llmRes.json();
    const text = data.choices?.[0]?.message?.content?.trim() ?? "[]";
    const cleaned = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "");
    const consolidated = JSON.parse(cleaned) as string[];
    if (!Array.isArray(consolidated) || consolidated.length === 0) return;

    // Only proceed if consolidation actually reduced the count
    if (consolidated.length >= memories.length) return;

    // Delete old memories
    for (const mem of memories) {
      try { await client.documents.delete(mem.id); } catch { /* skip */ }
    }

    // Store consolidated memories
    for (const fact of consolidated) {
      if (typeof fact !== "string" || !fact.trim()) continue;
      await client.add({
        content: fact,
        containerTag: `user-${userId}`,
        metadata: { type: "consolidated", extracted: "true" },
      });
    }

    addToolCost(0.002);
    log("memory", "consolidation: %d → %d memories for user %s", memories.length, consolidated.length, userId);
  } catch (err) {
    log("memory", "consolidation error: %s", (err as Error).message);
  }
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

const USER_ENTITY_CONTEXT = (displayName?: string) =>
  `Personal AI memory for ${displayName ?? "a user"}. Store: preferences, communication style, project contributions, decisions, work patterns, goals.`;

const PROJECT_ENTITY_CONTEXT =
  "Shared project memory for a business collaboration. Store: decisions, goals, action items, milestones, business strategy, responsibilities.";

function createSupermemoryProvider(apiKey: string, config?: Config): MemoryProvider {
  const client = new Supermemory({ apiKey });

  return {
    get isDegraded() { return isCircuitOpen(); },

    async store(userId, content, tags) {
      if (isCircuitOpen()) { log("memory", "circuit breaker tripped"); return { id: "unavailable" }; }
      log("memory", "store user=%s len=%d", userId, content.length);
      try {
        const result = await client.add({
          content,
          containerTag: `user-${userId}`,
          entityContext: USER_ENTITY_CONTEXT(),
          metadata: { user_id: userId, ...(tags?.length ? { tags: tags.join(",") } : {}) },
        });
        recordSuccess();
        return { id: result.id ?? "ok" };
      } catch (err) {
        recordFailure();
        logError("memory", "store failed", err);
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
        const results = (response as { results?: Array<{ memory?: string; chunk?: string; content?: string }> }).results ?? [];
        log("memory", "recall: %d results", results.length);
        return results.map((r) => extractMemoryText(r)).filter(Boolean);
      } catch (err) {
        recordFailure();
        logError("memory", "recall failed", err);
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
        const profileRes = await client.profile({
          containerTag: `user-${userId}`,
          ...(query ? { q: query } : {}),
        });
        recordSuccess();

        const staticFacts = profileRes.profile?.static ?? [];
        const dynamicFacts = profileRes.profile?.dynamic ?? [];
        const searchResults = (profileRes.searchResults as { results?: Array<{ memory?: string; chunk?: string; content?: string }> } | undefined)
          ?.results ?? [];
        const queryMemories = searchResults.map((r) => extractMemoryText(r)).filter(Boolean);

        log("memory", "profile: static=%d dynamic=%d memories=%d", staticFacts.length, dynamicFacts.length, queryMemories.length);
        return { static: staticFacts, dynamic: dynamicFacts, memories: queryMemories };
      } catch (err) {
        recordFailure();
        logError("memory", "profile fetch failed", err);
        return { static: [], dynamic: [], memories: [] };
      }
    },

    async ingestConversation(sessionKey, userId, msgs, chatId?) {
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
          await client.add({
            content: summary,
            containerTag: `user-${userId}`,
            entityContext: USER_ENTITY_CONTEXT(),
            metadata: { session: sessionKey, type: "conversation" },
          });
          recordSuccess();
          log("memory", "ingest: stored conversation excerpt for session %s", sessionKey);
        } catch (err) {
          recordFailure();
          logError("memory", "ingest failed", err);
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
        const existingFacts = ((existingResults as { results?: Array<{ memory?: string; chunk?: string; content?: string }> }).results ?? [])
          .map((r) => extractMemoryText(r))
          .filter(Boolean);

        const facts = await extractMemoryFacts(msgs, existingFacts, config);
        let stored = 0;

        for (const fact of facts) {
          // Handle contradiction/correction via updateMemory
          if (fact.type === "correction" && fact.replaces) {
            try {
              await client.memories.updateMemory({
                containerTag: `user-${userId}`,
                content: fact.replaces,
                newContent: fact.content,
              });
              log("memory", "ingest: updated contradicted fact: %s → %s", fact.replaces.slice(0, 40), fact.content.slice(0, 40));
              existingFacts.push(fact.content);
              stored++;
              continue;
            } catch {
              // updateMemory failed (old fact not found) — fall through to add
            }
          }

          if (isDuplicate(fact.content, existingFacts)) {
            log("memory", "ingest: skipping duplicate: %s", fact.content.slice(0, 60));
            continue;
          }
          try {
            await client.add({
              content: fact.content,
              containerTag: `user-${userId}`,
              entityContext: USER_ENTITY_CONTEXT(),
              metadata: {
                session: sessionKey,
                type: fact.type,
                confidence: String(fact.confidence),
                extracted: "true",
              },
            });
            existingFacts.push(fact.content);
            stored++;
            try {
              storeAssessmentEvidence(userId, fact, "memory-extraction");
            } catch (err) {
              log("memory", "assessment evidence store failed: %s", (err as Error).message);
            }
          } catch (err) {
            recordFailure();
            logError("memory", "fact store failed", err);
          }
        }
        if (stored > 0) log("memory", "ingest: extracted and stored %d facts for session %s", stored, sessionKey);

        // Group chat: also extract project-level facts into project container
        if (chatId && chatId.startsWith("-")) {
          try {
            const projectFacts = await extractProjectFacts(msgs, config);
            let projectStored = 0;
            for (const fact of projectFacts) {
              try {
                await client.add({
                  content: fact.content,
                  containerTag: `project-${chatId}`,
                  entityContext: PROJECT_ENTITY_CONTEXT,
                  metadata: { session: sessionKey, type: fact.type, extracted: "true" },
                });
                projectStored++;
              } catch (err) {
                logError("memory", "project fact store failed", err);
              }
            }
            if (projectStored > 0) log("memory", "ingest: stored %d project facts for chat %s", projectStored, chatId);
          } catch (err) {
            log("memory", "project extraction failed: %s", (err as Error).message);
          }
        }

        // Periodic consolidation: every Nth ingest, merge duplicates
        if (config.features?.memoryConsolidationInterval &&
            count % config.features.memoryConsolidationInterval === 0) {
          consolidateMemories(client, userId, config).catch((err) => {
            log("memory", "consolidation failed: %s", (err as Error).message);
          });
        }
      } catch (err) {
        recordFailure();
        logError("memory", "smart ingest failed", err);
      }
    },

    async deleteByContent(userId: string, query: string): Promise<boolean> {
      if (isCircuitOpen()) return false;
      try {
        await client.memories.forget({
          containerTag: `user-${userId}`,
          content: query,
        });
        recordSuccess();
        return true;
      } catch (err) {
        recordFailure();
        logError("memory", "delete failed", err);
        return false;
      }
    },

    async storeProject(chatId: string, content: string, tags?: string[]): Promise<{ id: string }> {
      if (isCircuitOpen()) { log("memory", "circuit breaker tripped"); return { id: "unavailable" }; }
      log("memory", "storeProject chat=%s len=%d", chatId, content.length);
      try {
        const result = await client.add({
          content,
          containerTag: `project-${chatId}`,
          entityContext: PROJECT_ENTITY_CONTEXT,
          metadata: { chat_id: chatId, ...(tags?.length ? { tags: tags.join(",") } : {}) },
        });
        recordSuccess();
        return { id: result.id ?? "ok" };
      } catch (err) {
        recordFailure();
        logError("memory", "storeProject failed", err);
        return { id: "unavailable" };
      }
    },

    async recallProject(chatId: string, query: string, limit = 5): Promise<string[]> {
      if (isCircuitOpen()) return [];
      try {
        const response = await client.search.memories({ q: query, containerTag: `project-${chatId}`, limit });
        recordSuccess();
        const results = (response as { results?: Array<{ memory?: string; chunk?: string; content?: string }> }).results ?? [];
        log("memory", "recallProject: %d results", results.length);
        return results.map((r) => extractMemoryText(r)).filter(Boolean);
      } catch (err) {
        recordFailure();
        logError("memory", "recallProject failed", err);
        return [];
      }
    },

    async getProjectMemories(chatId: string, query: string): Promise<{ static: string[]; memories: string[] }> {
      if (isCircuitOpen()) return { static: [], memories: [] };
      try {
        const profileRes = await client.profile({
          containerTag: `project-${chatId}`,
          ...(query ? { q: query } : {}),
        });
        recordSuccess();
        const staticFacts = profileRes.profile?.static ?? [];
        const searchResults = (profileRes.searchResults as { results?: Array<{ memory?: string; chunk?: string; content?: string }> } | undefined)
          ?.results ?? [];
        const memories = searchResults.map((r) => extractMemoryText(r)).filter(Boolean);
        log("memory", "projectProfile: static=%d memories=%d", staticFacts.length, memories.length);
        return { static: staticFacts, memories };
      } catch (err) {
        recordFailure();
        logError("memory", "projectProfile failed", err);
        return { static: [], memories: [] };
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
        await client.settings.update({
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
        log("boot", "Supermemory filter prompt configured");
      } catch (err) {
        logWarn("boot", `Supermemory filter setup skipped: ${(err as Error).message}`);
      }
    },
  };
}

// ============================================================
// Factory — Supermemory or disabled
// ============================================================

export function createMemoryProvider(config: Config): MemoryProvider {
  if (!config.supermemory?.apiKey) {
    logError("memory", "no Supermemory API key — memory disabled");
    return {
      get isDegraded() { return true; },
      async store() { return { id: "unavailable" }; },
      async recall() { return []; },
      async getProfile() { return { static: [], dynamic: [], memories: [] }; },
      async ingestConversation() {},
      async setupEntityContext() {},
      async healthCheck() { return false; },
      async storeProject() { return { id: "unavailable" }; },
      async recallProject() { return []; },
      async getProjectMemories() { return { static: [], memories: [] }; },
    };
  }
  log("memory", "using Supermemory cloud provider");
  return createSupermemoryProvider(config.supermemory.apiKey, config);
}

// ============================================================
// Tools
// ============================================================

export function registerMemoryTools(deps: { memory: MemoryProvider; getUserId: () => string; getChatId: () => string }): ToolSet {
  const { memory, getUserId, getChatId } = deps;

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

  const tools: ToolSet = { remember, recall, deleteMemory };

  // Project memory tools (only available when provider supports it)
  if (memory.storeProject) {
    tools.rememberProject = tool({
      description: "Save shared project knowledge — decisions, goals, action items, milestones. Accessible to all group members.",
      inputSchema: z.object({
        content: z.string().describe("The project fact, decision, or action item to remember"),
      }),
      execute: async ({ content }) => {
        const result = await memory.storeProject!(getChatId(), content);
        return { success: result.id !== "unavailable", id: result.id };
      },
    });
  }

  if (memory.recallProject) {
    tools.recallProject = tool({
      description: "Search shared project memory for decisions, goals, action items, and context.",
      inputSchema: z.object({
        query: z.string().describe("What to search for in project memory"),
        limit: z.number().min(1).max(50).optional().default(5),
      }),
      execute: async ({ query, limit }) => {
        const results = await memory.recallProject!(getChatId(), query, limit);
        return { success: true, memories: results, count: results.length };
      },
    });
  }

  return tools;
}
