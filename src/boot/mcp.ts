/**
 * Boot phase 3 — MCP client connections, health check, failure-triggered reconnect.
 */

import { createMCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import type { Config } from "../config.js";

type McpServerConfig = Config["mcp"]["servers"][number];

function buildMcpTransport(server: McpServerConfig) {
  if (server.transport === "stdio") {
    return { type: "stdio" as const, command: server.command, args: server.args, env: server.env };
  }
  return { type: server.transport, url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
}

async function connectMcpServer(server: McpServerConfig, toolSet: ToolSet, namespace: boolean) {
  const client = await createMCPClient({ transport: buildMcpTransport(server) as any });
  const rawTools = await client.tools();

  // Namespace tool names to prevent collisions
  const namespacedTools: ToolSet = {};
  for (const [name, tool] of Object.entries(rawTools)) {
    const key = namespace ? `${server.name}_${name}` : name;
    namespacedTools[key] = tool as any;
  }

  Object.assign(toolSet, namespacedTools);
  return { client, toolKeys: Object.keys(namespacedTools) };
}

export interface McpEntry {
  name: string;
  server: McpServerConfig;
  client: Awaited<ReturnType<typeof connectMcpServer>>["client"];
  reconnecting: boolean;
  lastSuccess: number;
}

export async function bootMcp(config: Config, tools: ToolSet): Promise<McpEntry[]> {
  const mcpClients: McpEntry[] = [];
  const shouldNamespace = config.mcp.servers.length > 1;

  for (const server of config.mcp.servers) {
    try {
      const { client, toolKeys } = await connectMcpServer(server, tools, shouldNamespace);
      mcpClients.push({ name: server.name, server, client, reconnecting: false, lastSuccess: Date.now() });
      console.log(`[boot] MCP: ${server.name} (${toolKeys.length} tools${shouldNamespace ? ", namespaced" : ""})`);
    } catch (err) {
      console.warn(`[boot] MCP: ${server.name} failed to connect:`, (err as Error).message);
    }
  }

  return mcpClients;
}

/**
 * Reconnect a single MCP server on tool call failure.
 * Returns true if reconnect succeeded.
 */
export async function reconnectMcpServer(entry: McpEntry, tools: ToolSet, namespace: boolean): Promise<boolean> {
  if (entry.reconnecting) return false;
  entry.reconnecting = true;
  console.warn(`[mcp] ${entry.name} unreachable — reconnecting...`);
  try { await entry.client.close(); } catch {}

  await new Promise((r) => setTimeout(r, 2000));

  try {
    const { client, toolKeys } = await connectMcpServer(entry.server, tools, namespace);
    entry.client = client;
    entry.lastSuccess = Date.now();
    entry.reconnecting = false;
    console.log(`[mcp] ${entry.name} reconnected (${toolKeys.length} tools)`);
    return true;
  } catch (err) {
    entry.reconnecting = false;
    console.warn(`[mcp] ${entry.name} reconnect failed:`, (err as Error).message);
    return false;
  }
}
