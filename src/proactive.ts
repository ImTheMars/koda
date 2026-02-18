/**
 * Proactive system — 30s tick loop for scheduled tasks + memory maintenance.
 *
 * One-shot reminders: send directly. Recurring tasks: run through agent.
 * Memory decay: daily sweep (Ebbinghaus). Reflection: weekly compression.
 */

import type { Config } from "./config.js";
import { tasks as dbTasks, messages as dbMessages } from "./db.js";
import { parseCronNext } from "./time.js";
import { log } from "./log.js";
import type { MemoryProvider } from "./memory/index.js";
import { shouldRunDecay, shouldRunReflection } from "./memory/decay.js";

const NEAR_TERM_THRESHOLD_MS = 5 * 60 * 1000;

let _checkTasksFn: (() => Promise<void>) | null = null;
const _pendingTimers = new Set<ReturnType<typeof setTimeout>>();

export function scheduleNudge(at: Date): void {
  if (!_checkTasksFn) return;
  const delayMs = Math.max(0, at.getTime() - Date.now());
  if (delayMs > NEAR_TERM_THRESHOLD_MS) return;
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
  memoryProvider: MemoryProvider;
}

export function startProactive(deps: ProactiveDeps): { stop: () => void } {
  const { config, memoryProvider } = deps;

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
  };

  const checkMemoryMaintenance = async () => {
    const userId = deps.defaultUserId;

    // Daily decay sweep
    if (shouldRunDecay(userId)) {
      try {
        const result = await memoryProvider.decay(userId);
        if (result.archived > 0 || result.reinforced > 0) {
          log("proactive", "decay: archived=%d reinforced=%d", result.archived, result.reinforced);
        }
      } catch (err) {
        log("proactive", "decay error: %s", (err as Error).message);
      }
    }

    // Weekly/daily reflection
    if (shouldRunReflection(userId, config.memory.reflectionSchedule)) {
      try {
        const result = await memoryProvider.reflect(userId);
        if (result.reflected > 0) {
          log("proactive", "reflection: %d insights from %d episodics", result.reflected, result.compressed);
        }
      } catch (err) {
        log("proactive", "reflection error: %s", (err as Error).message);
      }
    }
  };

  const tick = async () => {
    log("proactive", "tick");
    if (config.features.scheduler) await checkTasks();
    // Memory maintenance runs on every tick but self-gates via shouldRunDecay/shouldRunReflection
    await checkMemoryMaintenance();
  };

  _checkTasksFn = checkTasks;

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
