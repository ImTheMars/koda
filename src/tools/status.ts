/**
 * Status tool — system health and stats for self-reporting.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { tasks as dbTasks, usage as dbUsage } from "../db.js";
import type { MemoryProvider } from "./memory.js";
import { isLlmCircuitOpen } from "../agent.js";

const VERSION = "2.0.0";

export function registerStatusTools(deps: { memory: MemoryProvider }): ToolSet {
  const { memory } = deps;

  const systemStatus = tool({
    description: "Get Koda's current system status — uptime, memory health, usage stats, scheduled tasks. Use when asked how you're doing, system status, or health.",
    inputSchema: z.object({}),
    execute: async () => {
      const uptimeSecs = Math.floor(process.uptime());
      const uptimeStr = uptimeSecs < 60
        ? `${uptimeSecs}s`
        : uptimeSecs < 3600
        ? `${Math.floor(uptimeSecs / 60)}m ${uptimeSecs % 60}s`
        : `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`;

      const memUsage = process.memoryUsage();
      const heapMb = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
      const rssMb = (memUsage.rss / 1024 / 1024).toFixed(1);

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayUsage = dbUsage.getSummary("owner", todayStart);

      const allReady = dbTasks.getReady(new Date("2099-01-01").toISOString());
      const nextTask = allReady.length > 0 ? allReady[0] : null;

      // Memory stats
      let memStats = null;
      try {
        memStats = await memory.getStats("owner");
      } catch {}

      return {
        version: VERSION,
        uptime: uptimeStr,
        process: { heapMb: `${heapMb}MB`, rssMb: `${rssMb}MB` },
        memory: memStats ? {
          status: memory.isDegraded ? "degraded (sqlite fallback)" : "healthy",
          provider: "local (LanceDB + SQLite)",
          total: memStats.total,
          archived: memStats.archived,
          entityCount: memStats.entityCount,
          avgStrength: Math.round(memStats.avgStrength * 100) / 100,
          bySector: memStats.bySector,
          lastDecay: memStats.lastDecay ?? "never",
          lastReflection: memStats.lastReflection ?? "never",
        } : { status: memory.isDegraded ? "degraded" : "healthy" },
        llmCircuitBreaker: isLlmCircuitOpen() ? "open (degraded)" : "closed (healthy)",
        searchProvider: "exa",
        todayUsage: {
          requests: todayUsage.totalRequests,
          cost: `$${todayUsage.totalCost.toFixed(4)}`,
        },
        scheduler: {
          activeTaskCount: allReady.length,
          nextTask: nextTask ? { description: nextTask.description, at: nextTask.nextRunAt } : null,
        },
      };
    },
  });

  return { systemStatus };
}
