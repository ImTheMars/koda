/**
 * LocalMemoryProvider — LanceDB vectors + SQLite graph/metadata.
 *
 * Implements the MemoryProvider interface (drop-in replacement for Supermemory).
 * Stores embeddings in LanceDB for semantic recall, metadata + graph in SQLite.
 * Falls back to SQLite full-text search when LanceDB is unavailable.
 */

import { connect, type Table, type Connection } from "@lancedb/lancedb";
import { memories as dbMemories, entities as dbEntities, state as dbState, messages as dbMessages } from "../db.js";
import type { MemorySector, MemoryRow } from "../db.js";
import { EmbeddingService, cosineSimilarity } from "./embedding.js";
import { extractEntities, linkEntitiesToMemory, graphEnrichRecall, recordContradiction } from "./graph.js";
import { runDecay, runReflection, reinforceMemory, shouldRunDecay, shouldRunReflection } from "./decay.js";
import { log } from "../log.js";
import type { Config } from "../config.js";

export interface UserProfile {
  static: string[];
  dynamic: string[];
  memories: string[];
}

export interface MemoryStats {
  total: number;
  bySector: Record<string, number>;
  avgStrength: number;
  archived: number;
  entityCount: number;
  lastDecay: string | null;
  lastReflection: string | null;
}

