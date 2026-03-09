/**
 * Koda — composition root.
 *
 * bootConfig → initDb → bootProviders → build tools → bootMcp → agent → channels → proactive → bootServer
 */

import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { resolve } from "path";
import { initDb, closeDb, messages as dbMessages, state as dbState, tasks as dbTasks, vacuumDb, backupDatabase, userProfiles, chatMembers, assessment as dbAssessment, plans as dbPlans } from "./db.js";
import { parseCronNext } from "./time.js";
import { createAgent, createStreamAgent, type AgentDeps } from "./agent.js";
import { startRepl } from "./channels/repl.js";
import { startTelegram, type TelegramResult } from "./channels/telegram.js";
import { startSlack, type SlackResult } from "./channels/slack.js";
import { startProactive } from "./proactive.js";
import { buildTools } from "./tools/index.js";
import { registerSubAgentTools, getNamedSession } from "./tools/subagent.js";

import { log, logWarn } from "./log.js";
import { bootConfig } from "./boot/config.js";
import { bootProviders } from "./boot/providers.js";
import { bootMcp, reconnectMcpServer, type McpEntry } from "./boot/mcp.js";
import { bootServer } from "./boot/server.js";
import { startRailwayMonitor } from "./boot/railway-monitor.js";

type DeliveryChannel = "slack" | "telegram" | "cli";

interface ChannelTarget {
  channel: DeliveryChannel;
  userId: string;
  chatId: string;
}

// --- CLI routing ---
const command = process.argv[2];
if (command === "setup" || command === "doctor" || command === "upgrade" || command === "version" || command === "config") {
  const { runCli } = await import("./cli.js");
  await runCli(command, process.argv[3]);
  process.exit(0);
}

// --- Boot phase 1: Config ---
const config = await bootConfig();

// --- Boot phase 2: Database ---
const dbPath = resolve(config.workspace, "koda.db");
initDb(dbPath);
const cleanedMessages = dbMessages.cleanup(config.features.messageRetentionDays);
if (cleanedMessages > 0) {
  log("boot", `Cleaned ${cleanedMessages} messages older than ${config.features.messageRetentionDays} days`);
}
log("boot", "Database initialized");

// --- Boot phase 3: Providers ---
const { memoryProvider, soulLoader, skillLoader, contextWatcher, contextDirWatcher, contextReloadTimeout, getContextContent } = await bootProviders(config);

function getPrimaryTargets(): ChannelTarget[] {
  if (config.slack.adminIds.length > 0) {
    return config.slack.adminIds.map((adminId) => ({
      channel: "slack" as const,
      userId: adminId,
      chatId: adminId,
    }));
  }
  if (config.telegram.adminIds.length > 0) {
    return config.telegram.adminIds.map((adminId) => ({
      channel: "telegram" as const,
      userId: adminId,
      chatId: adminId,
    }));
  }
  return [{ channel: "cli", userId: config.owner.id, chatId: config.owner.id }];
}

const primaryTargets = getPrimaryTargets();
const primaryTarget = primaryTargets[0]!;

// --- Boot phase 4: Tools ---
const tools = await buildTools({ config, memoryProvider, skillLoader, workspace: config.workspace, soulLoader });

// --- Boot phase 5: MCP ---
const mcpClients = await bootMcp(config, tools);

log("boot", `Tools: ${Object.keys(tools).join(", ")}`);

