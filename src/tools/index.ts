/**
 * Tools index — builds the complete ToolSet from all capabilities.
 *
 * Tools resolve user/chat/channel from AsyncLocalStorage request context
 * set by the agent around each generateText call.
 */

import type { ToolSet } from "ai";
import { AsyncLocalStorage } from "async_hooks";
import type { Config } from "../config.js";
import type { MemoryProvider } from "./memory.js";
import type { SkillLoader } from "./skills.js";
import { registerMemoryTools } from "./memory.js";
import { registerSearchTools } from "./search.js";
import { registerFilesystemTools } from "./filesystem.js";
import { registerScheduleTools } from "./schedule.js";
import { registerSkillTools } from "./skills.js";
import { registerSoulTools, SoulLoader } from "./soul.js";
import { registerStatusTools } from "./status.js";
import { registerSandboxTools } from "./sandbox.js";
import { registerImageTools } from "./image.js";
import { registerFileTools } from "./files.js";
import { createComposioClient } from "../composio.js";

interface ToolRuntimeContext {
  userId: string;
  chatId: string;
  channel: string;
  toolCost: { total: number };
  pendingFiles: Array<{ path: string; caption?: string }>;
}

const DEFAULT_CONTEXT: ToolRuntimeContext = {
  userId: "owner",
  chatId: "owner",
  channel: "cli",
  toolCost: { total: 0 },
  pendingFiles: [],
};

const toolContextStore = new AsyncLocalStorage<ToolRuntimeContext>();

export function withToolContext<T>(ctx: ToolRuntimeContext, fn: () => Promise<T>): Promise<T> {
  return toolContextStore.run(ctx, fn);
}

function getToolContext(): ToolRuntimeContext {
  return toolContextStore.getStore() ?? DEFAULT_CONTEXT;
}

/** Increment the tool cost accumulator for the current request context. */
export function addToolCost(amount: number): void {
  const ctx = toolContextStore.getStore();
  if (ctx) ctx.toolCost.total += amount;
}

/** Add a file to send after agent completes. */
export function addPendingFile(path: string, caption?: string): void {
  const ctx = toolContextStore.getStore();
  if (ctx) ctx.pendingFiles.push({ path, caption });
}

/** Get pending files from current context (called by agent after completion). */
export function getPendingFiles(): Array<{ path: string; caption?: string }> {
  const ctx = toolContextStore.getStore();
  return ctx?.pendingFiles ?? [];
}

export async function buildTools(deps: {
  config: Config;
  memoryProvider: MemoryProvider;
  skillLoader: SkillLoader;
  workspace: string;
  soulLoader?: SoulLoader;
}): Promise<ToolSet> {
  const { config, memoryProvider, skillLoader, workspace } = deps;

  const tools: ToolSet = {
    ...registerMemoryTools({
      memory: memoryProvider,
      getUserId: () => getToolContext().userId,
    }),
    ...registerFilesystemTools({ workspace }),
    ...registerSkillTools({ skillLoader, workspace, exaApiKey: config.exa.apiKey, githubToken: config.github?.token }),
  };

  // Search (optional — needs Exa key)
  if (config.exa.apiKey) {
    Object.assign(tools, registerSearchTools({
      apiKey: config.exa.apiKey,
      numResults: config.exa.numResults,
      onCost: addToolCost,
    }));
  }

  // Schedule
  Object.assign(tools, registerScheduleTools({
    timezone: config.scheduler.timezone,
    getUserId: () => getToolContext().userId,
    getChatId: () => getToolContext().chatId,
    getChannel: () => getToolContext().channel,
  }));

  // Soul
  if (deps.soulLoader) {
    Object.assign(tools, registerSoulTools({ soulLoader: deps.soulLoader }));
  }

  // Status
  Object.assign(tools, registerStatusTools({ memory: memoryProvider }));

  // Safe sandbox (async — checks Docker availability at boot)
  Object.assign(tools, await registerSandboxTools({ workspace }));

  // Image generation
  Object.assign(tools, registerImageTools({
    apiKey: config.openrouter.apiKey,
    model: config.openrouter.imageModel,
    onCost: addToolCost,
  }));

  // File sending
  Object.assign(tools, registerFileTools({ workspace }));

  // Composio integrations (Gmail, Calendar, GitHub)
  if (config.composio?.apiKey) {
    try {
      const composio = createComposioClient({ apiKey: config.composio.apiKey });
      const connectedApps = await composio.listConnectedApps();

      if (connectedApps.length > 0) {
        const composioTools = await composio.getTools(connectedApps);
        Object.assign(tools, composioTools);
        console.log(`[boot] Composio: ${connectedApps.join(", ")} (${Object.keys(composioTools).length} tools)`);
      } else {
        console.log("[boot] Composio: no connected apps — run `koda setup composio`");
      }
    } catch (err) {
      console.warn("[boot] Composio: failed to load tools:", (err as Error).message);
    }
  }

  return tools;
}
