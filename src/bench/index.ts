/**
 * Benchmark CLI entry point.
 *
 * Usage:
 *   bun run bench                                     # full suite
 *   bun run bench -c memory -v                        # memory tests, verbose
 *   bun run bench -m openai/gpt-5.3-codex             # test specific deep model
 *   bun run bench --compare benchmarks/baseline.json   # compare with previous
 *   bun run bench --help                               # show usage
 */

import type { BenchOptions } from "./types.js";
import { runBenchmark } from "./runner.js";
import { getCategories } from "./suite.js";

function parseArgs(args: string[]): BenchOptions {
  const opts: BenchOptions = {
    verbose: false,
    skipComposio: true,
    judgeModel: "google/gemini-3-flash-preview",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    switch (arg) {
      case "-m":
      case "--model":
        opts.model = next;
        i++;
        break;
      case "--fast-model":
        opts.fastModel = next;
        i++;
        break;
      case "-c":
      case "--category":
        opts.category = next;
        i++;
        break;
      case "-v":
      case "--verbose":
        opts.verbose = true;
        break;
      case "--compare":
        opts.compare = next;
        i++;
        break;
      case "--skip-composio":
        opts.skipComposio = next !== "false";
        if (next === "false" || next === "true") i++;
        break;
      case "--judge-model":
        opts.judgeModel = next!;
        i++;
        break;
      case "-o":
      case "--output":
        opts.output = next;
        i++;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
    }
  }

  return opts;
}

function printHelp(): void {
  const categories = getCategories();
  console.log(`
Koda Benchmark Suite
====================

Usage: bun run bench [options]

Options:
  -m, --model <model>        Deep model to test (default: from config)
  --fast-model <model>       Fast model to test (default: from config)
  -c, --category <cat>       Run only tests in this category
  -v, --verbose              Show turn-by-turn output
  --compare <file>           Compare with a previous benchmark JSON report
  --skip-composio [bool]     Skip Composio tests (default: true)
  --judge-model <model>      Model for LLM judge (default: google/gemini-3-flash-preview)
  -o, --output <file>        Output filename for the report
  -h, --help                 Show this help message

Categories: ${categories.join(", ")}

Examples:
  bun run bench                                     Full suite
  bun run bench -c memory -v                        Memory tests, verbose
  bun run bench -m anthropic/claude-sonnet-4.6      Test with Claude
  bun run bench --compare benchmarks/baseline.json  Compare runs
`);
}

// ── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseArgs(args);

if (options.help) {
  printHelp();
  process.exit(0);
}

runBenchmark(options).catch((err) => {
  console.error("\n[bench] Fatal error:", err);
  process.exit(1);
});
