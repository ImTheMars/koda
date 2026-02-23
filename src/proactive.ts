/**
 * Proactive system — 30s tick loop for scheduled tasks + heartbeat.
 *
 * One-shot reminders: send directly. Recurring tasks: run through agent.
 */

import type { Config } from "./config.js";
import { tasks as dbTasks, messages as dbMessages } from "./db.js";
import { parseCronNext } from "./time.js";
import { log } from "./log.js";

const NEAR_TERM_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Module-level nudge — allows schedule tools to trigger a precise check for near-term reminders
let _checkTasksFn: (() => Promise<void>) | null = null;
const _pendingTimers = new Set<ReturnType<typeof setTimeout>>();

/**
 * Schedule a precise check at the given time (for near-term reminders).
 * Falls back gracefully to the regular tick if proactive hasn't started yet.
 */
export function scheduleNudge(at: Date): void {
  if (!_checkTasksFn) return;
  const delayMs = Math.max(0, at.getTime() - Date.now());
  if (delayMs > NEAR_TERM_THRESHOLD_MS) return; // only for near-term; regular tick handles the rest
  const fn = _checkTasksFn;
  const timer = setTimeout(() => {
    _pendingTimers.delete(timer);
    fn().catch(console.error);
  }, delayMs);
  _pendingTimers.add(timer);
}

export interface ProactiveDeps {
  runAgent: (input: { content: string; senderId: string; chatId: string; channel: string; sessionKey: string; source?: string }) => Promise<{ text: string }>;
  sendDirect: (channel: string, chatId: string, text: string) => Promise<void>;
  config: Config;
  defaultUserId: string;
  defaultChatId: string;
  defaultChannel: string;
}

export function startProactive(deps: ProactiveDeps): { stop: () => void } {
  const { config } = deps;

  // Catch-up: fire missed one-shot reminders on startup
  const catchUp = async () => {
    const now = new Date();
    const ready = dbTasks.getReady(now.toISOString());
    for (const task of ready) {
      if (task.oneShot) {
        const text = `${task.prompt ?? task.description} (delayed)`;
        await deps.sendDirect(task.channel, task.chatId, text);
        dbMessages.append(`${task.channel}_${task.chatId}`, "assistant", text);
        dbTasks.delete(task.id);
      } else if (task.cron) {
        let nextRun = parseCronNext(task.cron, now, config.scheduler.timezone);
        while (nextRun.getTime() <= now.getTime()) {
          nextRun = parseCronNext(task.cron, new Date(nextRun.getTime() + 60_000), config.scheduler.timezone);
        }
        dbTasks.advance(task.id, nextRun.toISOString());
      }
    }
  };

  const checkTasks = async () => {
    const now = new Date();
    const ready = dbTasks.getReady(now.toISOString());

    for (const task of ready) {
      log("proactive", "task: %s", task.description);
      if (task.type === "reminder") {
        const text = task.prompt ?? task.description;
        await deps.sendDirect(task.channel, task.chatId, text);
        dbMessages.append(`${task.channel}_${task.chatId}`, "assistant", text);
        dbTasks.delete(task.id);
      } else {
        // Recurring: run through agent
        await deps.runAgent({
          content: `[scheduled task] ${task.prompt}`,
          senderId: task.userId,
          chatId: task.chatId,
          channel: task.channel,
          sessionKey: `${task.channel}_${task.chatId}`,
          source: "scheduler",
        });

        if (task.cron) {
          const nextRun = parseCronNext(task.cron, now, config.scheduler.timezone);
          dbTasks.advance(task.id, nextRun.toISOString());
        }
      }
    }
    log("proactive", "tick");

  };

  const tick = async () => {
    // Reminders ALWAYS fire — user explicitly scheduled them.
    if (config.features.scheduler) await checkTasks();
  };

  // Register module-level nudge so schedule tools can trigger precise checks
  _checkTasksFn = checkTasks;

  // Init
  (async () => {
    if (config.features.scheduler) await catchUp();
  })();

  tick().catch(console.error);
  const timer = setInterval(() => tick().catch(console.error), config.proactive.tickIntervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      _checkTasksFn = null;
      for (const t of _pendingTimers) clearTimeout(t);
      _pendingTimers.clear();
    },
  };
}
