/**
 * Proactive system — 30s tick loop for scheduled tasks + heartbeat.
 *
 * One-shot reminders: send directly. Recurring tasks: run through agent.
 */

import type { Config } from "./config.js";
import { tasks as dbTasks, messages as dbMessages } from "./db.js";
import { parseCronNext } from "./time.js";
import { log, logError } from "./log.js";

const NEAR_TERM_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const GRACE_WINDOW_MS = 30 * 60 * 1000;  // skip one-shots older than 30 min
const BOOT_DELAY_MS = 5_000;              // wait 5s before first tick

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
    fn().catch((err) => logError("proactive", "nudge check failed", err));
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
  let booted = false;

  // Catch-up: fire missed one-shot reminders on startup (skip stale ones)
  const catchUp = async () => {
    const now = new Date();
    const ready = dbTasks.getReady(now.toISOString());
    for (const task of ready) {
      if (task.oneShot) {
        const ageMs = now.getTime() - new Date(task.nextRunAt).getTime();
        if (ageMs > GRACE_WINDOW_MS) {
          log("proactive", "stale one-shot skipped: %s (age %dmin)", task.description, Math.round(ageMs / 60_000));
          dbTasks.delete(task.id);
          continue;
        }
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
    booted = true;
  };

  const checkTasks = async () => {
    if (!booted) return;
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
        // Recurring: advance next_run_at FIRST to prevent double-fire
        if (task.cron) {
          const nextRun = parseCronNext(task.cron, now, config.scheduler.timezone);
          dbTasks.advance(task.id, nextRun.toISOString());
        }
        // Fire and track — don't block the tick loop
        deps.runAgent({
          content: `[scheduled task] ${task.prompt}`,
          senderId: task.userId,
          chatId: task.chatId,
          channel: task.channel,
          sessionKey: `${task.channel}_${task.chatId}`,
          source: "scheduler",
        })
          .then(() => { dbTasks.markResult(task.id, "ok"); })
          .catch((err) => {
            logError("proactive", "Agent error", err);
            dbTasks.markResult(task.id, "error");
            if ((task.consecutiveFailures ?? 0) + 1 >= 3) {
              dbTasks.disable(task.id);
              deps.sendDirect(task.channel, task.chatId,
                `yo heads up — i auto-disabled the task "${task.description}" after 3 failures in a row. you can re-enable it if you want.`
              ).catch(() => {});
            }
          });
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

  const bootTimer = setTimeout(() => tick().catch((err) => logError("proactive", "tick failed", err)), BOOT_DELAY_MS);
  const timer = setInterval(() => tick().catch((err) => logError("proactive", "tick failed", err)), config.proactive.tickIntervalMs);

  return {
    stop: () => {
      clearTimeout(bootTimer);
      clearInterval(timer);
      _checkTasksFn = null;
      for (const t of _pendingTimers) clearTimeout(t);
      _pendingTimers.clear();
    },
  };
}
