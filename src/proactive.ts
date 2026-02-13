/**
 * Proactive system — 30s tick loop for scheduled tasks + heartbeat.
 *
 * One-shot reminders: send directly. Recurring tasks: run through agent.
 */

import { join } from "path";
import type { Config } from "./config.js";
import { tasks as dbTasks, messages as dbMessages } from "./db.js";
import { parseCronNext, isActiveHours } from "./time.js";

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

const INITIAL_HEARTBEAT = `# tasks\n\nadd tasks below. koda checks this every 30 minutes.\n\n- [ ] example: research flights to tokyo\n`;

export interface ProactiveDeps {
  runAgent: (input: { content: string; senderId: string; chatId: string; channel: string; sessionKey: string; source?: string }) => Promise<{ text: string }>;
  sendDirect: (channel: string, chatId: string, text: string) => Promise<void>;
  config: Config;
  defaultUserId: string;
  defaultChatId: string;
  defaultChannel: string;
}

export function startProactive(deps: ProactiveDeps): { stop: () => void } {
  const { config, defaultUserId, defaultChatId, defaultChannel } = deps;
  const heartbeatPath = join(config.workspace, "HEARTBEAT.md");
  let lastHeartbeatHash: number | null = null;
  let lastHeartbeatCheck = 0;

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
  };

  const checkHeartbeat = async () => {
    const file = Bun.file(heartbeatPath);
    if (!(await file.exists())) return;

    try {
      const content = await file.text();
      if (isEffectivelyEmpty(content)) return;

      const hash = Number(Bun.hash(content));
      if (hash === lastHeartbeatHash) return;
      lastHeartbeatHash = hash;

      await deps.runAgent({
        content: `[heartbeat] check your task list and act on any pending items:\n\n${content}`,
        senderId: defaultUserId,
        chatId: defaultChatId,
        channel: defaultChannel,
        sessionKey: `${defaultChannel}_${defaultChatId}`,
        source: "heartbeat",
      });
    } catch (err) {
      console.error("[proactive] Heartbeat error:", err);
    }
  };

  const tick = async () => {
    if (!isActiveHours(config.scheduler.timezone, config.proactive.activeHoursStart, config.proactive.activeHoursEnd)) return;

    if (config.features.scheduler) await checkTasks();

    const now = Date.now();
    if (config.features.heartbeat && now - lastHeartbeatCheck >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatCheck = now;
      await checkHeartbeat();
    }
  };

  // Init
  (async () => {
    // Create HEARTBEAT.md if it doesn't exist
    if (config.features.heartbeat && !(await Bun.file(heartbeatPath).exists())) {
      await Bun.write(heartbeatPath, INITIAL_HEARTBEAT);
    }
    if (config.features.scheduler) await catchUp();
  })();

  tick().catch(console.error);
  const timer = setInterval(() => tick().catch(console.error), config.proactive.tickIntervalMs);

  return { stop: () => clearInterval(timer) };
}

function isEffectivelyEmpty(content: string): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /example:/i.test(trimmed) || /^add tasks|^koda checks/i.test(trimmed)) continue;
    if (/^[-*]\s*\[x\]/i.test(trimmed) || /^[-*]\s*$/.test(trimmed) || /^<!--.*-->$/.test(trimmed)) continue;
    if (/^[-*]\s*\[\s\]/.test(trimmed) || /^[-*]\s+\S/.test(trimmed)) return false;
    if (trimmed.length > 0) return false;
  }
  return true;
}
