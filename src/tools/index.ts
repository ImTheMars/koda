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
import { registerSkillShopTools } from "./skillshop.js";
import { registerSandboxTools } from "./sandbox.js";

interface ToolRuntimeContext {
  userId: string;
  chatId: string;
  channel: string;
  toolCost: { total: number };
}

const DEFAULT_CONTEXT: ToolRuntimeContext = {
  userId: "owner",
  chatId: "owner",
  channel: "cli",
  toolCost: { total: 0 },
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
    ...registerSkillTools({ skillLoader, workspace }),
  };

  // Search + Skill Shop (optional — needs Exa key)
  if (config.exa.apiKey) {
    Object.assign(tools, registerSearchTools({
      apiKey: config.exa.apiKey,
      numResults: config.exa.numResults,
      onCost: (amount) => { getToolContext().toolCost.total += amount; },
    }));
    Object.assign(tools, registerSkillShopTools({ exaApiKey: config.exa.apiKey, workspace, githubToken: config.github?.token }));
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

  return tools;
}
