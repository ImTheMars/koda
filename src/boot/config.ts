/**
 * Boot phase 1 — config loading, debug enable, workspace mkdir.
 */

import { mkdir } from "fs/promises";
import { loadConfig, type Config } from "../config.js";
import { enableDebug, log, logDebug } from "../log.js";

export async function bootConfig(): Promise<Config> {
  const config = await loadConfig();
  if (config.features.debug) enableDebug();
  log("boot", `Config loaded (mode: ${config.mode}, workspace: ${config.workspace})`);
  logDebug("boot", "Config details", {
    mode: config.mode,
    fastModel: config.openrouter.fastModel,
    deepModel: config.openrouter.deepModel,
    maxSteps: config.agent.maxSteps,
    maxTokens: config.agent.maxTokens,
    temperature: config.agent.temperature,
    historyTokenBudget: config.agent.historyTokenBudget,
    escalationStep: config.agent.escalationStep,
    circuitBreakerThreshold: config.agent.circuitBreakerThreshold,
    enableSummarization: config.agent.enableSummarization,
    scheduler: config.features.scheduler,
    webFetch: config.features.webFetch,
    httpRequest: config.features.httpRequest,
    outcomeLearning: config.features.enableOutcomeLearning,
    timezone: config.scheduler.timezone,
    ollamaEnabled: config.ollama.enabled,
    subagentTimeout: config.subagent.timeoutMs,
    subagentMaxSteps: config.subagent.maxSteps,
  });
  await mkdir(config.workspace, { recursive: true });
  return config;
}
