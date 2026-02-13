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
import { registerExecTools } from "./exec.js";
import { registerBrowserTools } from "./browser.js";
import { registerScheduleTools } from "./schedule.js";
import { registerSkillTools } from "./skills.js";
import { registerSoulTools, SoulLoader } from "./soul.js";

interface ToolRuntimeContext {
  userId: string;
  chatId: string;
  channel: string;
}

const DEFAULT_CONTEXT: ToolRuntimeContext = {
  userId: "owner",
  chatId: "owner",
  channel: "cli",
};

const toolContextStore = new AsyncLocalStorage<ToolRuntimeContext>();

export function withToolContext<T>(ctx: ToolRuntimeContext, fn: () => Promise<T>): Promise<T> {
  return toolContextStore.run(ctx, fn);
}

function getToolContext(): ToolRuntimeContext {
  return toolContextStore.getStore() ?? DEFAULT_CONTEXT;
}

export function buildTools(deps: {
  config: Config;
  memoryProvider: MemoryProvider;
  skillLoader: SkillLoader;
  workspace: string;
  soulLoader?: SoulLoader;
}): ToolSet {
  const { config, memoryProvider, skillLoader, workspace } = deps;

  const tools: ToolSet = {
    ...registerMemoryTools({
      memory: memoryProvider,
      getUserId: () => getToolContext().userId,
    }),
    ...registerFilesystemTools({ workspace }),
    ...registerExecTools({ workspace }),
    ...registerSkillTools({ skillLoader, workspace }),
  };

  // Search (optional — needs Tavily key)
  if (config.tavily.apiKey) {
    Object.assign(tools, registerSearchTools({ apiKey: config.tavily.apiKey }));
  }

  // Schedule
  Object.assign(tools, registerScheduleTools({
    timezone: config.scheduler.timezone,
    getUserId: () => getToolContext().userId,
    getChatId: () => getToolContext().chatId,
    getChannel: () => getToolContext().channel,
  }));

  // Browser (optional)
  if (config.features.browser) {
    Object.assign(tools, registerBrowserTools({ headless: config.browser.headless }));
  }

  // Soul
  if (deps.soulLoader) {
    Object.assign(tools, registerSoulTools({ soulLoader: deps.soulLoader }));
  }

  return tools;
}
