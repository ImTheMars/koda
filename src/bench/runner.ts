/**
 * Execution engine — boots Koda with an isolated bench DB, runs tests, collects results.
 *
 * Reuses existing boot modules: bootConfig, bootProviders, buildTools, createAgent, registerSubAgentTools.
 * Uses a separate bench_koda.db and workspace/bench-scratch/ to avoid polluting production data.
 */

import { resolve } from "path";
import { mkdir, rm } from "fs/promises";
import { bootConfig } from "../boot/config.js";
import { bootProviders } from "../boot/providers.js";
import { buildTools } from "../tools/index.js";
import { registerSubAgentTools } from "../tools/subagent.js";
import { createAgent, type AgentDeps, type AgentInput } from "../agent.js";
import { initDb, closeDb } from "../db.js";
import type { Config } from "../config.js";
import type { TestCase, TestResult, TurnResult, BenchOptions, BenchReport } from "./types.js";
import { getTestsByCategory, getCategories } from "./suite.js";
import { simulateUserMessage, getSimulatorCost, resetSimulatorCost, type SimulatorOptions } from "./simulator.js";
import { gradeTest, getJudgeCost, resetJudgeCost } from "./judge.js";
import { buildCategorySummaries, printSummaryTable, printVerboseResult, printComparisonTable, saveReport, loadReport } from "./report.js";

const PASS_THRESHOLD = 6.0;

