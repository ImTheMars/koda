/**
 * Memory tools — wraps LocalMemoryProvider with AI SDK tool definitions.
 *
 * Tools: remember, recall, forgetMemory, memoryGraph, memoryTimeline
 * Provider: src/memory/index.ts (LanceDB + SQLite, fully local)
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { MemoryProvider, UserProfile, MemoryStats } from "../memory/index.js";
import { formatEntityGraph } from "../memory/graph.js";

// Re-export types for agent.ts and status.ts compatibility
export type { UserProfile, MemoryProvider, MemoryStats };
export { createLocalMemoryProvider } from "../memory/index.js";

const SECTOR_ENUM = z.enum(["episodic", "semantic", "factual", "procedural", "reflective"]).optional();
const SECTOR_DESCRIPTIONS = `episodic=events/sessions, semantic=facts/preferences, factual=permanent facts, procedural=skills/routines, reflective=insights`;

export function registerMemoryTools(deps: { memory: MemoryProvider; getUserId: () => string }): ToolSet {
  const { memory, getUserId } = deps;

  const remember = tool({
    description: `Save important information to long-term memory. Use for preferences, names, schedules, facts, corrections, and insights. Sectors: ${SECTOR_DESCRIPTIONS}`,
    inputSchema: z.object({
      content: z.string().describe("The fact or information to remember"),
      sector: SECTOR_ENUM.describe("Memory sector (default: semantic)"),
      tags: z.array(z.string()).optional().describe("Optional tags for this memory"),
      eventAt: z.string().optional().describe("ISO timestamp of when this happened (default: now)"),
    }),
    execute: async ({ content, sector, tags, eventAt }) => {
      const result = await memory.storeRich(getUserId(), content, {
        sector: sector ?? "semantic",
        tags: tags ?? [],
        eventAt,
      });
      return { success: result.id !== "unavailable", id: result.id, sector: sector ?? "semantic" };
    },
  });

  const recall = tool({
    description: "Search long-term memory for facts and preferences. Returns the most relevant memories by semantic similarity. Use 'tag' to filter by tag, 'timeframe' for temporal queries.",
    inputSchema: z.object({
      query: z.string().describe("What to search for in memory"),
      limit: z.number().min(1).max(20).optional().default(5),
      sectors: z.array(z.enum(["episodic", "semantic", "factual", "procedural", "reflective"])).optional().describe("Filter by sectors"),
      minStrength: z.number().min(0).max(1).optional().describe("Minimum memory strength (0-1)"),
      tag: z.string().optional().describe("Filter by tag (e.g. 'food', 'work')"),
      timeframe: z.enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month"]).optional()
        .describe("Filter by time period"),
    }),
    execute: async ({ query, limit, sectors, minStrength, tag, timeframe }) => {
      let rows = await memory.recallRich(getUserId(), query, {
        limit: (limit ?? 5) * 2,
        sectors: sectors as any,
        minStrength,
        tag,
        timeframe,
      });
      rows = rows.slice(0, limit ?? 5);
      return {
        success: true,
        memories: rows.map((r) => ({
          id: r.id,
          sector: r.sector,
          content: r.summary ?? r.content,
          strength: Math.round(r.strength * 100) / 100,
          recallCount: r.recallCount,
          eventAt: r.eventAt,
          tags: r.tags ? JSON.parse(r.tags) : [],
        })),
        count: rows.length,
      };
    },
  });

  const forgetMemory = tool({
    description: "Archive (soft-delete) a specific memory by ID. Use when the user wants to forget something specific.",
    inputSchema: z.object({
      memoryId: z.string().describe("The memory ID to archive"),
    }),
    execute: async ({ memoryId }) => {
      memory.archiveMemory(memoryId);
      return { success: true, archived: memoryId };
    },
  });

  const memoryGraph = tool({
    description: "Show the entity graph — people, projects, preferences, and how they relate. Use when asked 'what do you know about X' or 'show my memory graph'.",
    inputSchema: z.object({}),
    execute: async () => {
      const graph = formatEntityGraph(getUserId());
      const stats = await memory.getStats(getUserId());
      return {
        graph,
        stats: {
          totalMemories: stats.total,
          entities: stats.entityCount,
          avgStrength: Math.round(stats.avgStrength * 100) / 100,
          bySector: stats.bySector,
        },
      };
    },
  });

  const memoryTimeline = tool({
    description: "Show episodic memories as a timeline — what happened when. Use when asked 'what did we talk about last week' or 'my history'.",
    inputSchema: z.object({
      query: z.string().optional().describe("Optional filter query"),
      limit: z.number().min(1).max(30).optional().default(15),
    }),
    execute: async ({ query, limit }) => {
      const rows = await memory.recallRich(getUserId(), query ?? "events sessions conversations", {
        limit: limit ?? 15,
        sectors: ["episodic"],
      });
      const sorted = [...rows].sort((a, b) => new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime());
      return {
        timeline: sorted.map((r) => ({
          date: r.eventAt.slice(0, 10),
          content: r.content.slice(0, 200),
          strength: Math.round(r.strength * 100) / 100,
        })),
        count: sorted.length,
      };
    },
  });

  return { remember, recall, forgetMemory, memoryGraph, memoryTimeline };
}
