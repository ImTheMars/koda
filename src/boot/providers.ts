/**
 * Boot phase 2 — memory, soul, skills, context, Ollama init.
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import { watch, type FSWatcher } from "fs";
import type { Config } from "../config.js";
import { createMemoryProvider, type MemoryProvider } from "../tools/memory.js";
import { SoulLoader } from "../tools/soul.js";
import { SkillLoader } from "../tools/skills.js";
import { initOllama } from "../agent.js";

export interface ProviderResult {
  memoryProvider: MemoryProvider;
  soulLoader: SoulLoader;
  skillLoader: SkillLoader;
  contextContent: string | null;
  contextWatcher: FSWatcher | null;
  contextDirWatcher: FSWatcher | null;
  contextReloadTimeout: ReturnType<typeof setTimeout> | null;
  getContextContent: () => string | null;
}

export async function bootProviders(config: Config): Promise<ProviderResult> {
  const memoryProvider = createMemoryProvider(config);

  const soulLoader = new SoulLoader(config.soul.path, config.soul.dir);
  await soulLoader.initialize();
  console.log(`[boot] Soul: ${soulLoader.getSoul().identity.name}`);

  // CONTEXT.md
  let contextContent: string | null = null;
  const contextPath = resolve(config.workspace, "CONTEXT.md");

  async function loadContext(): Promise<void> {
    try {
      contextContent = await readFile(contextPath, "utf-8");
    } catch {
      contextContent = null;
    }
  }

  await loadContext();
  if (contextContent !== null) console.log(`[boot] CONTEXT.md loaded (${(contextContent as string).length} chars)`);

  let contextWatcher: FSWatcher | null = null;
  let contextDirWatcher: FSWatcher | null = null;
  let contextReloadTimeout: ReturnType<typeof setTimeout> | null = null;

  function scheduleContextReload(): void {
    if (contextReloadTimeout) clearTimeout(contextReloadTimeout);
    contextReloadTimeout = setTimeout(() => {
      loadContext().then(() => {
        if (contextContent) console.log("[context] CONTEXT.md reloaded");
      });
    }, 300);
  }

  try { contextWatcher = watch(contextPath, () => scheduleContextReload()); } catch {}
  try { contextDirWatcher = watch(config.workspace, { recursive: false }, (_, filename) => {
    if (filename === "CONTEXT.md") scheduleContextReload();
  }); } catch {}

  const skillLoader = new SkillLoader(config.workspace);
  const skills = await skillLoader.listSkills();
  console.log(`[boot] Skills: ${skills.length} loaded`);

  // Cloud memory filter
  memoryProvider.setupCloudFilter?.().catch((err: Error) =>
    console.warn("[boot] Cloud filter setup skipped:", err.message),
  );

  // Ollama detection
  if (config.ollama?.enabled) {
    try {
      const res = await fetch(`${config.ollama.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        initOllama(config.ollama.baseUrl);
        console.log(`[boot] Ollama: enabled (${config.ollama.model}) at ${config.ollama.baseUrl}`);
      } else {
        console.log("[boot] Ollama: configured but not reachable — using OpenRouter only");
      }
    } catch {
      console.log("[boot] Ollama: not reachable — using OpenRouter only");
    }
  }

  return {
    memoryProvider,
    soulLoader,
    skillLoader,
    contextContent,
    contextWatcher,
    contextDirWatcher,
    contextReloadTimeout,
    getContextContent: () => contextContent,
  };
}
