/**
 * Schedule tools — reminders and recurring tasks backed by SQLite.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { tasks as dbTasks } from "../db.js";
import { parseCronNext, parseNaturalSchedule } from "../time.js";
import { scheduleNudge } from "../proactive.js";

function parseOneShotReminderTime(input: {
  datetime?: string;
  when?: string;
  minutesFromNow?: number;
}): Date | null {
  if (typeof input.minutesFromNow === "number" && Number.isFinite(input.minutesFromNow)) {
    return new Date(Date.now() + input.minutesFromNow * 60_000);
  }

  const raw = input.datetime ?? input.when;
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  const rel = text.match(/^in\s+(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/i);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = (rel[2] ?? "minutes").toLowerCase();
    const ms =
      unit.startsWith("min") ? amount * 60_000 :
      unit.startsWith("h") ? amount * 3_600_000 :
      amount * 86_400_000;
    return new Date(Date.now() + ms);
  }

  // Month/day with optional time, no year (e.g. "March 14th", "Mar 14 9am")
  const md = text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (md) {
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monthIdx = monthNames.findIndex((m) => md[1]!.toLowerCase().startsWith(m));
    if (monthIdx >= 0) {
      const now = new Date();
      let year = now.getFullYear();
      let hour = md[3] ? Number(md[3]) : 9;
      const minute = md[4] ? Number(md[4]) : 0;
      const mer = md[5]?.toLowerCase();
      if (mer === "pm" && hour < 12) hour += 12;
      if (mer === "am" && hour === 12) hour = 0;
      let d = new Date(year, monthIdx, Number(md[2]), hour, minute, 0, 0);
      if (d.getTime() <= Date.now()) {
        year += 1;
        d = new Date(year, monthIdx, Number(md[2]), hour, minute, 0, 0);
      }
      return d;
    }
  }

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}

export function registerScheduleTools(deps: {
  timezone: string;
  getUserId: () => string;
  getChatId: () => string;
  getChannel: () => string;
}): ToolSet {
  const { timezone, getUserId, getChatId, getChannel } = deps;

  const createReminder = tool({
    description: "Set a one-time reminder. Accepts an ISO datetime or a natural-language time like 'in 30 minutes' or 'March 14th'. The description text is sent directly to the user at the specified time.",
    inputSchema: z.object({
      description: z.string().describe("The message to send (sent verbatim)"),
      datetime: z.string().optional().describe("ISO 8601 datetime for when to fire"),
      when: z.string().optional().describe("Natural-language time expression, e.g. 'in 30 minutes' or 'tomorrow 9am'"),
      minutesFromNow: z.number().int().min(1).max(60 * 24 * 30).optional().describe("Convenience relative offset in minutes"),
    }),
    execute: async ({ description, datetime, when, minutesFromNow }) => {
      const nextRunAt = parseOneShotReminderTime({ datetime, when, minutesFromNow });
      if (!nextRunAt || isNaN(nextRunAt.getTime())) {
        return { success: false, error: "Invalid reminder time. Provide datetime (ISO) or when (natural language)." };
      }

      const id = crypto.randomUUID();
      dbTasks.create({
        id, type: "reminder", channel: getChannel(), chatId: getChatId(),
        userId: getUserId(), nextRunAt: nextRunAt.toISOString(), prompt: description,
        description, enabled: true, oneShot: true,
      });

      // Near-term reminders get a precise setTimeout so they fire on time, not up to 30s late
      scheduleNudge(nextRunAt);

      return { success: true, id, firesAt: nextRunAt.toISOString(), description };
    },
  });

  const createRecurringTask = tool({
    description: "Create a recurring task that triggers the agent at a schedule. Accepts natural language like 'every day at 8 AM', 'every Monday at 9', 'every weekday at 6 PM', or cron format '08:00' / 'mon,wed,fri 09:00'.",
    inputSchema: z.object({
      description: z.string().describe("Human-readable label"),
      prompt: z.string().optional().describe("What the agent should do when this fires (defaults to description)"),
      schedule: z.string().describe('Schedule: natural language ("every day at 8 AM") or cron format ("mon,wed,fri 09:00")'),
    }),
    execute: async ({ description, prompt, schedule }) => {
      // Try natural language parsing first, fall back to raw cron string
      const normalizedSchedule = parseNaturalSchedule(schedule) ?? schedule;
      let nextRunAt: Date;
      try { nextRunAt = parseCronNext(normalizedSchedule, new Date(), timezone); }
      catch { return { success: false, error: `Invalid schedule format: "${schedule}"` }; }

      const id = crypto.randomUUID();
      dbTasks.create({
        id, type: "recurring", channel: getChannel(), chatId: getChatId(),
        userId: getUserId(), cron: normalizedSchedule, nextRunAt: nextRunAt.toISOString(),
        prompt: prompt?.trim() || description, description, enabled: true, oneShot: false,
      });

      return { success: true, id, schedule: normalizedSchedule, parsedFrom: schedule !== normalizedSchedule ? schedule : undefined, nextRunAt: nextRunAt.toISOString() };
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
