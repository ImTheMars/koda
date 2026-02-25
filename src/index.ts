/**
 * Koda — composition root.
 *
 * bootConfig → initDb → bootProviders → build tools → bootMcp → agent → channels → proactive → bootServer
 */

import { mkdir } from "fs/promises";
import { resolve } from "path";
import { initDb, closeDb, messages as dbMessages, state as dbState, tasks as dbTasks, vacuumDb, backupDatabase } from "./db.js";
import { parseCronNext } from "./time.js";
import { createAgent, createStreamAgent, type AgentDeps } from "./agent.js";
import { startRepl } from "./channels/repl.js";
import { startTelegram, type TelegramResult } from "./channels/telegram.js";
import { startProactive } from "./proactive.js";
import { buildTools } from "./tools/index.js";
import { registerSubAgentTools, getNamedSession } from "./tools/subagent.js";

import { bootConfig } from "./boot/config.js";
import { bootProviders } from "./boot/providers.js";
import { bootMcp, reconnectMcpServer, type McpEntry } from "./boot/mcp.js";
import { bootServer } from "./boot/server.js";

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
const cleanedMessages = dbMessages.cleanup(90);
if (cleanedMessages > 0) {
  console.log(`[boot] Cleaned ${cleanedMessages} messages older than 90 days`);
}
console.log("[boot] Database initialized");

// --- Boot phase 3: Providers ---
const { memoryProvider, soulLoader, skillLoader, contextWatcher, contextDirWatcher, contextReloadTimeout, getContextContent } = await bootProviders(config);

// --- Boot phase 4: Tools ---
const tools = await buildTools({ config, memoryProvider, skillLoader, workspace: config.workspace, soulLoader });

// --- Boot phase 5: MCP ---
const mcpClients = await bootMcp(config, tools);

console.log(`[boot] Tools: ${Object.keys(tools).join(", ")}`);

// --- Agent ---
const agentDeps: AgentDeps = {
  config,
  tools,
  getSoulPrompt: () => soulLoader.generatePrompt(),
  getContextPrompt: () => getContextContent(),
  getSkillsSummary: () => skillLoader.buildSkillsSummary(),
  getProfile: (userId, query, sessionKey) => memoryProvider.getProfile(userId, query || undefined, sessionKey),
  ingestConversation: (sessionKey, userId, messages) => memoryProvider.ingestConversation(sessionKey, userId, messages),
  getSoulAcks: () => soulLoader.getAckTemplates(),
};

// Setup entity context for owner on first boot
memoryProvider.setupEntityContext(config.owner.id).catch(() => {});

const runAgent = createAgent(agentDeps);
const streamAgentFn = createStreamAgent(agentDeps);

// Register spawnAgent after runAgent exists (post-boot to avoid circular dep).
Object.assign(tools, registerSubAgentTools({
  agentDeps,
  masterTools: tools,
  timeoutMs: config.subagent.timeoutMs,
  maxStepsCap: config.subagent.maxSteps,
}));

// --- Seed built-in recurring tasks (once per install) ---
(function seedBuiltinTasks() {
  const SEED_KEY = "builtin-skill-discovery-v1";
  if (dbState.get(SEED_KEY)) return;
  try {
    const ownerId = config.telegram.adminIds[0] ?? config.owner.id;
    const channel = config.telegram.token ? "telegram" : "cli";
    const chatId = ownerId;
    const cron = "sun 09:00";
    const nextRun = parseCronNext(cron, new Date(), config.scheduler.timezone);
    dbTasks.create({
      id: "builtin-skill-discovery",
      userId: ownerId,
      chatId,
      channel,
      type: "recurring",
      description: "Weekly skill discovery",
      prompt: "Search the skill shop for 3–5 interesting new skills relevant to my recent activity. " +
              "Briefly list what you found with their rawUrl — don't install anything, just surface the options.",
      cron,
      nextRunAt: nextRun.toISOString(),
      enabled: true,
      oneShot: false,
    });
    dbState.set(SEED_KEY, true);
    console.log(`[boot] Seeded weekly skill discovery (next: ${nextRun.toISOString()})`);
  } catch {
    // Already exists or DB not ready — safe to skip
  }
})();