// --- Agent ---
const agentDeps: AgentDeps = {
  config,
  tools,
  getSoulPrompt: () => soulLoader.generatePrompt(),
  getContextPrompt: () => getContextContent(),
  getSkillsSummary: () => skillLoader.buildSkillsSummary(),
  getProfile: (userId, query, sessionKey) => memoryProvider.getProfile(userId, query || undefined, sessionKey),
  ingestConversation: (sessionKey, userId, messages, context) => memoryProvider.ingestConversation(sessionKey, userId, messages, context),
  getSoulAcks: () => soulLoader.getAckTemplates(),
  getAssessmentSummary: async (userId) => {
    const snapshot = dbAssessment.buildSummary(userId);
    const lines: string[] = [];
    if (snapshot.goals.length > 0) {
      lines.push("goals:");
      for (const goal of snapshot.goals) {
        lines.push(`- [${goal.status}] ${goal.title} (${goal.domain})`);
      }
    }
    if (snapshot.observations.length > 0) {
      lines.push("observations:");
      for (const item of snapshot.observations.slice(0, 4)) {
        lines.push(`- ${item.statement} [${item.source}, ${item.confidence.toFixed(2)}]`);
      }
    }
    if (snapshot.interventions.length > 0) {
      lines.push("interventions:");
      for (const intervention of snapshot.interventions.slice(0, 3)) {
        lines.push(`- [${intervention.status}] ${intervention.recommendation}`);
      }
    }
    if (snapshot.reviews.length > 0) {
      lines.push(`latest_review: ${snapshot.reviews[0]!.findings}`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
  },
  getActivePlansSummary: async (userId) => {
    const activePlans = dbPlans.listByUser(userId).filter((plan) => ["active", "blocked", "draft"].includes(plan.status)).slice(0, 5);
    if (activePlans.length === 0) return null;
    const lines: string[] = [];
    for (const plan of activePlans) {
      const detailed = dbPlans.get(plan.id);
      const nextStep = detailed?.steps.find((step) => step.status === "pending" || step.status === "in_progress") ?? null;
      lines.push(`- [${plan.status}] ${plan.title}: ${plan.goal}`);
      if (nextStep) lines.push(`  next_step: ${nextStep.title}`);
      if (plan.successCriteria) lines.push(`  success: ${plan.successCriteria}`);
    }
    return lines.join("\n");
  },
  getWorkspaceMemories: memoryProvider.getWorkspaceMemories
    ? (workspaceId, query) => memoryProvider.getWorkspaceMemories!(workspaceId, query)
    : undefined,
  getProjectMemories: memoryProvider.getProjectMemories
    ? (projectScopeId, query) => memoryProvider.getProjectMemories!(projectScopeId, query)
    : undefined,
  getGroupMembers: (scopeId) => {
    try {
      const members = chatMembers.getByChatId(scopeId);
      return members.map((m) => {
        const profile = userProfiles.get(m.userId);
        return {
          userId: m.userId,
          displayName: profile?.displayName ?? `User ${m.userId}`,
          role: profile?.role ?? "member",
        };
      });
    } catch { return []; }
  },
};

// Setup entity context for primary operators on first boot.
for (const userId of new Set([config.owner.id, ...primaryTargets.map((target) => target.userId)])) {
  memoryProvider.setupEntityContext(userId).catch((err) => {
    logWarn("boot", `Entity context setup failed for ${userId}: ${(err as Error).message}`);
  });
}

// Seed admin profiles from config
try {
  for (const adminId of config.telegram.adminIds) {
    userProfiles.upsert({ userId: adminId, displayName: `Admin ${adminId}`, role: "admin" });
  }
  for (const adminId of config.slack.adminIds) {
    userProfiles.upsert({ userId: adminId, displayName: `Slack Admin ${adminId}`, role: "admin" });
  }
} catch { /* DB not migrated yet — safe to skip */ }

const runAgent = createAgent(agentDeps);
const streamAgentFn = createStreamAgent(agentDeps);

// Register spawnAgent after runAgent exists (post-boot to avoid circular dep).
Object.assign(tools, registerSubAgentTools({
  agentDeps,
  masterTools: tools,
  timeoutMs: config.subagent.timeoutMs,
  maxStepsCap: config.subagent.maxSteps,
}));

function seedRecurringTaskForTargets(params: {
  seedKeyBase: string;
  taskIdBase: string;
  cron: string;
  description: string;
  prompt: string;
}): void {
  for (const target of primaryTargets) {
    const seedKey = `${params.seedKeyBase}:${target.channel}:${target.userId}`;
    if (dbState.get(seedKey)) continue;
    try {
      const nextRun = parseCronNext(params.cron, new Date(), config.scheduler.timezone);
      dbTasks.create({
        id: `${params.taskIdBase}-${target.channel}-${target.userId}`,
        userId: target.userId,
        chatId: target.chatId,
        channel: target.channel,
        type: "recurring",
        description: params.description,
        prompt: params.prompt,
        cron: params.cron,
        nextRunAt: nextRun.toISOString(),
        enabled: true,
        oneShot: false,
      });
      dbState.set(seedKey, true);
      log("boot", `Seeded ${params.description} for ${target.channel}:${target.userId} (next: ${nextRun.toISOString()})`);
    } catch {
      // already exists or DB not ready — safe to skip
    }
  }
}

// --- Seed built-in recurring tasks (once per install) ---
(function seedBuiltinTasks() {
  seedRecurringTaskForTargets({
    seedKeyBase: "builtin-skill-discovery-v2",
    taskIdBase: "builtin-skill-discovery",
    cron: config.features.skillDiscoveryCron,
    description: "Weekly skill discovery",
    prompt: "Search the skill shop for 3-5 interesting new skills relevant to my recent activity. Briefly list what you found with their rawUrl - don't install anything, just surface the options.",
  });
})();

// --- Seed daily briefing (requires Composio Gmail + Calendar) ---
(function seedDailyBriefing() {
  if (!config.composio?.apiKey) return;
  seedRecurringTaskForTargets({
    seedKeyBase: "builtin-daily-briefing-v2",
    taskIdBase: "builtin-daily-briefing",
    cron: config.features.dailyBriefingCron,
    description: "Daily morning briefing",
    prompt: "Give me a brief morning briefing. Check my calendar for today's events, check my recent emails for anything important, and list any pending tasks or reminders. Keep it concise - a quick overview to start my day.",
  });
})();

// --- Seed weekly review ---
(function seedWeeklyReview() {
  seedRecurringTaskForTargets({
    seedKeyBase: "builtin-weekly-review-v2",
    taskIdBase: "builtin-weekly-review",
    cron: config.features.weeklyReviewCron,
    description: "Weekly review",
    prompt: "Run a weekly review. Use assessmentSnapshot, listGoals, listPlans, listTasks, and listReviews. Identify wins, risks, contradictions, and the 1-3 highest leverage next actions. Store the review with storeReview and keep the message concise but real.",
  });
})();

// --- Seed goal drift audit ---
(function seedGoalDriftAudit() {
  seedRecurringTaskForTargets({
    seedKeyBase: "builtin-goal-drift-v2",
    taskIdBase: "builtin-goal-drift",
    cron: config.features.goalDriftCron,
    description: "Goal drift audit",
    prompt: "Run a goal drift audit. Compare the user's active goals, recent observations, interventions, tasks, and durable plans. Call out where goals and behavior seem misaligned, log any important observations, and recommend one intervention if needed.",
  });
})();

// --- Named agent routing wrapper ---
const NAMED_AGENT_RE = /^@([A-Za-z][A-Za-z0-9_-]*):\s*/;

function resolveNamedInput(content: string): { content: string; sessionKey?: string } | null {
  const match = content.match(NAMED_AGENT_RE);
  if (!match) return null;
  const name = match[1]!;
  const session = getNamedSession(name);
  if (!session) return null;
  return { content: content.slice(match[0].length), sessionKey: session.sessionKey };
}

function makeNamedStreamAgent(baseStreamAgent: typeof streamAgentFn): typeof streamAgentFn {
  return async (input) => {
    const resolved = resolveNamedInput(input.content);
    if (!resolved) return baseStreamAgent(input);
    return baseStreamAgent({
      ...input,
      content: resolved.content,
      sessionKey: resolved.sessionKey ?? input.sessionKey,
    });
  };
}

// --- Channels ---
let telegram: TelegramResult | null = null;
let slack: SlackResult | null = null;
let repl: { stop: () => void } | null = null;

const routedStreamAgent = makeNamedStreamAgent(streamAgentFn);

if (config.mode !== "cli-only" && (config.telegram.token || config.slack.botToken)) {
  // Read deploy timestamp written by SIGTERM handler on the previous run
  const deployTsFile = resolve(config.workspace, ".koda-deploy-ts");
  let deployDurationMs: number | undefined;
  try {
    const raw = await readFile(deployTsFile, "utf-8");
    const shutdownAt = parseInt(raw.trim(), 10);
    if (!Number.isNaN(shutdownAt)) deployDurationMs = Date.now() - shutdownAt;
    await unlink(deployTsFile).catch(() => {});
  } catch {
    // No timestamp file — fresh start or non-deploy restart
  }

  if (config.slack.botToken) {
    slack = await startSlack({ streamAgent: routedStreamAgent, config });
    log("boot", "Channel: slack enabled (webhook)");
  }

  if (config.telegram.token) {
    telegram = await startTelegram({ streamAgent: routedStreamAgent, config, deployDurationMs });
    log("boot", `Channel: telegram enabled${config.telegram.useWebhook ? " (webhook)" : " (polling)"}`);
  }
}

// --- Railway build monitor ---
let railwayMonitor: { stop(): void } | null = null;
if (telegram || slack) {
  railwayMonitor = startRailwayMonitor({
    onBuildDetected: async (msg) => {
      await Promise.all([
        telegram?.notifyAdmins(msg).catch(() => {}),
        slack?.notifyAdmins(msg).catch(() => {}),
      ]);
    },
    onBuildFailed: async (msg) => {
      await Promise.all([
        telegram?.notifyAdmins(msg).catch(() => {}),
        slack?.notifyAdmins(msg).catch(() => {}),
      ]);
    },
  });
}

if (config.mode === "cli-only") {
  repl = startRepl({
    runAgent,
    userId: config.cli.userId,
    chatId: config.cli.chatId,
    prompt: config.cli.prompt,
  });
  log("boot", "Channel: cli enabled");
}

// --- Proactive ---
let proactive: ReturnType<typeof startProactive> | null = null;
if (config.features.scheduler) {
  const defaultOwner = primaryTarget.userId;
  const defaultChannel = primaryTarget.channel;

  proactive = startProactive({
    runAgent,
    sendDirect: async (channel, chatId, text) => {
      if (channel === "cli") {
        log("reminder", text);
        return;
      }
      if (channel === "telegram" && telegram) {
        await telegram.sendDirect(chatId, text);
        return;
      }
      if (channel === "slack" && slack) {
        await slack.sendDirect(chatId, text);
        return;
      }
      logWarn("proactive", `no direct sender for channel: ${channel}`);
    },
    config,
    defaultUserId: defaultOwner,
    defaultChatId: primaryTarget.chatId,
    defaultChannel,
  });
  log("boot", "Proactive: started");
}

// --- Database backup ---
let backupTimer: ReturnType<typeof setInterval> | null = null;
if (config.features.autoBackup) {
  const backupDir = resolve(config.workspace, "backups");
  await mkdir(backupDir, { recursive: true });
  try {
    const path = backupDatabase(backupDir);
    log("backup", `Database backed up to ${path}`);
  } catch (err) {
    logWarn("backup", `Boot backup failed: ${(err as Error).message}`);
  }
  backupTimer = setInterval(() => {
    try {
      const path = backupDatabase(backupDir);
      log("backup", `Database backed up to ${path}`);
    } catch (err) {
      logWarn("backup", `Failed: ${(err as Error).message}`);
    }
  }, config.features.backupIntervalHours * 3_600_000);
}

// --- Hourly RAM auto-clean ---
const hourlyCleanTimer = setInterval(() => {
  try {
    const cleaned = dbMessages.cleanup(config.features.messageRetentionDays);
    vacuumDb();
    if (cleaned > 0) log("gc", `Cleaned ${cleaned} messages + vacuumed SQLite`);
  } catch (err) {
    logWarn("gc", `Periodic clean failed: ${(err as Error).message}`);
  }
}, config.features.gcIntervalHours * 3_600_000);

// --- Boot phase 6: HTTP Server ---
const server = bootServer({
  config,
  telegram,
  slack,
  skillLoader,
  memoryProvider,
  defaultUserId: primaryTarget.userId,
});

// --- Graceful shutdown ---
const shutdown = async (signal: "SIGTERM" | "SIGINT") => {
  log("shutdown", signal);
  if (backupTimer) clearInterval(backupTimer);
  clearInterval(hourlyCleanTimer);
  railwayMonitor?.stop();
  proactive?.stop();
  repl?.stop();

  // Write shutdown timestamp so next boot can compute deploy duration (SIGTERM = Railway deploy)
  if (signal === "SIGTERM") {
    const deployTsFile = resolve(config.workspace, ".koda-deploy-ts");
    await writeFile(deployTsFile, String(Date.now())).catch(() => {});
  }

  if (telegram) await telegram.stop(signal);
  if (slack) await slack.stop();
  soulLoader.dispose();
  contextWatcher?.close();
  contextDirWatcher?.close();
  if (contextReloadTimeout) clearTimeout(contextReloadTimeout);
  for (const mcp of mcpClients) {
    try { await mcp.client.close(); } catch { /* shutdown cleanup — ignore */ }
  }
  closeDb();
  server.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
