/**
 * Koda — composition root.
 *
 * loadConfig → initDb → init providers → build tools → register channels → start proactive
 */

import { mkdir } from "fs/promises";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { initDb, closeDb, messages as dbMessages, state as dbState } from "./db.js";
import { createAgent, createStreamAgent, type AgentDeps } from "./agent.js";
import { SoulLoader } from "./tools/soul.js";
import { SkillLoader } from "./tools/skills.js";
import { createMemoryProvider } from "./tools/memory.js";
import { startRepl } from "./channels/repl.js";
import { startTelegram } from "./channels/telegram.js";
import { startProactive } from "./proactive.js";
import { buildTools } from "./tools/index.js";
import { enableDebug } from "./log.js";
import { createMCPClient } from "@ai-sdk/mcp";

// --- CLI routing ---
const command = process.argv[2];
if (command === "setup" || command === "doctor" || command === "upgrade" || command === "version") {
  const { runCli } = await import("./cli.js");
  await runCli(command);
  process.exit(0);
}

// --- Boot ---
const config = await loadConfig();
if (config.features.debug) enableDebug();
console.log(`[boot] Config loaded (mode: ${config.mode}, workspace: ${config.workspace})`);

await mkdir(config.workspace, { recursive: true });

const dbPath = resolve(config.workspace, "koda.db");
initDb(dbPath);
const cleanedMessages = dbMessages.cleanup(90);
if (cleanedMessages > 0) {
  console.log(`[boot] Cleaned ${cleanedMessages} messages older than 90 days`);
}
console.log("[boot] Database initialized");

// --- Providers ---
const memoryProvider = createMemoryProvider(config.supermemory.apiKey);
const soulLoader = new SoulLoader(config.soul.path, config.soul.dir);
await soulLoader.initialize();
console.log(`[boot] Soul: ${soulLoader.getSoul().identity.name}`);

const skillLoader = new SkillLoader(config.workspace);
const skills = await skillLoader.listSkills();
console.log(`[boot] Skills: ${skills.length} loaded`);

// --- One-time Supermemory filter prompt setup ---
(async () => {
  const FILTER_KEY = "supermemory_filter_set_v1";
  if (!dbState.get(FILTER_KEY)) {
    try {
      await (memoryProvider.client as any).settings.update({
        shouldLLMFilter: true,
        filterPrompt: `Personal AI assistant called Koda. Prioritize:
- User preferences and habits (response style, tools, languages, workflows)
- Corrections and clarifications the user makes to Koda's responses
- Important personal facts (name, timezone, projects, roles, goals)
- Action items and outcomes (what worked, what didn't)
- Recurring topics and interests

Skip:
- Casual greetings and small talk with no informational content
- Tool call noise and intermediate processing steps
- System messages and error outputs
- Duplicate information already captured`,
      });
      dbState.set(FILTER_KEY, true);
      console.log("[boot] Supermemory filter prompt configured");
    } catch (err) {
      console.warn("[boot] Supermemory filter setup skipped:", (err as Error).message);
    }
  }
})();

// --- Tools ---
const tools = buildTools({ config, memoryProvider, skillLoader, workspace: config.workspace, soulLoader });

// --- MCP Clients ---
type McpServerConfig = Config["mcp"]["servers"][number];

function buildMcpTransport(server: McpServerConfig) {
  if (server.transport === "stdio") {
    return { type: "stdio" as const, command: server.command, args: server.args, env: server.env };
  }
  return { type: server.transport, url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
}

async function connectMcpServer(server: McpServerConfig, toolSet: ReturnType<typeof buildTools>) {
  const client = await createMCPClient({ transport: buildMcpTransport(server) as any });
  const mcpTools = await client.tools();
  Object.assign(toolSet, mcpTools);
  return { client, toolKeys: Object.keys(mcpTools) };
}

const mcpClients: Array<{ name: string; server: McpServerConfig; client: Awaited<ReturnType<typeof connectMcpServer>>["client"] }> = [];

for (const server of config.mcp.servers) {
  try {
    const { client, toolKeys } = await connectMcpServer(server, tools);
    mcpClients.push({ name: server.name, server, client });
    console.log(`[boot] MCP: ${server.name} (${toolKeys.length} tools)`);
  } catch (err) {
    console.warn(`[boot] MCP: ${server.name} failed to connect:`, (err as Error).message);
  }
}

console.log(`[boot] Tools: ${Object.keys(tools).join(", ")}`);

// Health-check: reconnect crashed MCP servers every 60 s
const mcpRestartTimer = setInterval(async () => {
  for (const entry of mcpClients) {
    if (!entry.server.autoRestart) continue;
    try {
      await entry.client.tools();
    } catch {
      console.warn(`[mcp] ${entry.name} unreachable — reconnecting...`);
      try { await entry.client.close(); } catch {}
      await Bun.sleep(2000);
      try {
        const { client, toolKeys } = await connectMcpServer(entry.server, tools);
        entry.client = client;
        console.log(`[mcp] ${entry.name} reconnected (${toolKeys.length} tools)`);
      } catch (err) {
        console.warn(`[mcp] ${entry.name} reconnect failed:`, (err as Error).message);
      }
    }
  }
}, 60_000);

// --- Agent ---
const agentDeps: AgentDeps = {
  config,
  tools,
  getSoulPrompt: () => soulLoader.generatePrompt(),
  getSkillsSummary: () => skillLoader.buildSkillsSummary(),
  getProfile: (userId, query, sessionKey) => memoryProvider.getProfile(userId, query || undefined, sessionKey),
  ingestConversation: (sessionKey, userId, messages) => memoryProvider.ingestConversation(sessionKey, userId, messages),
};

// Setup entity context for owner on first boot
memoryProvider.setupEntityContext(config.owner.id).catch(() => {});

const runAgent = createAgent(agentDeps);
const streamAgentFn = createStreamAgent(agentDeps);

// --- Channels ---
let telegram: { stop: () => Promise<void>; sendDirect: (chatId: string, text: string) => Promise<void> } | null = null;
let repl: { stop: () => void } | null = null;

if (config.mode !== "cli-only" && config.telegram.token) {
  telegram = startTelegram({ streamAgent: streamAgentFn, config });
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

// --- Health server ---
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "1.3.2", uptime: process.uptime() });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`[boot] Health server on :${server.port}/health`);

// --- Graceful shutdown ---
const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down...`);
  clearInterval(mcpRestartTimer);
  proactive?.stop();
  repl?.stop();
  if (telegram) await telegram.stop();
  soulLoader.dispose();
  for (const mcp of mcpClients) {
    try { await mcp.client.close(); } catch {}
  }
  closeDb();
  server.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
