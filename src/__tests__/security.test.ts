import { describe, test, expect } from "bun:test";
import { BLOCKED_PATTERNS, sanitizeForPrompt, redactSensitiveArgs } from "../security.js";

describe("BLOCKED_PATTERNS", () => {
  test("blocks .env files", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test(".env"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test(".env.local"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test(".env.production"))).toBe(true);
  });

  test("blocks credentials files", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test("credentials.json"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test("path/to/credentials"))).toBe(true);
  });

  test("blocks secrets files", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test("secrets.yml"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test("secret.json"))).toBe(true);
  });

  test("blocks node_modules", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test("node_modules/pkg"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test("path/node_modules/"))).toBe(true);
  });

  test("blocks .git/config", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test("repo/.git/config"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test("project\\.git\\config"))).toBe(true);
  });

  test("blocks SSH keys", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test(".ssh/id_rsa"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test(".ssh/id_ed25519"))).toBe(true);
  });

  test("blocks PEM and KEY files", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test("server.pem"))).toBe(true);
    expect(BLOCKED_PATTERNS.some((p) => p.test("private.key"))).toBe(true);
  });

  test("blocks AWS directory", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test(".aws/credentials"))).toBe(true);
  });

  test("allows normal files", () => {
    expect(BLOCKED_PATTERNS.some((p) => p.test("readme.md"))).toBe(false);
    expect(BLOCKED_PATTERNS.some((p) => p.test("src/index.ts"))).toBe(false);
    expect(BLOCKED_PATTERNS.some((p) => p.test("package.json"))).toBe(false);
  });
});

describe("sanitizeForPrompt", () => {
  test("escapes angle brackets", () => {
    expect(sanitizeForPrompt("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes both < and >", () => {
    expect(sanitizeForPrompt("<tag>value</tag>")).toBe("&lt;tag&gt;value&lt;/tag&gt;");
  });

  test("leaves normal text unchanged", () => {
    expect(sanitizeForPrompt("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(sanitizeForPrompt("")).toBe("");
  });

  test("handles text with only >", () => {
    expect(sanitizeForPrompt(">alert")).toBe("&gt;alert");
  });

  test("escapes system prompt injection", () => {
    expect(sanitizeForPrompt("<system>override</system>")).toBe("&lt;system&gt;override&lt;/system&gt;");
  });
});

describe("redactSensitiveArgs", () => {
  test("redacts apiKey", () => {
    const result = redactSensitiveArgs({ apiKey: "sk-12345" });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-12345");
  });

  test("redacts token", () => {
    const result = redactSensitiveArgs({ token: "abc123" });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123");
  });

  test("redacts password", () => {
    const result = redactSensitiveArgs({ password: "secret" });
    expect(result).toContain("[REDACTED]");
  });

  test("redacts api_key (snake_case)", () => {
    const result = redactSensitiveArgs({ api_key: "key123" });
    expect(result).toContain("[REDACTED]");
  });

  test("passes through normal values", () => {
    const result = redactSensitiveArgs({ name: "Alice", count: 5 });
    expect(result).toContain("Alice");
    expect(result).toContain("5");
  });

  test("truncates long string values", () => {
    const longValue = "a".repeat(300);
    const result = redactSensitiveArgs({ data: longValue });
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(600);
  });

  test("respects maxLen", () => {
    const result = redactSensitiveArgs({ a: "b", c: "d" }, 20);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test("handles empty object", () => {
    expect(redactSensitiveArgs({})).toBe("{}");
  });
});