export async function runBenchmark(options: BenchOptions): Promise<void> {
  const startTime = Date.now();

  // ── Boot ────────────────────────────────────────────────────
  console.log("[bench] Booting Koda for benchmark...");
  const config = await bootConfig();

  // Apply model overrides from CLI
  if (options.model) config.openrouter.deepModel = options.model;
  if (options.fastModel) config.openrouter.fastModel = options.fastModel;

  // Isolated database
  const benchDbPath = resolve(config.workspace, "bench_koda.db");
  initDb(benchDbPath);
  console.log(`[bench] Using isolated DB: ${benchDbPath}`);

  // Scratch directory for file I/O tests
  const scratchDir = resolve(config.workspace, "bench-scratch");
  await mkdir(scratchDir, { recursive: true });

  // Boot providers (memory, soul, skills, context)
  const providers = await bootProviders(config);

  // Build tools with scratch workspace
  const tools = await buildTools({
    config,
    memoryProvider: providers.memoryProvider,
    skillLoader: providers.skillLoader,
    workspace: scratchDir,
    soulLoader: providers.soulLoader,
  });

  // Create agent
  const agentDeps: AgentDeps = {
    config,
    tools,
    getSoulPrompt: () => providers.soulLoader.generatePrompt(),
    getContextPrompt: () => providers.getContextContent(),
    getSkillsSummary: () => providers.skillLoader.buildSkillsSummary(),
    getProfile: (userId, query, sessionKey) => providers.memoryProvider.getProfile(userId, query || undefined, sessionKey),
    ingestConversation: (sessionKey, userId, messages) => providers.memoryProvider.ingestConversation(sessionKey, userId, messages),
    getSoulAcks: () => providers.soulLoader.getAckTemplates(),
  };

  const runAgent = createAgent(agentDeps);

  // Register sub-agent tools
  const subTools = registerSubAgentTools({
    agentDeps,
    masterTools: tools,
    timeoutMs: config.subagent.timeoutMs,
    maxStepsCap: config.subagent.maxSteps,
  });
  Object.assign(tools, subTools);

  console.log(`[bench] Ready — ${Object.keys(tools).length} tools loaded`);

  // ── Select tests ────────────────────────────────────────────
  let tests = getTestsByCategory(options.category);

  // Skip composio tests if flagged
  if (options.skipComposio) {
    tests = tests.filter((t) => t.category !== "composio");
  }

  console.log(`[bench] Running ${tests.length} tests${options.category ? ` (category: ${options.category})` : ""}`);
  console.log();

  // ── Simulator + judge config ────────────────────────────────
  const simOptions: SimulatorOptions = {
    apiKey: config.openrouter.apiKey,
    model: config.openrouter.fastModel,
  };

  const judgeOptions = {
    apiKey: config.openrouter.apiKey,
    model: options.judgeModel,
  };

  resetSimulatorCost();
  resetJudgeCost();

  // ── Execute tests ──────────────────────────────────────────
  const results: TestResult[] = [];
  let passCount = 0;

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i]!;
    const testStart = Date.now();

    try {
      const result = await executeTest(test, runAgent, config, simOptions, judgeOptions, options.verbose);
      results.push(result);

      const status = result.passed ? "\x1b[32m[PASS]\x1b[0m" : "\x1b[31m[FAIL]\x1b[0m";
      console.log(`${status} ${result.testId} — ${result.scores.overall.toFixed(1)}/10 — ${result.totalWallClockMs}ms`);

      if (result.passed) passCount++;
      if (options.verbose) printVerboseResult(result);
    } catch (err) {
      console.error(`\x1b[31m[ERROR]\x1b[0m ${test.id} — ${(err as Error).message}`);
      results.push(makeErrorResult(test, (err as Error).message, Date.now() - testStart));
    }
  }

  // ── Build report ───────────────────────────────────────────
  const overallScore = results.length > 0
    ? (results.reduce((sum, r) => sum + r.scores.overall, 0) / results.length) * 10
    : 0;

  const report: BenchReport = {
    id: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    modelConfig: {
      deepModel: config.openrouter.deepModel,
      fastModel: config.openrouter.fastModel,
      judgeModel: options.judgeModel,
    },
    categories: buildCategorySummaries(results),
    results,
    totals: {
      testsRun: results.length,
      passed: passCount,
      overallScore,
      totalCost: results.reduce((sum, r) => sum + r.totalCost, 0) + getSimulatorCost(),
      judgeCost: getJudgeCost(),
      totalWallClockMs: Date.now() - startTime,
    },
  };

  // ── Output ────────────────────────────────────────────────
  printSummaryTable(report);

  const benchmarksDir = resolve(config.workspace, "benchmarks");
  const reportPath = await saveReport(report, benchmarksDir, options.output);
  console.log(`Report saved: ${reportPath}`);

  // ── Comparison ────────────────────────────────────────────
  if (options.compare) {
    try {
      const baseline = await loadReport(options.compare);
      printComparisonTable(baseline, report);
    } catch (err) {
      console.error(`Failed to load comparison baseline: ${(err as Error).message}`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────
  closeDb();

  // Clean scratch dir
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch {}

  // Close watchers
  providers.contextWatcher?.close();
  providers.contextDirWatcher?.close();
  if (providers.contextReloadTimeout) clearTimeout(providers.contextReloadTimeout);
}

// ── Single test execution ────────────────────────────────────

async function executeTest(
  test: TestCase,
  runAgent: (input: AgentInput) => Promise<any>,
  config: Config,
  simOptions: SimulatorOptions,
  judgeOptions: { apiKey: string; model: string },
  verbose: boolean,
): Promise<TestResult> {
  const sessionKey = `bench_${test.id}_${Date.now()}`;
  const turns: TurnResult[] = [];
  let totalCost = 0;
  const testStart = Date.now();

  // Execute each turn
  let lastOutput = "";
  for (const turnInput of test.turns) {
    // Get user message — static or simulated
    let message: string;
    if (turnInput.message) {
      message = turnInput.message;
    } else if (turnInput.simulate) {
      message = await simulateUserMessage(
        turnInput.simulate,
        lastOutput || undefined,
        simOptions,
      );
      if (verbose) console.log(`    [sim] ${message.slice(0, 100)}`);
    } else {
      message = "hello";
    }

    // Run agent
    const turnStart = Date.now();
    try {
      const input: AgentInput = {
        content: message,
        senderId: "bench-user",
        chatId: "bench-chat",
        channel: "bench",
        sessionKey,
        source: "bench",
        tierOverride: turnInput.expectedTier,
      };

      const result = await runAgent(input);

      turns.push({
        input: message,
        output: result.text,
        tier: result.tier,
        toolsUsed: result.toolsUsed,
        usage: result.usage,
        wallClockMs: Date.now() - turnStart,
      });

      totalCost += result.usage.cost;
      lastOutput = result.text;
    } catch (err) {
      turns.push({
        input: message,
        output: "",
        tier: "fast",
        toolsUsed: [],
        usage: { promptTokens: 0, completionTokens: 0, cost: 0 },
        wallClockMs: Date.now() - turnStart,
        error: (err as Error).message,
      });
      lastOutput = "";
    }
  }

  // Grade
  const scores = await gradeTest(test, turns, judgeOptions);

  return {
    testId: test.id,
    category: test.category,
    name: test.name,
    turns,
    scores,
    totalCost,
    totalWallClockMs: Date.now() - testStart,
    passed: scores.overall >= PASS_THRESHOLD,
  };
}

function makeErrorResult(test: TestCase, error: string, wallClockMs: number): TestResult {
  return {
    testId: test.id,
    category: test.category,
    name: test.name,
    turns: [{
      input: "ERROR",
      output: "",
      tier: "fast",
      toolsUsed: [],
      usage: { promptTokens: 0, completionTokens: 0, cost: 0 },
      wallClockMs,
      error,
    }],
    scores: {
      correctness: 0,
      toolUsage: 0,
      responseQuality: 0,
      tone: 0,
      overall: 0,
      judgeReasoning: `Test execution error: ${error}`,
    },
    totalCost: 0,
    totalWallClockMs: wallClockMs,
    passed: false,
  };
}
