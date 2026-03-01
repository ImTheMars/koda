/**
 * Report generator — JSON file, console table, and comparison diff.
 */

import { mkdir, writeFile, readFile } from "fs/promises";
import { resolve } from "path";
import type { BenchReport, TestResult, CategorySummary } from "./types.js";

// ── JSON report ──────────────────────────────────────────────

export async function saveReport(report: BenchReport, outputDir: string, filename?: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const name = filename ?? `bench-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  const path = resolve(outputDir, name);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  return path;
}

export async function loadReport(path: string): Promise<BenchReport> {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as BenchReport;
}

// ── Category summaries ───────────────────────────────────────

export function buildCategorySummaries(results: TestResult[]): CategorySummary[] {
  const byCategory = new Map<string, TestResult[]>();
  for (const r of results) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  const summaries: CategorySummary[] = [];
  for (const [category, tests] of byCategory) {
    summaries.push({
      category,
      testsRun: tests.length,
      testsPassed: tests.filter((t) => t.passed).length,
      avgScore: tests.reduce((sum, t) => sum + t.scores.overall, 0) / tests.length,
      avgWallClockMs: tests.reduce((sum, t) => sum + t.totalWallClockMs, 0) / tests.length,
      totalCost: tests.reduce((sum, t) => sum + t.totalCost, 0),
    });
  }

  return summaries.sort((a, b) => a.category.localeCompare(b.category));
}

// ── Console table ────────────────────────────────────────────

function pad(s: string, len: number, align: "left" | "right" = "left"): string {
  if (align === "right") return s.padStart(len);
  return s.padEnd(len);
}

export function printSummaryTable(report: BenchReport): void {
  const cats = report.categories;
  const divider = "+-----------------+-------+--------+---------+----------+--------+";

  console.log("\n" + divider);
  console.log(`| ${pad("Category", 15)} | ${pad("Tests", 5)} | ${pad("Passed", 6)} | ${pad("Score", 7)} | ${pad("Avg ms", 8)} | ${pad("Cost", 6)} |`);
  console.log(divider);

  for (const cat of cats) {
    const score = `${cat.avgScore.toFixed(1)}/10`;
    const avgMs = `${Math.round(cat.avgWallClockMs)}ms`;
    const cost = `$${cat.totalCost.toFixed(3)}`;
    console.log(
      `| ${pad(cat.category, 15)} | ${pad(String(cat.testsRun), 5, "right")} | ${pad(String(cat.testsPassed), 6, "right")} | ${pad(score, 7, "right")} | ${pad(avgMs, 8, "right")} | ${pad(cost, 6, "right")} |`,
    );
  }

  console.log(divider);

  const totalScore = `${report.totals.overallScore.toFixed(1)}%`;
  const totalTime = formatDuration(report.totals.totalWallClockMs);
  const totalCost = `$${report.totals.totalCost.toFixed(2)}`;

  console.log(
    `| ${pad("TOTAL", 15)} | ${pad(String(report.totals.testsRun), 5, "right")} | ${pad(String(report.totals.passed), 6, "right")} | ${pad(totalScore, 7, "right")} | ${pad(totalTime, 8, "right")} | ${pad(totalCost, 6, "right")} |`,
  );
  console.log(divider);
  console.log();
}

// ── Comparison table ─────────────────────────────────────────

export function printComparisonTable(baseline: BenchReport, current: BenchReport): void {
  console.log("\n=== Comparison ===\n");
  console.log(`Baseline: ${baseline.modelConfig.deepModel} (${baseline.timestamp})`);
  console.log(`Current:  ${current.modelConfig.deepModel} (${current.timestamp})`);

  const divider = "+-----------------+-----------+-----------+--------+";

  console.log("\n" + divider);
  console.log(`| ${pad("Category", 15)} | ${pad("Baseline", 9)} | ${pad("Current", 9)} | ${pad("Delta", 6)} |`);
  console.log(divider);

  const baselineCats = new Map(baseline.categories.map((c) => [c.category, c]));
  const allCategories = new Set([
    ...baseline.categories.map((c) => c.category),
    ...current.categories.map((c) => c.category),
  ]);

  for (const cat of [...allCategories].sort()) {
    const base = baselineCats.get(cat);
    const curr = current.categories.find((c) => c.category === cat);

    const baseScore = base ? `${base.avgScore.toFixed(1)}/10` : "  n/a  ";
    const currScore = curr ? `${curr.avgScore.toFixed(1)}/10` : "  n/a  ";

    let delta = "  n/a ";
    if (base && curr) {
      const diff = curr.avgScore - base.avgScore;
      const sign = diff >= 0 ? "+" : "";
      delta = `${sign}${diff.toFixed(1)}`;
    }

    console.log(
      `| ${pad(cat, 15)} | ${pad(baseScore, 9, "right")} | ${pad(currScore, 9, "right")} | ${pad(delta, 6, "right")} |`,
    );
  }

  console.log(divider);

  // Overall row
  const baseOverall = `${baseline.totals.overallScore.toFixed(1)}%`;
  const currOverall = `${current.totals.overallScore.toFixed(1)}%`;
  const overallDiff = current.totals.overallScore - baseline.totals.overallScore;
  const overallDelta = `${overallDiff >= 0 ? "+" : ""}${overallDiff.toFixed(1)}%`;

  console.log(
    `| ${pad("Overall", 15)} | ${pad(baseOverall, 9, "right")} | ${pad(currOverall, 9, "right")} | ${pad(overallDelta, 6, "right")} |`,
  );

  // Cost row
  const baseCost = `$${baseline.totals.totalCost.toFixed(2)}`;
  const currCost = `$${current.totals.totalCost.toFixed(2)}`;
  const costPctDiff = baseline.totals.totalCost > 0
    ? ((current.totals.totalCost - baseline.totals.totalCost) / baseline.totals.totalCost * 100)
    : 0;
  const costDelta = `${costPctDiff >= 0 ? "+" : ""}${Math.round(costPctDiff)}%`;

  console.log(
    `| ${pad("Cost", 15)} | ${pad(baseCost, 9, "right")} | ${pad(currCost, 9, "right")} | ${pad(costDelta, 6, "right")} |`,
  );

  console.log(divider);
  console.log();
}

// ── Verbose output ───────────────────────────────────────────

export function printVerboseResult(result: TestResult): void {
  console.log(`\n  Test: ${result.testId} — ${result.name}`);
  for (let i = 0; i < result.turns.length; i++) {
    const turn = result.turns[i]!;
    console.log(`    Turn ${i + 1}:`);
    console.log(`      User:  ${turn.input.slice(0, 120)}${turn.input.length > 120 ? "..." : ""}`);
    console.log(`      Agent: ${turn.output.slice(0, 200)}${turn.output.length > 200 ? "..." : ""}`);
    console.log(`      Tier: ${turn.tier} | Tools: [${turn.toolsUsed.join(", ")}] | ${turn.wallClockMs}ms`);
    if (turn.error) console.log(`      ERROR: ${turn.error}`);
  }
  console.log(`    Scores: C=${result.scores.correctness} T=${result.scores.toolUsage} R=${result.scores.responseQuality} S=${result.scores.tone} → ${result.scores.overall.toFixed(1)}/10`);
  console.log(`    Judge: ${result.scores.judgeReasoning.slice(0, 200)}`);
}

// ── Helpers ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}
