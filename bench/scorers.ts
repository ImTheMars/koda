/**
 * AssistantBench scorers — deterministic + LLM-judged evaluation.
 *
 * Adapted for v1 rebuild: 3-tier classify, simplified ack, removed outcome/budget.
 */

import { classifyTier, classifyIntent, shouldAck } from "../src/router.js";
import { parseCronNext, validateTimezone } from "../src/time.js";
import { judge } from "./judge.js";
import type {
  BenchmarkResult,
  DeterministicCases,
  LLMJudgeCases,
} from "./types.js";

function time<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

export function scoreDeterministic(cases: DeterministicCases): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];

  // --- Classify ---
  for (const c of cases.classify) {
    const { result: tier, ms } = time(() => classifyTier(c.input));
    const { result: intent } = time(() => classifyIntent(c.input));
    const tierPass = tier === c.expectedTier;
    const intentPass = intent === c.expectedIntent;

    results.push({
      suite: "deterministic",
      category: "classify",
      name: c.name,
      passed: tierPass && intentPass,
      score: (tierPass ? 0.5 : 0) + (intentPass ? 0.5 : 0),
      maxScore: 1,
      expected: `tier=${c.expectedTier}, intent=${c.expectedIntent}`,
      actual: `tier=${tier}, intent=${intent}`,
      latencyMs: ms,
    });
  }

  // --- Ack ---
  for (const c of cases.ack) {
    const { result: ack, ms } = time(() => shouldAck(c.input as any));
    const passed = ack === c.expected;

    results.push({
      suite: "deterministic",
      category: "ack",
      name: c.name,
      passed,
      score: passed ? 1 : 0,
      maxScore: 1,
      expected: String(c.expected),
      actual: String(ack),
      latencyMs: ms,
    });
  }

  // --- Time (cron parsing) ---
  for (const c of cases.time) {
    const from = new Date(c.fromISO);
    const { result: nextRun, ms } = time(() => parseCronNext(c.schedule, from, c.timezone));
    const expectedDate = new Date(c.expectedDateISO);
    const diffMs = Math.abs(nextRun.getTime() - expectedDate.getTime());
    const passed = diffMs <= c.toleranceMs;

    results.push({
      suite: "deterministic",
      category: "time",
      name: c.name,
      passed,
      score: passed ? 1 : 0,
      maxScore: 1,
      expected: expectedDate.toISOString(),
      actual: `${nextRun.toISOString()} (diff=${diffMs}ms)`,
      latencyMs: ms,
    });
  }

  // --- Timezone validation ---
  for (const c of cases.timezoneValidation) {
    const { result: valid, ms } = time(() => validateTimezone(c.timezone));
    const passed = valid === c.expectedValid;

    results.push({
      suite: "deterministic",
      category: "timezone",
      name: c.name,
      passed,
      score: passed ? 1 : 0,
      maxScore: 1,
      expected: c.expectedValid ? "valid" : "invalid",
      actual: valid ? "valid" : "invalid",
      latencyMs: ms,
    });
  }

  return results;
}

export async function scoreLLMJudge(cases: LLMJudgeCases): Promise<{ results: BenchmarkResult[]; totalCost: number }> {
  const results: BenchmarkResult[] = [];
  let totalCost = 0;

  for (const c of cases.cases) {
    const { result: judgeResult, ms } = await timeAsync(() =>
      judge({
        userMessage: c.userMessage,
        assistantResponse: c.assistantResponse,
        rubrics: c.rubrics,
        context: c.context,
        passThreshold: c.passThreshold,
      }),
    );

    totalCost += judgeResult.usage.cost;

    const scoreBreakdown = judgeResult.scores.map((s) => `${s.dimension}=${s.score}/5`).join(", ");

    results.push({
      suite: "llm-judge",
      category: c.category,
      name: c.name,
      passed: judgeResult.passed,
      score: judgeResult.overallScore,
      maxScore: 5,
      expected: `>= ${c.passThreshold}/5`,
      actual: `${judgeResult.overallScore}/5 [${scoreBreakdown}]`,
      latencyMs: ms,
      judgement: judgeResult.summary,
    });
  }

  return { results, totalCost };
}
