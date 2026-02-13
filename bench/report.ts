/**
 * AssistantBench reporter — rich terminal output with color and per-suite breakdown.
 */

import type { BenchmarkResult, BenchmarkSummary, SuiteReport } from "./types.js";

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
};

// ---------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------

export function summarize(suites: SuiteReport[]): BenchmarkSummary {
  const allResults = suites.flatMap((s) => s.results);
  const totalCases = allResults.length;
  const totalPassed = allResults.filter((r) => r.passed).length;
  const totalFailed = totalCases - totalPassed;
  const passRate = totalCases > 0 ? totalPassed / totalCases : 0;

  // Average score normalized to 0-1 (deterministic is already 0-1, llm-judge is 1-5 → normalize)
  const avgScore =
    totalCases > 0
      ? allResults.reduce((sum, r) => {
          const normalized = r.maxScore === 5 ? (r.score - 1) / 4 : r.score;
          return sum + normalized;
        }, 0) / totalCases
      : 0;

  const totalMs = suites.reduce((sum, s) => sum + s.totalMs, 0);
  const totalCost = suites.reduce((sum, s) => sum + (s.cost ?? 0), 0);

  return { suites, totalCases, totalPassed, totalFailed, passRate, averageScore: avgScore, totalMs, totalCost };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function pad(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function passIcon(passed: boolean): string {
  return passed ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;
}

function scoreBar(score: number, max: number): string {
  const normalized = max === 5 ? (score - 1) / 4 : score;
  const filled = Math.round(normalized * 10);
  const empty = 10 - filled;
  const color = normalized >= 0.8 ? c.green : normalized >= 0.5 ? c.yellow : c.red;
  return `${color}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
}

function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderCategoryBlock(category: string, results: BenchmarkResult[]): string {
  const lines: string[] = [];
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const rate = total > 0 ? passed / total : 0;
  const rateColor = rate >= 0.8 ? c.green : rate >= 0.5 ? c.yellow : c.red;

  lines.push(`  ${c.cyan}${c.bold}${category}${c.reset} ${c.dim}(${passed}/${total})${c.reset} ${rateColor}${(rate * 100).toFixed(0)}%${c.reset}`);

  for (const r of results) {
    const icon = passIcon(r.passed);
    const bar = scoreBar(r.score, r.maxScore);
    const latency = r.latencyMs > 0 ? ` ${c.dim}${formatMs(r.latencyMs)}${c.reset}` : "";
    lines.push(`    [${icon}] ${pad(r.name, 45)} ${bar}${latency}`);

    if (!r.passed) {
      lines.push(`${c.dim}           expected: ${r.expected}${c.reset}`);
      lines.push(`${c.dim}           actual:   ${r.actual}${c.reset}`);
    }

    if (r.judgement) {
      lines.push(`${c.dim}           judge: ${r.judgement}${c.reset}`);
    }
  }

  return lines.join("\n");
}

export function renderReport(summary: BenchmarkSummary): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(`${c.bold}${c.magenta}╔══════════════════════════════════════════════════════════════╗${c.reset}`);
  lines.push(`${c.bold}${c.magenta}║${c.reset}              ${c.bold}${c.white}A S S I S T A N T B E N C H${c.reset}              ${c.bold}${c.magenta}║${c.reset}`);
  lines.push(`${c.bold}${c.magenta}║${c.reset}              ${c.dim}Koda v2 Evaluation Suite${c.reset}                  ${c.bold}${c.magenta}║${c.reset}`);
  lines.push(`${c.bold}${c.magenta}╚══════════════════════════════════════════════════════════════╝${c.reset}`);
  lines.push("");

  // Per-suite breakdown
  for (const suite of summary.suites) {
    const suitePassed = suite.results.filter((r) => r.passed).length;
    const suiteTotal = suite.results.length;
    const suiteRate = suiteTotal > 0 ? suitePassed / suiteTotal : 0;
    const rateColor = suiteRate >= 0.8 ? c.green : suiteRate >= 0.5 ? c.yellow : c.red;

    lines.push(`${c.bold}${c.blue}━━━ ${suite.suite.toUpperCase()} ━━━${c.reset} ${rateColor}${suitePassed}/${suiteTotal} passed${c.reset} ${c.dim}(${formatMs(suite.totalMs)})${c.reset}${suite.cost ? ` ${c.yellow}$${suite.cost.toFixed(4)}${c.reset}` : ""}`);
    lines.push("");

    // Group by category
    const categories = new Map<string, BenchmarkResult[]>();
    for (const r of suite.results) {
      const cat = categories.get(r.category) ?? [];
      cat.push(r);
      categories.set(r.category, cat);
    }

    for (const [category, results] of categories) {
      lines.push(renderCategoryBlock(category, results));
      lines.push("");
    }
  }

  // Summary footer
  const passColor = summary.passRate >= 0.8 ? c.green : summary.passRate >= 0.5 ? c.yellow : c.red;
  const badge = summary.passRate >= 0.9 ? `${c.bgGreen}${c.bold} EXCELLENT ${c.reset}` :
                summary.passRate >= 0.7 ? `${c.bgGreen}${c.bold} GOOD ${c.reset}` :
                summary.passRate >= 0.5 ? `${c.yellow}${c.bold} FAIR ${c.reset}` :
                `${c.bgRed}${c.bold} NEEDS WORK ${c.reset}`;

  lines.push(`${c.bold}${c.magenta}──────────────────────────────────────────────────────────────${c.reset}`);
  lines.push(`  ${c.bold}Total${c.reset}:    ${summary.totalCases} cases`);
  lines.push(`  ${c.bold}Passed${c.reset}:   ${c.green}${summary.totalPassed}${c.reset}`);
  lines.push(`  ${c.bold}Failed${c.reset}:   ${summary.totalFailed > 0 ? `${c.red}${summary.totalFailed}` : `${c.green}0`}${c.reset}`);
  lines.push(`  ${c.bold}Rate${c.reset}:     ${passColor}${(summary.passRate * 100).toFixed(1)}%${c.reset}  ${badge}`);
  lines.push(`  ${c.bold}Avg Score${c.reset}: ${passColor}${(summary.averageScore * 100).toFixed(1)}%${c.reset}`);
  lines.push(`  ${c.bold}Time${c.reset}:     ${formatMs(summary.totalMs)}`);
  if (summary.totalCost > 0) {
    lines.push(`  ${c.bold}Cost${c.reset}:     ${c.yellow}$${summary.totalCost.toFixed(4)}${c.reset}`);
  }
  lines.push(`${c.bold}${c.magenta}──────────────────────────────────────────────────────────────${c.reset}`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON export (for CI)
// ---------------------------------------------------------------------------

export function renderJSON(summary: BenchmarkSummary): string {
  return JSON.stringify({
    passRate: summary.passRate,
    averageScore: summary.averageScore,
    totalCases: summary.totalCases,
    passed: summary.totalPassed,
    failed: summary.totalFailed,
    totalMs: Math.round(summary.totalMs),
    cost: summary.totalCost,
    suites: summary.suites.map((s) => ({
      suite: s.suite,
      cases: s.results.length,
      passed: s.results.filter((r) => r.passed).length,
      failed: s.results.filter((r) => !r.passed).length,
      ms: Math.round(s.totalMs),
      cost: s.cost ?? 0,
    })),
    failures: summary.suites
      .flatMap((s) => s.results)
      .filter((r) => !r.passed)
      .map((r) => ({
        suite: r.suite,
        category: r.category,
        name: r.name,
        expected: r.expected,
        actual: r.actual,
        judgement: r.judgement,
      })),
  }, null, 2);
}
