import { describe, test, expect, afterAll } from "bun:test";

const savedEnv = { ...process.env };

afterAll(() => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("loadConfig", () => {
  test("exports loadConfig and persistConfig", async () => {
    const mod = await import("../config.js");
    expect(typeof mod.loadConfig).toBe("function");
    expect(typeof mod.persistConfig).toBe("function");
  });

  test("cli-only mode works with minimal config", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key-for-validation";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.mode).toBe("cli-only");
    expect(config.openrouter.apiKey).toBe("test-key-for-validation");
  });

  test("agent defaults have reasonable values", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key-for-validation";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.agent.maxSteps).toBeGreaterThan(0);
    expect(config.agent.temperature).toBeGreaterThanOrEqual(0);
    expect(config.agent.temperature).toBeLessThanOrEqual(2);
    expect(config.agent.circuitBreakerThreshold).toBeGreaterThan(0);
    expect(config.agent.circuitBreakerResetMs).toBeGreaterThan(0);
    expect(config.agent.historyTokenBudget).toBeGreaterThan(0);
    expect(config.agent.charsPerToken).toBeGreaterThan(0);
    expect(config.agent.escalationStep).toBeGreaterThan(0);
    expect(config.agent.toolArgLogMaxChars).toBeGreaterThan(0);
  });

  test("sandbox defaults are set", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key-for-validation";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.sandbox.memory).toBe("512m");
    expect(config.sandbox.cpus).toBe("0.5");
    expect(config.sandbox.timeoutMs).toBeGreaterThan(0);
    expect(config.sandbox.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(config.sandbox.image).toBe("alpine:latest");
    expect(config.sandbox.maxStdout).toBeGreaterThan(0);
    expect(config.sandbox.maxStderr).toBeGreaterThan(0);
  });

  test("features defaults are set", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key-for-validation";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.features.messageRetentionDays).toBeGreaterThan(0);
    expect(config.features.backupIntervalHours).toBeGreaterThan(0);
    expect(config.features.gcIntervalHours).toBeGreaterThan(0);
    expect(typeof config.features.skillDiscoveryCron).toBe("string");
    expect(typeof config.features.dailyBriefingCron).toBe("string");
  });

  test("telegram rate limit defaults are set", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key-for-validation";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.telegram.rateLimitMax).toBeGreaterThan(0);
    expect(config.telegram.rateLimitWindowMs).toBeGreaterThan(0);
  });

  test("env overrides set openrouter keys", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "my-test-key";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.openrouter.apiKey).toBe("my-test-key");
  });

  test("env overrides set telegram webhook", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key";
    process.env.KODA_TELEGRAM_WEBHOOK_URL = "https://example.com/webhook";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.telegram.useWebhook).toBe(true);
    expect(config.telegram.webhookUrl).toBe("https://example.com/webhook");
    delete process.env.KODA_TELEGRAM_WEBHOOK_URL;
  });

  test("env overrides split comma-separated allow_from", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key";
    process.env.KODA_TELEGRAM_ALLOW_FROM = "user1,user2,user3";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.telegram.allowFrom).toEqual(["user1", "user2", "user3"]);
    delete process.env.KODA_TELEGRAM_ALLOW_FROM;
  });

  test("env overrides split comma-separated admin_ids", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key";
    process.env.KODA_TELEGRAM_ADMIN_IDS = "admin1,admin2";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.telegram.adminIds).toEqual(["admin1", "admin2"]);
    delete process.env.KODA_TELEGRAM_ADMIN_IDS;
  });

  test("workspace defaults to ~/.koda", async () => {
    process.env.KODA_MODE = "cli-only";
    process.env.KODA_OPENROUTER_API_KEY = "test-key";
    const mod = await import("../config.js");
    const config = await mod.loadConfig();
    expect(config.workspace).toContain(".koda");
  });
});