export interface MemoryProvider {
  store(userId: string, content: string, tags?: string[]): Promise<{ id: string }>;
  storeRich(userId: string, content: string, opts: {
    sector?: MemorySector;
    tags?: string[];
    sessionKey?: string;
    eventAt?: string;
    validUntil?: string;
  }): Promise<{ id: string }>;
  recall(userId: string, query: string, limit?: number, sessionKey?: string): Promise<string[]>;
  recallRich(userId: string, query: string, opts?: {
    limit?: number;
    sectors?: MemorySector[];
    minStrength?: number;
    graphDepth?: number;
  }): Promise<MemoryRow[]>;
  getProfile(userId: string, query?: string, sessionKey?: string): Promise<UserProfile>;
  ingestConversation(sessionKey: string, userId: string, messages: Array<{ role: string; content: string }>): Promise<void>;
  setupEntityContext(userId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  decay(userId: string): Promise<{ archived: number; reinforced: number }>;
  reflect(userId: string): Promise<{ reflected: number; compressed: number }>;
  exportMemories(userId: string): Promise<object[]>;
  getStats(userId: string): Promise<MemoryStats>;
  archiveMemory(memoryId: string): void;
  readonly isDegraded: boolean;
}

interface LanceRow {
  id: string;
  vector: number[];
}

export function createLocalMemoryProvider(config: Config, workspaceDir: string): MemoryProvider {
  const embedder = new EmbeddingService(config.openrouter.apiKey, config.memory.embeddingModel);
  const lancePath = `${workspaceDir}/memory.lance`;

  let lanceConn: Connection | null = null;
  let lanceTable: Table | null = null;
  let lanceReady = false;
  let degraded = false;

  async function getLanceTable(): Promise<Table | null> {
    if (lanceReady && lanceTable) return lanceTable;
    try {
      if (!lanceConn) lanceConn = await connect(lancePath);
      try {
        lanceTable = await lanceConn.openTable("memories");
      } catch {
        // Table doesn't exist yet — will be created on first store
        lanceTable = null;
      }
      lanceReady = true;
      return lanceTable;
    } catch (err) {
      log("memory", "LanceDB unavailable: %s", (err as Error).message);
      degraded = true;
      return null;
    }
  }

  async function ensureLanceTable(vectorDim: number): Promise<Table> {
    if (lanceTable) return lanceTable;
    if (!lanceConn) lanceConn = await connect(lancePath);
    const seed: LanceRow[] = [{ id: "__seed__", vector: new Array(vectorDim).fill(0) }];
    lanceTable = await lanceConn.createTable("memories", seed, { existOk: true });
    // Remove seed row
    try { await lanceTable.delete('id = "__seed__"'); } catch {}
    log("memory", "LanceDB table created (dim=%d)", vectorDim);
    return lanceTable;
  }

  async function storeVector(id: string, vector: Float32Array): Promise<void> {
    try {
      const table = await ensureLanceTable(vector.length);
      await table.add([{ id, vector: Array.from(vector) }]);
    } catch (err) {
      log("memory", "LanceDB store failed: %s", (err as Error).message);
      degraded = true;
    }
  }

  async function searchVectors(queryVec: Float32Array, limit: number): Promise<string[]> {
    const table = await getLanceTable();
    if (!table) return [];
    try {
      const results = await table
        .vectorSearch(Array.from(queryVec))
        .limit(limit * 2)
        .toArray();
      return (results as LanceRow[]).map((r) => r.id).filter((id) => id !== "__seed__");
    } catch (err) {
      log("memory", "LanceDB search failed: %s", (err as Error).message);
      degraded = true;
      return [];
    }
  }

  async function insertMemory(
    userId: string,
    content: string,
    opts: {
      sector?: MemorySector;
      tags?: string[];
      sessionKey?: string;
      eventAt?: string;
      validUntil?: string;
    } = {},
  ): Promise<string> {
    const id = `mem_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const sector: MemorySector = opts.sector ?? "semantic";

    dbMemories.insert({
      id,
      userId,
      sector,
      content,
      summary: null,
      tags: opts.tags?.length ? JSON.stringify(opts.tags) : null,
      sessionKey: opts.sessionKey ?? null,
      eventAt: opts.eventAt ?? new Date().toISOString(),
      validUntil: opts.validUntil ?? null,
      strength: 1.0,
    });

    // Embed in background (non-blocking for caller)
    embedder.embedOne(content).then((vec) => storeVector(id, vec)).catch(() => {});

    // Extract entities in background
    if (sector !== "episodic") {
      extractEntities(content, config.openrouter.apiKey, config.openrouter.fastModel)
        .then((ents) => linkEntitiesToMemory(userId, id, ents))
        .catch(() => {});
    }

    return id;
  }

  async function semanticSearch(
    userId: string,
    query: string,
    limit: number,
    sectors?: MemorySector[],
    minStrength?: number,
  ): Promise<MemoryRow[]> {
    let candidateIds: string[] = [];

    try {
      const queryVec = await embedder.embedOne(query);
      candidateIds = await searchVectors(queryVec, limit * 3);
    } catch {}

    if (!candidateIds.length) {
      // Fallback: SQLite keyword search
      const rows = dbMemories.search(userId, query, limit);
      return sectors ? rows.filter((r) => sectors.includes(r.sector)) : rows;
    }

    // Fetch SQLite rows for the candidate IDs and filter
    const rows: MemoryRow[] = [];
    for (const id of candidateIds) {
      const row = dbMemories.getById(id);
      if (!row || row.userId !== userId || row.archived) continue;
      if (sectors && !sectors.includes(row.sector)) continue;
      if (minStrength !== undefined && row.strength < minStrength) continue;
      rows.push(row);
    }

    // Re-rank by combined vector similarity + strength
    try {
      const queryVec = await embedder.embedOne(query);
      const contentVecs = await embedder.embed(rows.map((r) => r.content));
      const scored = rows.map((r, i) => ({
        row: r,
        score: cosineSimilarity(queryVec, contentVecs[i]!) * 0.7 + r.strength * 0.3,
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => s.row);
    } catch {
      return rows.slice(0, limit);
    }
  }

  return {
    get isDegraded() { return degraded; },

    async store(userId, content, tags) {
      try {
        const id = await insertMemory(userId, content, { tags, sector: "semantic" });
        return { id };
      } catch (err) {
        log("memory", "store error: %s", (err as Error).message);
        return { id: "unavailable" };
      }
    },

    async storeRich(userId, content, opts) {
      try {
        const id = await insertMemory(userId, content, opts);
        return { id };
      } catch (err) {
        log("memory", "storeRich error: %s", (err as Error).message);
        return { id: "unavailable" };
      }
    },

    async recall(userId, query, limit = 5, sessionKey) {
      try {
        const rows = await semanticSearch(userId, query, limit);
        // Reinforce recalled memories
        for (const r of rows) reinforceMemory(r.id, r.strength);
        return rows.map((r) => r.summary ?? r.content);
      } catch (err) {
        log("memory", "recall error: %s", (err as Error).message);
        // Final fallback to message history
        if (sessionKey) {
          const history = dbMessages.getHistory(sessionKey, 50);
          const lower = query.toLowerCase();
          return history.filter((m) => m.content.toLowerCase().includes(lower)).slice(0, limit).map((m) => m.content);
        }
        return [];
      }
    },

    async recallRich(userId, query, opts = {}) {
      const rows = await semanticSearch(userId, query, opts.limit ?? 10, opts.sectors, opts.minStrength);
      const enriched = graphEnrichRecall(userId, rows, opts.graphDepth ?? config.memory.graphDepth);
      for (const r of enriched) reinforceMemory(r.id, r.strength);
      return enriched;
    },

    async getProfile(userId, query, sessionKey) {
      try {
        const [staticRows, queryRows] = await Promise.all([
          semanticSearch(userId, "who is the user, background, preferences, goals", 8),
          query ? semanticSearch(userId, query, 5) : Promise.resolve([]),
        ]);
        const staticFacts = staticRows.map((r) => r.summary ?? r.content);
        const queryMemories = queryRows.map((r) => r.summary ?? r.content);
        log("memory", "profile: static=%d memories=%d", staticFacts.length, queryMemories.length);
        return { static: staticFacts, dynamic: [], memories: queryMemories };
      } catch (err) {
        log("memory", "profile error: %s", (err as Error).message);
        if (sessionKey) {
          const history = dbMessages.getHistory(sessionKey, 30);
          const lower = query?.toLowerCase() ?? "";
          const fallback = lower
            ? history.filter((m) => m.content.toLowerCase().includes(lower)).slice(0, 5).map((m) => m.content)
            : [];
          return { static: [], dynamic: [], memories: fallback };
        }
        return { static: [], dynamic: [], memories: [] };
      }
    },

    async ingestConversation(sessionKey, userId, msgs) {
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const lastAssist = [...msgs].reverse().find((m) => m.role === "assistant");
      if (!lastUser || !lastAssist) return;

      const summary = `User: ${lastUser.content.slice(0, 300)}\nKoda: ${lastAssist.content.slice(0, 300)}`;
      await insertMemory(userId, summary, { sector: "episodic", sessionKey });
      log("memory", "ingest: episodic memory for session %s", sessionKey);
    },

    async setupEntityContext(_userId) {
      // No-op for local provider; entity context is applied per-recall via graph enrichment
    },

    async healthCheck() {
      try {
        await getLanceTable();
        dbMemories.count("health_check_probe");
        return true;
      } catch {
        return false;
      }
    },

    async decay(userId) {
      const result = await runDecay(userId, config.memory.archiveThreshold, config.memory.decayAggressiveness);
      return { archived: result.archived, reinforced: result.decayed };
    },

    async reflect(userId) {
      return runReflection(userId, config.openrouter.apiKey, config.openrouter.deepModel, async (content, sector, tags) => {
        const id = await insertMemory(userId, content, { sector, tags });
        return id;
      });
    },

    exportMemories(userId) {
      const rows = dbMemories.listByUser(userId, { includeArchived: true, limit: 100_000 });
      return Promise.resolve(rows.map((r) => ({
        id: r.id,
        sector: r.sector,
        content: r.content,
        summary: r.summary,
        tags: r.tags ? JSON.parse(r.tags) : [],
        eventAt: r.eventAt,
        rememberedAt: r.rememberedAt,
        strength: r.strength,
        recallCount: r.recallCount,
        archived: r.archived === 1,
      })));
    },

    async getStats(userId) {
      const stats = dbMemories.getStats(userId);
      const entityCount = dbEntities.count(userId);
      const lastDecay = dbState.get<string>(`last_decay_${userId}`);
      const lastReflection = dbState.get<string>(`last_reflect_${userId}`);
      return { ...stats, entityCount, lastDecay, lastReflection };
    },

    archiveMemory(memoryId) {
      dbMemories.archive(memoryId);
    },
  };
}
