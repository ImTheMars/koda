/**
 * Boot phase 1 — config loading, debug enable, workspace mkdir.
 */

import { mkdir } from "fs/promises";
import { loadConfig, type Config } from "../config.js";
import { enableDebug } from "../log.js";

export async function bootConfig(): Promise<Config> {
  const config = await loadConfig();
  if (config.features.debug) enableDebug();
  console.log(`[boot] Config loaded (mode: ${config.mode}, workspace: ${config.workspace})`);
  await mkdir(config.workspace, { recursive: true });
  return config;
}
