/**
 * Koda configuration — Zod-validated with env override for secrets.
 *
 * 3-tier LLM: fast/standard/deep. Voice via Gemini STT (OpenRouter) + Cartesia TTS.
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { homedir } from "os";
import { statSync } from "fs";
import { loadEnvFromFiles } from "./env.js";
import { validateTimezone } from "./time.js";

function withEmptyDefault<T extends z.ZodTypeAny>(schema: T) {
  return schema.optional().transform((val) => schema.parse(val ?? {}));
}

const ConfigSchema = z.object({
  mode: z.enum(["private", "cli-only"]).default("private"),
  owner: withEmptyDefault(z.object({ id: z.string().default("owner") })),
  openrouter: z.object({
    apiKey: z.string().min(1, "OpenRouter API key is required"),
    fastModel: z.string().default("google/gemini-2.5-flash-lite:nitro"),
    standardModel: z.string().default("google/gemini-3-flash-preview:nitro"),
    deepModel: z.string().default("anthropic/claude-opus-4.6:nitro"),
  }),
  supermemory: z.object({
    apiKey: z.string().min(1, "Supermemory API key is required"),
  }),
  tavily: withEmptyDefault(z.object({ apiKey: z.string().optional() })),
  voice: withEmptyDefault(z.object({
    cartesiaApiKey: z.string().optional(),
    cartesiaVoiceId: z.string().default("694f9389-aac1-45b6-b726-9d9369183238"),
  })),
  telegram: withEmptyDefault(z.object({
    token: z.string().optional(),
    allowFrom: z.array(z.string()).default([]),
    adminIds: z.array(z.string()).default([]),
  })),
  cli: withEmptyDefault(z.object({
    userId: z.string().default("owner"),
    chatId: z.string().default("owner"),
    prompt: z.string().default("you"),
  })),
  agent: withEmptyDefault(z.object({
    maxSteps: z.number().min(1).max(100).default(30),
    maxTokens: z.number().min(1).max(32768).default(8192),
    temperature: z.number().min(0).max(2).default(0.7),
  })),
  timeouts: withEmptyDefault(z.object({
    llm: z.number().min(5000).default(120_000),
    memory: z.number().min(1000).default(10_000),
    search: z.number().min(1000).default(30_000),
    voice: z.number().min(5000).default(60_000),
  })),
  mcp: withEmptyDefault(z.object({
    servers: z.array(z.discriminatedUnion("transport", [
      z.object({
        name: z.string(),
        transport: z.literal("sse"),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).optional(),
        autoRestart: z.boolean().default(true),
      }),
      z.object({
        name: z.string(),
        transport: z.literal("http"),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).optional(),
        autoRestart: z.boolean().default(true),
      }),
      z.object({
        name: z.string(),
        transport: z.literal("stdio"),
        command: z.string(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).optional(),
        autoRestart: z.boolean().default(true),
      }),
    ])).default([]),
  })),
  soul: withEmptyDefault(z.object({
    path: z.string().default("./config/soul.md"),
    dir: z.string().default("./config/soul.d"),
  })),
  scheduler: withEmptyDefault(z.object({
    timezone: z.string().refine(validateTimezone, "Invalid timezone").default("America/Los_Angeles"),
  })),
  proactive: withEmptyDefault(z.object({
    tickIntervalMs: z.number().min(10_000).default(30_000),
    activeHoursStart: z.number().min(0).max(23).default(8),
    activeHoursEnd: z.number().min(0).max(23).default(23),
  })),
  features: withEmptyDefault(z.object({
    scheduler: z.boolean().default(true),
    debug: z.boolean().default(false),
  })),
  workspace: z.string().default("~/.koda"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Tier = "fast" | "standard" | "deep";

function checkEnvPermissions(): void {
  const envPaths = [
    resolve(process.cwd(), ".env"),
    resolve(homedir(), ".koda", ".env"),
  ];
  for (const envPath of envPaths) {
    try {
      const stats = statSync(envPath);
      const mode = stats.mode & 0o777;
      if (mode & 0o044) {
        console.warn(`\x1b[33m[security] WARNING: ${envPath} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${envPath}\x1b[0m`);
      }
    } catch {}
  }
}

function resolvePath(p: string, base: string): string {
  if (p.startsWith("~")) return resolve(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(base, p);
}

function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const env = {
    ...(typeof Bun !== "undefined" ? Bun.env : {}),
    ...process.env,
  } as Record<string, string | undefined>;

  const mappings: [string, string[]][] = [
    ["KODA_OPENROUTER_API_KEY", ["openrouter", "apiKey"]],
    ["KODA_SUPERMEMORY_API_KEY", ["supermemory", "apiKey"]],
    ["KODA_TAVILY_API_KEY", ["tavily", "apiKey"]],
    ["KODA_TELEGRAM_TOKEN", ["telegram", "token"]],
    ["KODA_CARTESIA_API_KEY", ["voice", "cartesiaApiKey"]],
    ["KODA_CARTESIA_VOICE_ID", ["voice", "cartesiaVoiceId"]],
  ];

  function setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
    let target = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!;
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      target = target[key] as Record<string, unknown>;
    }
    target[path[path.length - 1]!] = value;
  }

  for (const [envKey, path] of mappings) {
    const value = env[envKey];
    if (value) setNested(raw, path, value);
  }

  const modeEnv = env["KODA_MODE"];
  if (modeEnv) raw.mode = modeEnv;

  return raw;
}

export async function loadConfig(configPath?: string): Promise<Config> {
  // Load ~/.koda/.env first, then project .env.
  // Precedence: shell/runtime vars > project .env > workspace .env.
  const protectedEnvKeys = new Set(Object.keys(process.env));
  loadEnvFromFiles([resolve(homedir(), ".koda", ".env")], false, protectedEnvKeys);
  loadEnvFromFiles([resolve(process.cwd(), ".env")], true, protectedEnvKeys);

  checkEnvPermissions();

  const searchPaths = [
    configPath,
    resolve(homedir(), ".koda", "config.json"),
    resolve(process.cwd(), "config", "config.json"),
    resolve(process.cwd(), "config.json"),
  ].filter(Boolean) as string[];

  let raw: Record<string, unknown> = {};

  for (const p of searchPaths) {
    const file = Bun.file(p);
    if (await file.exists()) {
      try {
        raw = JSON.parse(await file.text());
        break;
      } catch {
        console.warn(`\x1b[33m[config] WARNING: Malformed config file at ${p}, skipping\x1b[0m`);
      }
    }
  }

  raw = applyEnvOverrides(raw);

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const config = result.data;

  if (config.mode !== "cli-only" && !config.telegram.token) {
    throw new Error("Invalid configuration:\n  telegram.token: Required unless mode is 'cli-only'");
  }

  const projectRoot = process.cwd();
  config.workspace = resolvePath(config.workspace, projectRoot);
  config.soul.path = resolvePath(config.soul.path, projectRoot);
  config.soul.dir = resolvePath(config.soul.dir, projectRoot);

  return config;
}
