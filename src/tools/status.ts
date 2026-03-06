/**
 * Status tool — system health and stats for self-reporting.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { tasks as dbTasks, usage as dbUsage, assessment as dbAssessment, plans as dbPlans } from "../db.js";
import type { MemoryProvider } from "./memory.js";
import { isLlmCircuitOpen } from "../agent.js";
import { VERSION } from "../version.js";
import { getToolContext } from "./index.js";

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
      const ctx = getToolContext();
      const todayUsage = dbUsage.getSummary(ctx.userId, todayStart);

      // Get all enabled tasks (use far-future date to get everything)
      const allReady = dbTasks.getReady(new Date(Date.now() + 365 * 24 * 3_600_000).toISOString());
      const nextTask = allReady.length > 0 ? allReady[0] : null;
      const goals = dbAssessment.listGoals(ctx.userId, "active");
      const activePlans = dbPlans.listByUser(ctx.userId).filter((plan) => plan.status === "active" || plan.status === "blocked");

      return {
        version: VERSION,
        uptime: uptimeStr,
        memory: { heapMb: `${heapMb}MB`, rssMb: `${rssMb}MB` },
        supermemory: {
          status: memory.isDegraded ? "degraded" : "healthy",
        },
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
        autonomy: {
          activeGoalCount: goals.length,
          activePlanCount: activePlans.length,
          blockedPlanCount: activePlans.filter((plan) => plan.status === "blocked").length,
        },
      };
    },
  });

  return { systemStatus };
}
