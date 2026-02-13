/**
 * Schedule tools — reminders and recurring tasks backed by SQLite.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { tasks as dbTasks } from "../db.js";
import { parseCronNext } from "../time.js";

export function registerScheduleTools(deps: {
  timezone: string;
  getUserId: () => string;
  getChatId: () => string;
  getChannel: () => string;
}): ToolSet {
  const { timezone, getUserId, getChatId, getChannel } = deps;

  const createReminder = tool({
    description: "Set a one-time reminder. The description text is sent directly to the user at the specified time.",
    inputSchema: z.object({
      description: z.string().describe("The message to send (sent verbatim)"),
      datetime: z.string().describe("ISO 8601 datetime for when to fire"),
    }),
    execute: async ({ description, datetime }) => {
      const nextRunAt = new Date(datetime);
      if (isNaN(nextRunAt.getTime())) return { success: false, error: "Invalid datetime format" };

      const id = crypto.randomUUID();
      dbTasks.create({
        id, type: "reminder", channel: getChannel(), chatId: getChatId(),
        userId: getUserId(), nextRunAt: nextRunAt.toISOString(), prompt: description,
        description, enabled: true, oneShot: true,
      });

      return { success: true, id, firesAt: nextRunAt.toISOString(), description };
    },
  });

  const createRecurringTask = tool({
    description: "Create a recurring task that triggers the agent at a schedule.",
    inputSchema: z.object({
      description: z.string().describe("Human-readable label"),
      prompt: z.string().describe("What the agent should do when this fires"),
      schedule: z.string().describe('Cron schedule: "08:00" for daily, "mon,wed,fri 09:00" for specific days'),
    }),
    execute: async ({ description, prompt, schedule }) => {
      let nextRunAt: Date;
      try { nextRunAt = parseCronNext(schedule, new Date(), timezone); }
      catch { return { success: false, error: "Invalid schedule format" }; }

      const id = crypto.randomUUID();
      dbTasks.create({
        id, type: "recurring", channel: getChannel(), chatId: getChatId(),
        userId: getUserId(), cron: schedule, nextRunAt: nextRunAt.toISOString(),
        prompt, description, enabled: true, oneShot: false,
      });

      return { success: true, id, schedule, nextRunAt: nextRunAt.toISOString() };
    },
  });

  const listTasks = tool({
    description: "List all scheduled tasks and reminders.",
    inputSchema: z.object({}),
    execute: async () => {
      const userTasks = dbTasks.listByUser(getUserId());
      return {
        success: true,
        tasks: userTasks.map((t: { id: string; type: string; description: string; cron: string | null; nextRunAt: string }) => ({
          id: t.id, type: t.type, description: t.description,
          schedule: t.cron ?? null, nextRunAt: t.nextRunAt,
        })),
        count: userTasks.length,
      };
    },
  });

  const deleteTask = tool({
    description: "Delete a scheduled task or reminder by ID.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const removed = dbTasks.deleteForUser(id, getUserId());
      return { success: removed, error: removed ? undefined : "Task not found" };
    },
  });

  return { createReminder, createRecurringTask, listTasks, deleteTask };
}
