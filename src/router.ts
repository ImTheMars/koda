/**
 * Router — 3-tier rule-based classification + intent detection.
 *
 * Tiers: fast (< 20 words, no tool hints), deep (reasoning keywords, /think /deep prefix), standard (everything else).
 */

import type { Tier, Config } from "./config.js";

// --- Keyword lists ---

const DEEP_WORDS = [
  "prove", "theorem", "derive", "step by step", "chain of thought",
  "formally", "mathematical", "proof", "analyze", "compare and contrast",
  "evaluate", "critically", "explain why", "reasoning", "deduce", "infer",
];

const TOOL_HINTS = [
  "search", "look up", "find out", "remind", "schedule", "remember",
  "browse", "open url", "run ", "execute", "download",
];

const CODE_WORDS = [
  "function", "class", "import", "export", "const ", "async", "debug",
  "typescript", "javascript", "python", "sql", "```", "schema",
];

export type RequestIntent = "chat" | "task" | "research" | "code" | "schedule" | "memory";

const INTENT_KEYWORDS: Record<RequestIntent, string[]> = {
  chat: ["hello", "hey", "how are you", "what's up", "yo", "gm", "gn"],
  task: ["do this", "handle this", "work on", "fix", "build", "deploy", "create", "implement", "help me", "make", "add", "update"],
  research: ["research", "find", "look up", "compare", "summarize", "search for", "news about", "latest"],
  code: ["code", "debug", "function", "script", "typescript", "python", "bash", "refactor", "query", "sql"],
  schedule: ["remind", "schedule", "tomorrow", "every day", "recurring", "calendar"],
  memory: ["remember", "forget", "what do you know", "store this", "save this"],
};

// --- Classification ---

function countMatches(text: string, keywords: string[]): number {
  let n = 0;
  for (const kw of keywords) if (text.includes(kw)) n++;
  return n;
}

export function classifyTier(text: string): Tier {
  const lower = text.toLowerCase().trim();

  // Prefix overrides
  if (lower.startsWith("/think") || lower.startsWith("/deep")) return "deep";

  // Deep: 2+ reasoning markers
  if (countMatches(lower, DEEP_WORDS) >= 2) return "deep";

  // Fast: short, no tool hints, no complexity signals
  const wordCount = lower.split(/\s+/).length;
  if (
    wordCount < 20 &&
    countMatches(lower, TOOL_HINTS) === 0 &&
    countMatches(lower, CODE_WORDS) === 0 &&
    countMatches(lower, DEEP_WORDS) === 0
  ) {
    return "fast";
  }

  return "standard";
}

export function classifyIntent(text: string): RequestIntent {
  const lower = text.toLowerCase();
  let best: RequestIntent = "chat";
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS) as Array<[RequestIntent, string[]]>) {
    const score = countMatches(lower, keywords);
    if (score > bestScore) { best = intent; bestScore = score; }
  }

  return best;
}

// --- Model resolution ---

export function getModelId(tier: Tier, config: Config): string {
  switch (tier) {
    case "fast": return config.openrouter.fastModel;
    case "standard": return config.openrouter.standardModel;
    case "deep": return config.openrouter.deepModel;
  }
}

/** Failover chains per tier — OpenRouter tries these in order */
export const FAILOVER: Record<Tier, string[]> = {
  fast: ["google/gemini-2.5-flash-lite:nitro", "google/gemini-2.5-flash-lite"],
  standard: ["google/gemini-3-flash-preview:nitro", "google/gemini-3-flash-preview"],
  deep: ["anthropic/claude-opus-4.6:nitro", "anthropic/claude-opus-4.6"],
};

// --- Pricing (per 1M tokens) ---

export const PRICING: Record<string, { input: number; output: number }> = {
  "google/gemini-2.5-flash-lite:nitro": { input: 0.075, output: 0.3 },
  "google/gemini-2.5-flash-lite": { input: 0.075, output: 0.3 },
  "google/gemini-3-flash-preview:nitro": { input: 0.5, output: 3 },
  "google/gemini-3-flash-preview": { input: 0.5, output: 3 },
  "moonshotai/kimi-k2.5:nitro": { input: 0.45, output: 2.25 },
  "moonshotai/kimi-k2.5": { input: 0.45, output: 2.25 },
  "anthropic/claude-opus-4.6:nitro": { input: 5, output: 25 },
  "anthropic/claude-opus-4.6": { input: 5, output: 25 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 0, output: 0 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// --- Ack decision ---

export function shouldAck(input: { content: string; tier: Tier; intent: RequestIntent; source?: string }): boolean {
  if (!input.content.trim()) return false;
  if (input.source === "scheduler" || input.source === "heartbeat") return false;
  if (/^(ok|okay|thanks|thank you|cool|nice|great|bet|got it|yep|yup|done)\b/i.test(input.content.trim())) return false;

  let score = 0;
  if (input.tier === "deep") score += 3;
  else if (input.tier === "standard") score += 1;
  if (input.intent === "task" || input.intent === "research" || input.intent === "code") score += 2;
  if (input.content.length >= 180) score += 1;

  return score >= 3;
}
