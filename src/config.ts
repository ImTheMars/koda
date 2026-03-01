/**
 * Koda configuration — Zod-validated with env override for secrets.
 *
 * 2-tier LLM: fast (Gemini Flash) / deep (Claude Sonnet).
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { homedir } from "os";
import { statSync } from "fs";
import { loadEnvFromFiles } from "./env.js";
import { validateTimezone } from "./time.js";
import { logWarn } from "./log.js";

let resolvedConfigPath: string | null = null;

function withEmptyDefault<T extends z.ZodTypeAny>(schema: T) {
  return schema.optional().transform((val) => schema.parse(val ?? {}));
}

const ConfigSchema = z.object({
  mode: z.enum(["private", "cli-only"]).default("private"),
  owner: withEmptyDefault(z.object({ id: z.string().default("owner") })),
  openrouter: z.object({
    apiKey: z.string().min(1, "OpenRouter API key is required"),
    fastModel: z.string().default("google/gemini-3-flash-preview"),
    deepModel: z.string().default("anthropic/claude-sonnet-4.6"),
    imageModel: z.string().default("google/gemini-3-pro-image-preview"),
    failovers: z.record(z.string(), z.array(z.string())).optional(),
    pricing: z.record(z.string(), z.object({ input: z.number(), output: z.number() })).optional(),
  }),
  supermemory: withEmptyDefault(z.object({
    apiKey: z.string().optional(),
  })),
  exa: withEmptyDefault(z.object({ apiKey: z.string().optional(), numResults: z.number().min(1).max(20).default(5) })),
  telegram: withEmptyDefault(z.object({
    token: z.string().optional(),
    allowFrom: z.array(z.string()).default([]),
    adminIds: z.array(z.string()).default([]),
    useWebhook: z.boolean().default(false),
    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional(),
    rateLimitMax: z.number().min(1).default(10),
    rateLimitWindowMs: z.number().min(1000).default(60_000),
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
    circuitBreakerThreshold: z.number().min(1).default(3),
    circuitBreakerResetMs: z.number().min(10_000).default(120_000),
    historyTokenBudget: z.number().min(500).default(6000),
    charsPerToken: z.number().min(1).default(4),
    escalationStep: z.number().min(1).default(5),
    toolArgLogMaxChars: z.number().min(50).default(500),
  })),
  timeouts: withEmptyDefault(z.object({
    llm: z.number().min(5000).default(120_000),
    memory: z.number().min(1000).default(10_000),
    search: z.number().min(1000).default(30_000),
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
  })),
  features: withEmptyDefault(z.object({
    scheduler: z.boolean().default(true),
    debug: z.boolean().default(false),
    autoBackup: z.boolean().default(true),
    messageRetentionDays: z.number().min(1).default(90),
    skillDiscoveryCron: z.string().default("sun 09:00"),
    dailyBriefingCron: z.string().default("08:00"),
    backupIntervalHours: z.number().min(1).default(24),
    gcIntervalHours: z.number().min(1).default(1),
  })),
  subagent: withEmptyDefault(z.object({
    timeoutMs: z.number().min(10_000).default(90_000),
    maxSteps: z.number().min(1).max(20).default(10),
  })),
  ollama: withEmptyDefault(z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default("http://localhost:11434"),
    model: z.string().default("llama3.2"),
    fastOnly: z.boolean().default(true),
  })),
  github: withEmptyDefault(z.object({
    token: z.string().optional(),
  })),
  composio: withEmptyDefault(z.object({
    apiKey: z.string().optional(),
  })),
  sandbox: withEmptyDefault(z.object({
    memory: z.string().default("512m"),
    cpus: z.string().default("0.5"),
    timeoutMs: z.number().min(1000).max(120_000).default(30_000),
    image: z.string().default("alpine:latest"),
    maxStdout: z.number().default(50_000),
    maxStderr: z.number().default(10_000),
  })),
  workspace: z.string().default("~/.koda"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Tier = "fast" | "deep";

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
        logWarn("security", `${envPath} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${envPath}`);
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
    ["KODA_EXA_API_KEY", ["exa", "apiKey"]],
    ["KODA_TELEGRAM_TOKEN", ["telegram", "token"]],
    ["KODA_GITHUB_TOKEN", ["github", "token"]],
    ["KODA_COMPOSIO_API_KEY", ["composio", "apiKey"]],
    ["KODA_TELEGRAM_WEBHOOK_URL", ["telegram", "webhookUrl"]],
    ["KODA_TELEGRAM_WEBHOOK_SECRET", ["telegram", "webhookSecret"]],
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

  // Comma-separated list env vars for Telegram access control
  if (env["KODA_TELEGRAM_ALLOW_FROM"]) {
    const tg = (raw.telegram ?? {}) as Record<string, unknown>;
    tg.allowFrom = env["KODA_TELEGRAM_ALLOW_FROM"].split(",").map((s) => s.trim()).filter(Boolean);
    raw.telegram = tg;
  }
  if (env["KODA_TELEGRAM_ADMIN_IDS"]) {
    const tg = (raw.telegram ?? {}) as Record<string, unknown>;
    tg.adminIds = env["KODA_TELEGRAM_ADMIN_IDS"].split(",").map((s) => s.trim()).filter(Boolean);
    raw.telegram = tg;
  }

  // Auto-enable webhook mode when webhook URL is set via env
  if (env["KODA_TELEGRAM_WEBHOOK_URL"]) {
    const tg = (raw.telegram ?? {}) as Record<string, unknown>;
    tg.useWebhook = true;
    raw.telegram = tg;
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
        resolvedConfigPath = p;
        break;
      } catch {
        logWarn("config", `Malformed config file at ${p}, skipping`);
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

export async function persistConfig(config: Config): Promise<void> {
  const configPath = resolvedConfigPath ?? resolve(homedir(), ".koda", "config.json");
  const serializable: Record<string, unknown> = {};

  // Serialize back to the JSON-compatible shape — omit secrets (they live in .env)
  serializable.mode = config.mode;
  serializable.owner = { id: config.owner.id };
  serializable.openrouter = {
    fastModel: config.openrouter.fastModel,
    deepModel: config.openrouter.deepModel,
    imageModel: config.openrouter.imageModel,
  };
  serializable.telegram = {
    allowFrom: config.telegram.allowFrom,
    adminIds: config.telegram.adminIds,
    useWebhook: config.telegram.useWebhook,
    ...(config.telegram.webhookUrl ? { webhookUrl: config.telegram.webhookUrl } : {}),
    ...(config.telegram.webhookSecret ? { webhookSecret: config.telegram.webhookSecret } : {}),
  };
  serializable.cli = config.cli;
  serializable.agent = {
    maxSteps: config.agent.maxSteps,
    maxTokens: config.agent.maxTokens,
    temperature: config.agent.temperature,
    circuitBreakerThreshold: config.agent.circuitBreakerThreshold,
    circuitBreakerResetMs: config.agent.circuitBreakerResetMs,
    historyTokenBudget: config.agent.historyTokenBudget,
    charsPerToken: config.agent.charsPerToken,
    escalationStep: config.agent.escalationStep,
    toolArgLogMaxChars: config.agent.toolArgLogMaxChars,
  };
  serializable.exa = { numResults: config.exa.numResults };
  serializable.timeouts = config.timeouts;
  serializable.scheduler = { timezone: config.scheduler.timezone };
  serializable.proactive = { tickIntervalMs: config.proactive.tickIntervalMs };
  serializable.features = {
    scheduler: config.features.scheduler,
    debug: config.features.debug,
    autoBackup: config.features.autoBackup,
    messageRetentionDays: config.features.messageRetentionDays,
    skillDiscoveryCron: config.features.skillDiscoveryCron,
    dailyBriefingCron: config.features.dailyBriefingCron,
    backupIntervalHours: config.features.backupIntervalHours,
    gcIntervalHours: config.features.gcIntervalHours,
  };
  serializable.subagent = {
    timeoutMs: config.subagent.timeoutMs,
    maxSteps: config.subagent.maxSteps,
  };
  serializable.sandbox = config.sandbox;
  serializable.workspace = config.workspace;

  await Bun.write(configPath, JSON.stringify(serializable, null, 2) + "\n");
}