// --- Seed daily briefing (requires Composio Gmail + Calendar) ---
(function seedDailyBriefing() {
  const BRIEFING_KEY = "builtin-daily-briefing-v1";
  if (dbState.get(BRIEFING_KEY)) return;
  if (!config.composio?.apiKey) return;
  try {
    const ownerId = config.telegram.adminIds[0] ?? config.owner.id;
    const channel = config.telegram.token ? "telegram" : "cli";
    const chatId = ownerId;
    const cron = "08:00";
    const nextRun = parseCronNext(cron, new Date(), config.scheduler.timezone);
    dbTasks.create({
      id: "builtin-daily-briefing",
      userId: ownerId,
      chatId,
      channel,
      type: "recurring",
      description: "Daily morning briefing",
      prompt: "Give me a brief morning briefing. Check my calendar for today's events, " +
              "check my recent emails for anything important, and list any pending tasks or reminders. " +
              "Keep it concise — a quick overview to start my day.",
      cron,
      nextRunAt: nextRun.toISOString(),
      enabled: true,
      oneShot: false,
    });
    dbState.set(BRIEFING_KEY, true);
    console.log(`[boot] Seeded daily briefing (next: ${nextRun.toISOString()})`);
  } catch {}
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
let repl: { stop: () => void } | null = null;

const routedStreamAgent = makeNamedStreamAgent(streamAgentFn);

if (config.mode !== "cli-only" && config.telegram.token) {
  telegram = startTelegram({ streamAgent: routedStreamAgent, config });
  console.log(`[boot] Channel: telegram enabled${config.telegram.useWebhook ? " (webhook)" : " (polling)"}`);
}

if (config.mode === "cli-only") {
  repl = startRepl({
    runAgent,
    userId: config.cli.userId,
    chatId: config.cli.chatId,
    prompt: config.cli.prompt,
  });
  console.log("[boot] Channel: cli enabled");
}

// --- Proactive ---
let proactive: ReturnType<typeof startProactive> | null = null;
if (config.features.scheduler) {
  const defaultOwner = config.telegram.adminIds[0] ?? config.owner.id;
  const defaultChannel = telegram ? "telegram" : "cli";

  proactive = startProactive({
    runAgent,
    sendDirect: async (channel, chatId, text) => {
      if (channel === "cli") {
        console.log(`[reminder] ${text}`);
        return;
      }
      if (channel === "telegram" && telegram) {
        await telegram.sendDirect(chatId, text);
        return;
      }
      console.warn(`[proactive] no direct sender for channel: ${channel}`);
    },
    config,
    defaultUserId: defaultOwner,
    defaultChatId: defaultOwner,
    defaultChannel,
  });
  console.log("[boot] Proactive: started");
}

// --- Database backup ---
let backupTimer: ReturnType<typeof setInterval> | null = null;
if (config.features.autoBackup) {
  const backupDir = resolve(config.workspace, "backups");
  await mkdir(backupDir, { recursive: true });
  try {
    const path = backupDatabase(backupDir);
    console.log(`[backup] Database backed up to ${path}`);
  } catch (err) {
    console.warn("[backup] Boot backup failed:", (err as Error).message);
  }
  backupTimer = setInterval(() => {
    try {
      const path = backupDatabase(backupDir);
      console.log(`[backup] Database backed up to ${path}`);
    } catch (err) {
      console.warn("[backup] Failed:", (err as Error).message);
    }
  }, 24 * 60 * 60 * 1000);
}

// --- Hourly RAM auto-clean ---
const hourlyCleanTimer = setInterval(() => {
  try {
    const cleaned = dbMessages.cleanup(90);
    vacuumDb();
    if (cleaned > 0) console.log(`[gc] Cleaned ${cleaned} messages + vacuumed SQLite`);
  } catch (err) {
    console.warn("[gc] Hourly clean failed:", (err as Error).message);
  }
}, 60 * 60 * 1000);

// --- Boot phase 6: HTTP Server ---
const dashOwner = config.telegram.adminIds[0] ?? config.owner.id;
const server = bootServer({
  config,
  telegram,
  skillLoader,
  memoryProvider,
  defaultUserId: dashOwner,
});

// --- Graceful shutdown ---
const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down...`);
  if (backupTimer) clearInterval(backupTimer);
  clearInterval(hourlyCleanTimer);
  proactive?.stop();
  repl?.stop();
  if (telegram) await telegram.stop();
  soulLoader.dispose();
  contextWatcher?.close();
  contextDirWatcher?.close();
  if (contextReloadTimeout) clearTimeout(contextReloadTimeout);
  for (const mcp of mcpClients) {
    try { await mcp.client.close(); } catch {}
  }
  closeDb();
  server.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
