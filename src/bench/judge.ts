/**
 * Hybrid grading system — programmatic checks (free) + LLM judge (~$0.001/test).
 *
 * 1. Programmatic checks: required/forbidden tools, expected tier, mustContain, custom assert
 * 2. LLM judge: scores correctness, toolUsage, responseQuality, tone (0-10 each)
 * 3. Hard caps: programmatic failures cap relevant dimension scores
 *
 * Overall = 40% correctness + 25% toolUsage + 20% responseQuality + 15% tone
 */

import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { TestCase, TurnResult, GradeScores, GradingCriteria } from "./types.js";

export interface JudgeOptions {
  apiKey: string;
  model: string;
}

let provider: ReturnType<typeof createOpenRouter> | null = null;
let judgeCost = 0;

export function getJudgeCost(): number {
  return judgeCost;
}

export function resetJudgeCost(): void {
  judgeCost = 0;
}

// ── Programmatic checks ──────────────────────────────────────

interface ProgrammaticResult {
  passed: boolean;
  failures: string[];
  caps: { correctness?: number; toolUsage?: number; responseQuality?: number; tone?: number };
}

function runProgrammaticChecks(test: TestCase, turns: TurnResult[]): ProgrammaticResult {
  const criteria = test.grading;
  const failures: string[] = [];
  const caps: ProgrammaticResult["caps"] = {};

  const allToolsUsed = turns.flatMap((t) => t.toolsUsed);
  const allOutputs = turns.map((t) => t.output.toLowerCase()).join(" ");

  // Required tools check
  if (criteria.requiredTools) {
    for (const tool of criteria.requiredTools) {
      if (!allToolsUsed.includes(tool)) {
        failures.push(`Required tool '${tool}' was not used`);
        caps.toolUsage = Math.min(caps.toolUsage ?? 10, 3);
      }
    }
  }

  // Forbidden tools check
  if (criteria.forbiddenTools) {
    for (const tool of criteria.forbiddenTools) {
      if (allToolsUsed.includes(tool)) {
        failures.push(`Forbidden tool '${tool}' was used`);
        caps.toolUsage = Math.min(caps.toolUsage ?? 10, 4);
      }
    }
  }

  // Expected tier check
  if (criteria.expectedTier) {
    for (const turn of turns) {
      if (turn.tier !== criteria.expectedTier) {
        failures.push(`Expected tier '${criteria.expectedTier}' but got '${turn.tier}'`);
        caps.correctness = Math.min(caps.correctness ?? 10, 5);
        break;
      }
    }
  }

  // mustContain check
  if (criteria.mustContain) {
    for (const substr of criteria.mustContain) {
      if (!allOutputs.includes(substr.toLowerCase())) {
        failures.push(`Response missing required string: '${substr}'`);
        caps.correctness = Math.min(caps.correctness ?? 10, 4);
      }
    }
  }

  // mustNotContain check
  if (criteria.mustNotContain) {
    for (const substr of criteria.mustNotContain) {
      if (allOutputs.includes(substr.toLowerCase())) {
        failures.push(`Response contains forbidden string: '${substr}'`);
        caps.correctness = Math.min(caps.correctness ?? 10, 3);
      }
    }
  }

  // Custom assert
  if (criteria.assert) {
    const assertResult = criteria.assert(turns);
    if (assertResult) {
      failures.push(`Custom assert failed: ${assertResult}`);
      caps.correctness = Math.min(caps.correctness ?? 10, 4);
    }
  }

  // Error check — any turn errored
  for (const turn of turns) {
    if (turn.error) {
      failures.push(`Turn errored: ${turn.error}`);
      caps.correctness = Math.min(caps.correctness ?? 10, 2);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    caps,
  };
}

// ── LLM Judge ────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are a strict but fair benchmark judge for an AI assistant called Koda.

Score each dimension 0-10:
- **correctness**: Did the assistant correctly handle the request? Accurate info, right actions?
- **toolUsage**: Did it use the right tools in the right order? No unnecessary tool calls?
- **responseQuality**: Is the response clear, helpful, and complete?
- **tone**: Does it match Koda's casual, lowercase style? Not too formal?

Respond ONLY with valid JSON (no markdown, no code blocks):
{"correctness": N, "toolUsage": N, "responseQuality": N, "tone": N, "reasoning": "brief explanation"}`;

async function llmJudge(
  test: TestCase,
  turns: TurnResult[],
  options: JudgeOptions,
): Promise<{ correctness: number; toolUsage: number; responseQuality: number; tone: number; reasoning: string }> {
  if (!provider) {
    provider = createOpenRouter({ apiKey: options.apiKey });
  }

  const turnsFormatted = turns
    .map((t, i) => `Turn ${i + 1}:\n  User: ${t.input.slice(0, 500)}\n  Assistant: ${t.output.slice(0, 800)}\n  Tools: [${t.toolsUsed.join(", ")}]\n  Tier: ${t.tier}`)
    .join("\n\n");

  const prompt = `Test: ${test.name}
Description: ${test.description}
Category: ${test.category}

Grading criteria: ${test.grading.judgePrompt ?? "Grade based on test description."}

${turnsFormatted}

Score this interaction:`;

  try {
    const result = await generateText({
      model: provider(options.model),
      system: JUDGE_SYSTEM,
      prompt,
      maxOutputTokens: 300,
      temperature: 0.2,
    });

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    judgeCost += (inputTokens * 0.5 + outputTokens * 3) / 1_000_000;

    // Parse JSON response — handle potential markdown wrapping
    let jsonStr = result.text.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    return {
      correctness: clamp(parsed.correctness ?? 5, 0, 10),
      toolUsage: clamp(parsed.toolUsage ?? 5, 0, 10),
      responseQuality: clamp(parsed.responseQuality ?? 5, 0, 10),
      tone: clamp(parsed.tone ?? 5, 0, 10),
      reasoning: parsed.reasoning ?? "No reasoning provided",
    };
  } catch (err) {
    console.error(`[judge] LLM judge failed for ${test.id}:`, (err as Error).message);
    return { correctness: 5, toolUsage: 5, responseQuality: 5, tone: 5, reasoning: "Judge failed — default scores" };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ── Combined grading ─────────────────────────────────────────

export async function gradeTest(
  test: TestCase,
  turns: TurnResult[],
  options: JudgeOptions,
): Promise<GradeScores> {
  // Step 1: programmatic checks (free)
  const programmatic = runProgrammaticChecks(test, turns);

  // Step 2: LLM judge
  const llmScores = await llmJudge(test, turns, options);

  // Step 3: apply hard caps from programmatic failures
  const correctness = clamp(llmScores.correctness, 0, programmatic.caps.correctness ?? 10);
  const toolUsage = clamp(llmScores.toolUsage, 0, programmatic.caps.toolUsage ?? 10);
  const responseQuality = clamp(llmScores.responseQuality, 0, programmatic.caps.responseQuality ?? 10);
  const tone = clamp(llmScores.tone, 0, programmatic.caps.tone ?? 10);

  // Weighted overall
  const overall = correctness * 0.4 + toolUsage * 0.25 + responseQuality * 0.2 + tone * 0.15;

  // Combine reasoning
  const reasons: string[] = [];
  if (programmatic.failures.length > 0) {
    reasons.push("Programmatic: " + programmatic.failures.join("; "));
  }
  reasons.push("Judge: " + llmScores.reasoning);

  return {
    correctness,
    toolUsage,
    responseQuality,
    tone,
    overall,
    judgeReasoning: reasons.join(" | "),
  };
}
