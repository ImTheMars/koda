/**
 * Cross-compile script: build Koda binary for all 5 targets.
 * Usage: bun run scripts/build.ts
 */

import { spawn } from "child_process";
import { stat, mkdir } from "fs/promises";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "src", "index.ts");
const DIST = resolve(ROOT, "dist");

const TARGETS = [
  { target: "bun-linux-x64", output: "koda-linux-x64" },
  { target: "bun-linux-arm64", output: "koda-linux-arm64" },
  { target: "bun-darwin-x64", output: "koda-darwin-x64" },
  { target: "bun-darwin-arm64", output: "koda-darwin-arm64" },
  { target: "bun-windows-x64", output: "koda-windows-x64.exe" },
];

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on("error", reject);
  });
}

async function main() {
  console.log("build: compiling targets...\n");
  await mkdir(DIST, { recursive: true });

  for (const { target, output } of TARGETS) {
    const outPath = resolve(DIST, output);
    console.log(`  ${target} → dist/${output}`);
    try {
      await run("bun", [
        "build",
        "--compile",
        `--target=${target}`,
        `--outfile=${outPath}`,
        ENTRY,
      ]);
      const st = await stat(outPath);
      const mb = st.size / (1024 * 1024);
      console.log(`    done ${mb.toFixed(1)} MB`);
    } catch (e) {
      console.log(`    failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  console.log("\nbuild: done.\n");
}

main().catch((err) => {
  console.error("build: failed", err);
  process.exit(1);
});
