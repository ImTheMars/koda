/**
 * AssistantBench — shared types for all benchmark suites.
 *
 * v2: 2-tier classify (fast/deep), simplified ack, removed outcome/budget.
 */

import type { Tier } from "../src/config.js";
import type { RequestIntent } from "../src/router.js";

// --- Result types ---

export type SuiteName = "deterministic" | "llm-judge";

export interface BenchmarkResult {
  suite: string;
  category: string;
  name: string;
  passed: boolean;
  score: number;
  maxScore: number;
  expected: string;
  actual: string;
  latencyMs: number;
  judgement?: string;
}

export interface SuiteReport {
  suite: string;
  results: BenchmarkResult[];
  totalMs: number;
  cost?: number;
}

export interface BenchmarkSummary {
  suites: SuiteReport[];
  totalCases: number;
  totalPassed: number;
  totalFailed: number;
  passRate: number;
  averageScore: number;
  totalMs: number;
  totalCost: number;
}

// --- Deterministic case shapes ---

export interface ClassifyCase {
  name: string;
  input: string;
  expectedTier: Tier;
  expectedIntent: RequestIntent;
}

export interface AckCase {
  name: string;
  input: { content: string; tier: Tier; intent: RequestIntent; source?: string };
  expected: boolean;
}

export interface TimeCase {
  name: string;
  schedule: string;
  fromISO: string;
  timezone: string;
  expectedDateISO: string;
  toleranceMs: number;
}

export interface TimezoneValidationCase {
  name: string;
  timezone: string;
  expectedValid: boolean;
}

export interface NaturalScheduleCase {
  name: string;
  input: string;
  expected: string | null;
}

export interface DeterministicCases {
  classify: ClassifyCase[];
  ack: AckCase[];
  time: TimeCase[];
  timezoneValidation: TimezoneValidationCase[];
  naturalSchedule: NaturalScheduleCase[];
}

// --- LLM-judge case shapes ---

export type JudgeDimension =
  | "helpfulness" | "accuracy" | "personality" | "tone_style"
  | "safety" | "tool_selection" | "conciseness" | "boundary_adherence";

export interface JudgeRubric {
  dimension: JudgeDimension;
  description: string;
  weight: number;
}

export interface LLMJudgeCase {
  name: string;
  category: "quality" | "personality" | "safety" | "tool_use" | "edge_case";
  userMessage: string;
  assistantResponse: string;
  context?: string;
  rubrics: JudgeRubric[];
  passThreshold: number;
}

export interface LLMJudgeCases {
  cases: LLMJudgeCase[];
}

export interface JudgeScore {
  dimension: JudgeDimension;
  score: number;
  reasoning: string;
}

export interface JudgeResult {
  scores: JudgeScore[];
  overallScore: number;
  passed: boolean;
  summary: string;
  usage: { promptTokens: number; completionTokens: number; cost: number };
}
