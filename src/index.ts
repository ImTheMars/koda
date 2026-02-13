/**
 * Koda v1 — composition root.
 *
 * loadConfig → initDb → init providers → build tools → register channels → start proactive
 */

import { mkdir } from "fs/promises";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { initDb, closeDb } from "./db.js";
import { createAgent, type AgentDeps } from "./agent.js";
import { SoulLoader } from "./tools/soul.js";
import { SkillLoader } from "./tools/skills.js";
import { createMemoryProvider } from "./tools/memory.js";
import { startRepl } from "./channels/repl.js";
import { startTelegram } from "./channels/telegram.js";
import { startProactive } from "./proactive.js";
import { buildTools } from "./tools/index.js";

// --- CLI routing ---
const command = process.argv[2];
if (command === "setup" || command === "doctor" || command === "upgrade" || command === "version") {
  const { runCli } = await import("./cli.js");
  await runCli(command);
  process.exit(0);
}

// --- Boot ---
const config = await loadConfig();
console.log(`[boot] Config loaded (mode: ${config.mode}, workspace: ${config.workspace})`);

await mkdir(config.workspace, { recursive: true });

const dbPath = resolve(config.workspace, "koda.db");
initDb(dbPath);
console.log("[boot] Database initialized");

// --- Providers ---
const memoryProvider = createMemoryProvider(config.supermemory.apiKey);
const soulLoader = new SoulLoader(config.soul.path, config.soul.dir);
await soulLoader.initialize();
console.log(`[boot] Soul: ${soulLoader.getSoul().identity.name}`);

const skillLoader = new SkillLoader(config.workspace);
const skills = await skillLoader.listSkills();
console.log(`[boot] Skills: ${skills.length} loaded`);

// --- Tools ---
const tools = buildTools({ config, memoryProvider, skillLoader, workspace: config.workspace, soulLoader });
console.log(`[boot] Tools: ${Object.keys(tools).join(", ")}`);

// --- Agent ---
const agentDeps: AgentDeps = {
  config,
  tools,
  getSoulPrompt: () => soulLoader.generatePrompt(),
  getSkillsSummary: () => skillLoader.buildSkillsSummary(),
  getMemories: (userId, query, sessionKey) => memoryProvider.recall(userId, query, 5, sessionKey),
  isMemoryDegraded: () => memoryProvider.isDegraded,
};

const runAgent = createAgent(agentDeps);

// --- Channels ---
let telegram: { stop: () => Promise<void>; sendDirect: (chatId: string, text: string) => Promise<void> } | null = null;
let repl: { stop: () => void } | null = null;

if (config.mode !== "cli-only" && config.telegram.token) {
  telegram = startTelegram({ runAgent, config });
  console.log("[boot] Channel: telegram enabled");
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
if (config.features.scheduler || config.features.heartbeat) {
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

// --- Health server ---
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "1.0.1", uptime: process.uptime() });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`[boot] Health server on :${server.port}/health`);

// --- Graceful shutdown ---
const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down...`);
  proactive?.stop();
  repl?.stop();
  if (telegram) await telegram.stop();
  soulLoader.dispose();
  closeDb();
  server.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
