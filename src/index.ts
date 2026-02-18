/**
 * Koda — composition root.
 *
 * loadConfig → initDb → init providers → build tools → register channels → start proactive
 */

import { mkdir } from "fs/promises";
import { resolve, join } from "path";
import { loadConfig } from "./config.js";
import { initDb, closeDb, getDb, messages as dbMessages, entities as dbEntities, relations as dbRelations, memories as dbMemoriesTable, state as dbState } from "./db.js";
import { createAgent, createStreamAgent, type AgentDeps } from "./agent.js";
import { SoulLoader } from "./tools/soul.js";
import { SkillLoader } from "./tools/skills.js";
import { createLocalMemoryProvider } from "./memory/index.js";
import { runV3Migration } from "./memory/migrate.js";
import { startRepl } from "./channels/repl.js";
import { startTelegram } from "./channels/telegram.js";
import { startProactive } from "./proactive.js";
import { buildTools } from "./tools/index.js";
import { enableDebug } from "./log.js";
import { createMCPClient } from "@ai-sdk/mcp";
import type { Config } from "./config.js";

// --- CLI routing ---
const command = process.argv[2];
if (command === "setup" || command === "doctor" || command === "upgrade" || command === "version" || command === "memory") {
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

// --- v2 → v3 migration (runs once, non-blocking) ---
runV3Migration(config.workspace).catch((err) => {
  console.warn("[boot] Migration warning:", (err as Error).message);
});

// --- Providers ---
const memoryProvider = createLocalMemoryProvider(config, config.workspace);
const soulLoader = new SoulLoader(config.soul.path, config.soul.dir);
await soulLoader.initialize();
console.log(`[boot] Soul: ${soulLoader.getSoul().identity.name}`);

const skillLoader = new SkillLoader(config.workspace);
const skills = await skillLoader.listSkills();
console.log(`[boot] Skills: ${skills.length} loaded`);

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
    memoryProvider,
  });
  console.log("[boot] Proactive: started");
}

// --- Health + Web UI server ---
const GRAPH_HTML = Bun.file(join(import.meta.dir, "../public/graph.html"));

function resolveGraphUserId(fallback: string): string {
  try {
    // Single-user bot: pick the first user that actually has entities in the DB
    const row = getDb().query("SELECT user_id FROM memory_entities LIMIT 1").get() as { user_id: string } | null;
    return row?.user_id ?? fallback;
  } catch {
    return fallback;
  }
}

function buildGraphApiResponse(userId: string): Response {
  const ents = dbEntities.listByUser(userId);
  const stats = dbMemoriesTable.getStats(userId);
  const entityCount = dbEntities.count(userId);

  // Map: memoryId → list of entityIds that reference it
  const memoryToEntities = new Map<string, string[]>();
  for (const e of ents) {
    const rels = dbRelations.listFromEntity(e.id);
    for (const r of rels) {
      if (r.toMemory) {
        const list = memoryToEntities.get(r.toMemory) ?? [];
        list.push(e.id);
        memoryToEntities.set(r.toMemory, list);
      }
    }
  }

  const nodes = ents.map((e) => {
    const rels = dbRelations.listFromEntity(e.id);
    return {
      id: e.id,
      label: e.name,
      group: e.type,
      relations: rels.map((r) => r.relation),
    };
  });

  // Collect all edges, preferring named relations over co_occurs
  const edgeMap = new Map<string, { from: string; to: string; label: string }>();

  // Explicit entity→entity edges from DB
  for (const e of ents) {
    const rels = dbRelations.listFromEntity(e.id);
    for (const r of rels) {
      if (!r.toEntity) continue;
      const key = [e.id, r.toEntity].sort().join("::");
      const existing = edgeMap.get(key);
      // Prefer named relations over co_occurs
      if (!existing || (existing.label === "co_occurs" && r.relation !== "co_occurs")) {
        edgeMap.set(key, { from: e.id, to: r.toEntity, label: r.relation });
      }
    }
  }

  // Implicit co-occurrence from shared memories (only if no edge exists yet)
  for (const [, entityIds] of memoryToEntities) {
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        const a = entityIds[i]!;
        const b = entityIds[j]!;
        const key = [a, b].sort().join("::");
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { from: a, to: b, label: "co_occurs" });
        }
      }
    }
  }

  const edges = Array.from(edgeMap.values());

  const lastDecay = dbState.get<string>(`last_decay_${userId}`) ?? null;
  const lastReflection = dbState.get<string>(`last_reflect_${userId}`) ?? null;

  return Response.json({
    nodes,
    edges,
    stats: { ...stats, entityCount, lastDecay, lastReflection },
  });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "2.0.0", uptime: process.uptime(), memory: config.memory.provider });
    }

    if (url.pathname === "/graph") {
      return new Response(GRAPH_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/graph") {
      try {
        const configUserId = config.telegram.adminIds[0] ?? config.owner.id;
        const userId = resolveGraphUserId(configUserId);
        return buildGraphApiResponse(userId);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});
console.log(`[boot] Health server on :${server.port}/health`);
console.log(`[boot] Memory graph  on :${server.port}/graph`);

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
