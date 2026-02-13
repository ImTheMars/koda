/**
 * Tools index — builds the complete ToolSet from all capabilities.
 *
 * Context closure: tools receive getUserId/getChatId/getChannel via a shared ref
 * that's set per-request in the agent, instead of AsyncLocalStorage.
 */

import type { ToolSet } from "ai";
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

/** Shared context ref — set per-request before tool execution */
export const toolContext = {
  userId: "owner",
  chatId: "owner",
  channel: "cli",
};

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
      getUserId: () => toolContext.userId,
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
    getUserId: () => toolContext.userId,
    getChatId: () => toolContext.chatId,
    getChannel: () => toolContext.channel,
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
