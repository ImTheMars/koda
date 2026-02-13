/**
 * AssistantBench runner — orchestrates all benchmark suites.
 *
 * Usage:
 *   bun run bench/runner.ts                          # run all deterministic
 *   bun run bench/runner.ts --suite deterministic     # deterministic only
 *   bun run bench/runner.ts --suite llm-judge         # LLM-judged only
 *   bun run bench/runner.ts --suite all               # everything
 *   bun run bench/runner.ts --format json             # JSON output for CI
 */

import { join } from "path";
import { scoreDeterministic, scoreLLMJudge } from "./scorers.js";
import { summarize, renderReport, renderJSON } from "./report.js";
import type { DeterministicCases, LLMJudgeCases, SuiteReport, SuiteName } from "./types.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { suite: SuiteName | "all"; format: "pretty" | "json" } {
  let suite: SuiteName | "all" = "deterministic";
  let format: "pretty" | "json" = "pretty";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--suite" && argv[i + 1]) {
      const val = argv[i + 1]!;
      if (val === "deterministic" || val === "llm-judge" || val === "all") {
        suite = val;
      } else {
        throw new Error(`Unknown suite '${val}'. Supported: deterministic, llm-judge, all`);
      }
    }
    if (argv[i] === "--format" && argv[i + 1]) {
      const val = argv[i + 1]!;
      if (val === "json" || val === "pretty") {
        format = val;
      }
    }
  }

  return { suite, format };
}

// ---------------------------------------------------------------------------
// Case loaders
// ---------------------------------------------------------------------------

async function loadJSON<T>(filename: string): Promise<T> {
  const filePath = join(import.meta.dir, "cases", filename);
  const text = await Bun.file(filePath).text();
  return JSON.parse(text) as T;
}

async function loadDeterministicCases(): Promise<DeterministicCases> {
  return loadJSON<DeterministicCases>("deterministic.json");
}

async function loadLLMJudgeCases(): Promise<LLMJudgeCases> {
  return loadJSON<LLMJudgeCases>("llm-judge.json");
}

// ---------------------------------------------------------------------------
// Suite runners
// ---------------------------------------------------------------------------

async function runDeterministic(): Promise<SuiteReport> {
  const cases = await loadDeterministicCases();
  const start = performance.now();
  const results = scoreDeterministic(cases);
  const totalMs = performance.now() - start;

  return { suite: "deterministic", results, totalMs };
}

async function runLLMJudge(): Promise<SuiteReport> {
  const cases = await loadLLMJudgeCases();
  const start = performance.now();
  const { results, totalCost } = await scoreLLMJudge(cases);
  const totalMs = performance.now() - start;

  return { suite: "llm-judge", results, totalMs, cost: totalCost };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { suite, format } = parseArgs(process.argv);
  const suiteReports: SuiteReport[] = [];

  if (suite === "deterministic" || suite === "all") {
    suiteReports.push(await runDeterministic());
  }

  if (suite === "llm-judge" || suite === "all") {
    try {
      suiteReports.push(await runLLMJudge());
    } catch (err) {
      if (err instanceof Error && err.message.includes("API key")) {
        console.error(`\x1b[33m[skip] LLM judge suite: ${err.message}\x1b[0m\n`);
      } else {
        throw err;
      }
    }
  }

  if (suiteReports.length === 0) {
    console.error("No suites ran.");
    process.exitCode = 1;
    return;
  }

  const summary = summarize(suiteReports);

  if (format === "json") {
    console.log(renderJSON(summary));
  } else {
    console.log(renderReport(summary));
  }

  if (summary.totalFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\x1b[31mbenchmark run failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  process.exitCode = 1;
});
