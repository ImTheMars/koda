/**
 * CLI commands — setup, doctor, upgrade, version.
 *
 * Uses @clack/prompts + chalk + ora for terminal UI.
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import ora from "ora";
import { writeFile, readFile, chmod, access, stat } from "fs/promises";
import { resolve } from "path";
import { homedir } from "os";
import { validateTimezone } from "./time.js";
import { readEnvFile } from "./env.js";
import { VERSION } from "./version.js";
const REPO = "ImTheMars/koda";

function getWorkspacePath(): string {
  return resolve(homedir(), ".koda");
}

async function ensureWorkspace(workspace: string): Promise<void> {
  const { mkdir } = await import("fs/promises");
  await mkdir(workspace, { recursive: true });
  await mkdir(resolve(workspace, "config"), { recursive: true });
  await mkdir(resolve(workspace, "config", "soul.d"), { recursive: true });
  await mkdir(resolve(workspace, "skills"), { recursive: true });
}

// --- Setup ---

async function validateOpenRouterKey(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

async function runSetup(): Promise<void> {
  clack.intro(chalk.cyan("koda setup"));

  const workspace = getWorkspacePath();
  const spinner = ora("preparing workspace").start();
  await ensureWorkspace(workspace);
  spinner.succeed(`workspace ready ${chalk.dim(workspace)}`);

  // Check existing config
  const existingConfigPath = resolve(workspace, "config.json");
  try {
    await readFile(existingConfigPath, "utf-8");
    const overwrite = await clack.confirm({ message: "config already exists. overwrite?" });
    if (clack.isCancel(overwrite) || !overwrite) { clack.outro("setup cancelled"); return; }
  } catch {}

  // Mode
  const mode = await clack.select({
    message: "Runtime mode:",
    options: [
      { value: "cli-only", label: "cli-only — local chat, no Telegram" },
      { value: "private", label: "private — Telegram bot + CLI" },
    ],
  });
  if (clack.isCancel(mode)) { clack.outro("cancelled"); return; }

  // OpenRouter key
  const openrouterKey = await clack.text({ message: "OpenRouter API key:", validate: (v) => v ? undefined : "Required" });
  if (clack.isCancel(openrouterKey)) { clack.outro("cancelled"); return; }

  const keySpinner = ora("validating key").start();
  const valid = await validateOpenRouterKey(openrouterKey as string);
  if (valid) keySpinner.succeed("OpenRouter key validated");
  else { keySpinner.fail("key rejected"); return; }

  // Supermemory key (optional — local embeddings work without it)
  const supermemoryKey = await clack.text({
    message: "Supermemory API key (optional — leave blank for local-only memory):",
    placeholder: "optional",
  });
  if (clack.isCancel(supermemoryKey)) { clack.outro("cancelled"); return; }

  // Exa key
  const exaKey = await clack.text({ message: "Exa API key (for web search):", placeholder: "optional — get one free at dashboard.exa.ai" });
  if (clack.isCancel(exaKey)) { clack.outro("cancelled"); return; }

  // Telegram (conditional)
  let telegramToken = "";
  let telegramUserId = "";
  if (mode === "private") {
    const token = await clack.text({ message: "Telegram bot token:" });
    if (clack.isCancel(token)) { clack.outro("cancelled"); return; }
    telegramToken = token as string;

    const userId = await clack.text({ message: "Your Telegram user ID:" });
    if (clack.isCancel(userId)) { clack.outro("cancelled"); return; }
    telegramUserId = userId as string;
  }

  // Timezone
  let timezone: string;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { timezone = "UTC"; }
  if (!validateTimezone(timezone)) timezone = "UTC";
  const useDetected = await clack.confirm({ message: `Use detected timezone ${chalk.cyan(timezone)}?` });
  if (clack.isCancel(useDetected)) { clack.outro("cancelled"); return; }
  if (!useDetected) {
    const tz = await clack.text({
      message: "Timezone (e.g. America/New_York):",
      validate: (v) => validateTimezone(v) ? undefined : "Invalid timezone",
    });
    if (clack.isCancel(tz)) { clack.outro("cancelled"); return; }
    timezone = tz as string;
  }

  // Write files
  const writeSpinner = ora("writing configuration").start();

  // .env
  const envPath = resolve(workspace, ".env");
  const envLines: string[] = [];
  envLines.push(`KODA_OPENROUTER_API_KEY=${openrouterKey}`);
  if (supermemoryKey) envLines.push(`KODA_SUPERMEMORY_API_KEY=${supermemoryKey}`);
  if (exaKey) envLines.push(`KODA_EXA_API_KEY=${exaKey}`);
  if (telegramToken) envLines.push(`KODA_TELEGRAM_TOKEN=${telegramToken}`);
  await writeFile(envPath, envLines.join("\n") + "\n", "utf-8");
  try { await chmod(envPath, 0o600); } catch {}

  // config.json
  const config: Record<string, unknown> = {
    mode,
    features: { scheduler: mode === "private" },
    scheduler: { timezone },
  };
  if (mode === "private" && telegramUserId) {
    config.telegram = { allowFrom: [telegramUserId], adminIds: [telegramUserId] };
  }
  const configPath = resolve(workspace, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  writeSpinner.succeed("configuration saved");

  clack.outro(`${chalk.green("setup complete")} — run ${chalk.cyan("koda doctor")} to verify`);
}

// --- Setup Composio ---

async function runSetupComposio(): Promise<void> {
  clack.intro(chalk.cyan("koda setup composio"));

  const workspace = getWorkspacePath();
  const envPath = resolve(workspace, ".env");
  const existingEnv = readEnvFile(envPath);

  let apiKey = process.env.KODA_COMPOSIO_API_KEY ?? existingEnv.KODA_COMPOSIO_API_KEY ?? "";

  if (!apiKey) {
    const keyInput = await clack.text({
      message: "Composio API key (from composio.dev/settings):",
      validate: (v) => v ? undefined : "Required",
    });
    if (clack.isCancel(keyInput)) { clack.outro("cancelled"); return; }
    apiKey = keyInput as string;

    // Append to .env
    const spinner = ora("saving API key").start();
    try {
      let content = "";
      try { content = await readFile(envPath, "utf-8"); } catch {}
      if (!content.endsWith("\n") && content.length > 0) content += "\n";
      content += `KODA_COMPOSIO_API_KEY=${apiKey}\n`;
      await writeFile(envPath, content, "utf-8");
      try { await chmod(envPath, 0o600); } catch {}
      spinner.succeed("API key saved");
    } catch (err) {
      spinner.fail("failed to save key: " + (err as Error).message);
      return;
    }
  } else {
    console.log(chalk.dim("  using existing Composio API key"));
  }

  // Import composio module
  const { createComposioClient } = await import("./composio.js");
  const composio = createComposioClient({ apiKey });

  // Read owner ID from config
  let ownerId = "owner";
  try {
    const configPath = resolve(workspace, "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    ownerId = raw?.owner?.id ?? raw?.telegram?.adminIds?.[0] ?? "owner";
  } catch {}

  const apps = ["gmail", "googlecalendar", "github"];
  const labels: Record<string, string> = {
    gmail: "Gmail",
    googlecalendar: "Google Calendar",
    github: "GitHub",
  };

  for (const app of apps) {
    const connectApp = await clack.confirm({
      message: `Connect ${labels[app]}?`,
    });
    if (clack.isCancel(connectApp)) { clack.outro("cancelled"); return; }
    if (!connectApp) continue;

    const already = await composio.isConnected(app);
    if (already) {
      console.log(chalk.green(`  ${labels[app]} already connected`));
      continue;
    }

    const spinner = ora(`generating ${labels[app]} auth URL`).start();
    try {
      const url = await composio.getAuthUrl(app);
      spinner.succeed(`${labels[app]} — authorize here:`);
      console.log(chalk.cyan(`  ${url}`));
      console.log(chalk.dim("  open the URL above, authorize, then come back here"));

      const waitForAuth = await clack.confirm({
        message: `Done authorizing ${labels[app]}?`,
      });
      if (clack.isCancel(waitForAuth)) continue;

      const checkSpinner = ora("verifying connection").start();
      const connected = await composio.isConnected(app);
      if (connected) {
        checkSpinner.succeed(`${labels[app]} connected`);
      } else {
        checkSpinner.warn(`${labels[app]} not yet connected — you can retry later`);
      }
    } catch (err) {
      spinner.fail(`${labels[app]} setup failed: ${(err as Error).message}`);
    }
  }

  clack.outro(chalk.green("composio setup complete"));
}

// --- Doctor ---

async function runDoctor(): Promise<void> {
  clack.intro(chalk.cyan("koda doctor"));

  const workspace = getWorkspacePath();
  const workspaceEnv = readEnvFile(resolve(workspace, ".env"));
  const getEnv = (key: string) => process.env[key] ?? Bun.env[key] ?? workspaceEnv[key];
  let failures = 0;
  let warnings = 0;

  const checks: Array<{ label: string; run: () => Promise<{ status: "ok" | "warn" | "fail"; detail: string }> }> = [
    { label: "workspace", async run() {
      try { await access(workspace); return { status: "ok", detail: `workspace ${chalk.dim(workspace)}` }; }
      catch { return { status: "fail", detail: `workspace not found — run ${chalk.cyan("koda setup")}` }; }
    }},
    { label: "config.json", async run() {
      try { JSON.parse(await readFile(resolve(workspace, "config.json"), "utf-8")); return { status: "ok", detail: "config.json valid" }; }
      catch { return { status: "fail", detail: "config.json missing or invalid" }; }
    }},
    { label: ".env secrets", async run() {
      try { await access(resolve(workspace, ".env")); return { status: "ok", detail: ".env present" }; }
      catch { return { status: "fail", detail: ".env not found" }; }
    }},
    { label: ".env permissions", async run() {
      if (process.platform === "win32") return { status: "ok", detail: ".env permissions (skipped on Windows)" };
      try { const st = await stat(resolve(workspace, ".env")); const mode = st.mode & 0o777;
        if (mode & 0o044) return { status: "warn", detail: `.env readable by others (${mode.toString(8)}) — chmod 600` };
        return { status: "ok", detail: `.env permissions (${mode.toString(8)})` }; }
      catch { return { status: "ok", detail: ".env permissions (skipped)" }; }
    }},
    { label: "OpenRouter API", async run() {
      const key = getEnv("KODA_OPENROUTER_API_KEY");
      if (!key) return { status: "fail", detail: "OpenRouter API key not set" };
      try { const res = await fetch("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        return res.ok ? { status: "ok", detail: "OpenRouter reachable" } : { status: "fail", detail: `OpenRouter returned ${res.status}` }; }
      catch (e) { return { status: "fail", detail: `OpenRouter unreachable` }; }
    }},
    { label: "Supermemory", async run() {
      const key = getEnv("KODA_SUPERMEMORY_API_KEY");
      return key ? { status: "ok", detail: "Supermemory key present" } : { status: "warn", detail: "Supermemory key not set (optional — using local embeddings only)" };
    }},
    { label: "SQLite", async run() {
      try { const p = resolve(workspace, "koda.db.test"); await writeFile(p, "", "utf-8"); const { unlink } = await import("fs/promises"); await unlink(p);
        return { status: "ok", detail: "SQLite writable" }; }
      catch { return { status: "fail", detail: "SQLite not writable" }; }
    }},
    { label: "Composio", async run() {
      const key = getEnv("KODA_COMPOSIO_API_KEY");
      if (!key) return { status: "ok", detail: "Composio not configured (optional)" };
      try {
        const { createComposioClient } = await import("./composio.js");
        const composio = createComposioClient({ apiKey: key });
        let ownerId = "owner";
        try {
          const raw = JSON.parse(await readFile(resolve(workspace, "config.json"), "utf-8"));
          ownerId = raw?.owner?.id ?? raw?.telegram?.adminIds?.[0] ?? "owner";
        } catch {}
        const apps = [];
        if (await composio.isConnected("gmail")) apps.push("Gmail");
        if (await composio.isConnected("googlecalendar")) apps.push("Calendar");
        if (await composio.isConnected("github")) apps.push("GitHub");
        return apps.length > 0
          ? { status: "ok", detail: `Composio: ${apps.join(", ")} connected` }
          : { status: "warn", detail: "Composio key set but no apps connected — run koda setup composio" };
      } catch (e) {
        return { status: "warn", detail: `Composio: ${(e as Error).message}` };
      }
    }},
    { label: "Bun version", async run() {
      const v = typeof Bun !== "undefined" ? Bun.version : null;
      if (!v) return { status: "ok", detail: "Bun version check skipped" };
      return { status: "ok", detail: `Bun v${v}` };
    }},
  ];

  for (const check of checks) {
    const s = ora(`checking ${check.label}`).start();
    const result = await check.run();
    switch (result.status) {
      case "ok": s.succeed(result.detail); break;
      case "warn": s.warn(result.detail); warnings++; break;
      case "fail": s.fail(result.detail); failures++; break;
    }
  }

  console.log();
  const parts: string[] = [];
  const passed = checks.length - failures - warnings;
  if (passed > 0) parts.push(chalk.green(`${passed} passed`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warnings`));
  if (failures > 0) parts.push(chalk.red(`${failures} failed`));
  console.log(`  ${parts.join("  ·  ")}`);

  if (failures > 0) {
    clack.outro(`run ${chalk.cyan("koda setup")} to fix issues`);
    process.exit(1);
  } else {
    clack.outro("all good");
  }
}

// --- Upgrade ---

async function runUpgrade(): Promise<void> {
  clack.intro(chalk.cyan("koda upgrade"));
  console.log(`  current: v${VERSION}`);
  console.log(`  platform: ${process.platform}-${process.arch}`);

  const s = ora("checking GitHub releases").start();
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { s.fail(`GitHub API returned ${res.status}`); return; }
    const release = await res.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };
    const latest = release.tag_name.replace(/^v/, "");

    if (latest === VERSION) { s.succeed(`already on latest (v${VERSION})`); return; }
    s.succeed(`found v${latest}`);

    // Find platform asset
    const platformMap: Record<string, string> = {
      "linux-x64": "koda-linux-x64", "linux-arm64": "koda-linux-arm64",
      "darwin-x64": "koda-darwin-x64", "darwin-arm64": "koda-darwin-arm64",
      "win32-x64": "koda-windows-x64.exe",
    };
    const assetName = platformMap[`${process.platform}-${process.arch}`];
    if (!assetName) { console.log(chalk.red(`  unsupported platform: ${process.platform}-${process.arch}`)); return; }

    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) { console.log(chalk.red(`  no binary for this platform`)); return; }

    const dlSpinner = ora(`downloading ${assetName}`).start();
    const dlRes = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
    if (!dlRes.ok) { dlSpinner.fail(`download failed: ${dlRes.status}`); return; }

    const { tmpdir } = await import("os");
    const tempPath = resolve(tmpdir(), `koda-update-${Date.now()}`);
    await Bun.write(tempPath, await dlRes.arrayBuffer());
    dlSpinner.succeed("downloaded");

    const installSpinner = ora("installing update").start();
    const currentBinary = process.execPath;
    try {
      if (process.platform === "win32") {
        const { rename, unlink } = await import("fs/promises");
        try { await unlink(currentBinary + ".old"); } catch {}
        await rename(currentBinary, currentBinary + ".old");
        await rename(tempPath, currentBinary);
      } else {
        await chmod(tempPath, 0o755);
        const { rename } = await import("fs/promises");
        await rename(tempPath, currentBinary);
      }
      installSpinner.succeed(`installed v${latest}`);
    } catch (e) {
      installSpinner.fail("install failed — may need sudo");
    }

    clack.outro(chalk.green(`upgraded v${VERSION} → v${latest}`));
  } catch (e) {
    s.fail(`failed: ${e instanceof Error ? e.message : "unknown"}`);
  }
}

// --- Version ---

function runVersion(): void {
  console.log(`koda v${VERSION}`);
}

// --- Config get/set (v0.16) ---

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let target: unknown = obj;
  for (const key of parts) {
    if (target == null || typeof target !== "object") return undefined;
    target = (target as Record<string, unknown>)[key];
  }
  return target;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let target = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!target[key] || typeof target[key] !== "object") target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]!] = value;
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

async function runConfigCommand(action: string, args: string[]): Promise<void> {
  const workspace = getWorkspacePath();
  const configPath = resolve(workspace, "config.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    console.error("config.json not found — run koda setup first");
    return;
  }

  if (action === "get" && args[0]) {
    const val = getNestedValue(raw, args[0]);
    console.log(val === undefined ? "(not set)" : JSON.stringify(val, null, 2));
    return;
  }

  if (action === "set" && args[0] && args[1] !== undefined) {
    const value = parseValue(args.slice(1).join(" "));
    setNestedValue(raw, args[0], value);
    await writeFile(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    console.log(chalk.green(`set ${args[0]} = ${JSON.stringify(value)}`));
    return;
  }

  console.log("usage: koda config get <path> | koda config set <path> <value>");
  console.log("example: koda config set scheduler.timezone America/New_York");
}

// --- Router ---

export async function runCli(command: string, subcommand?: string): Promise<void> {
  switch (command) {
    case "setup":
      if (subcommand === "composio") { await runSetupComposio(); break; }
      await runSetup();
      break;
    case "doctor": await runDoctor(); break;
    case "upgrade": await runUpgrade(); break;
    case "version": runVersion(); break;
    case "config":
      await runConfigCommand(subcommand ?? "", process.argv.slice(4));
      break;
    default: console.log(`Unknown command: ${command}\nAvailable: setup, setup composio, doctor, upgrade, version, config`);
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  if (!command) {
    console.log("Usage: koda <setup|setup composio|doctor|upgrade|version|config>");
    process.exit(1);
  }

  runCli(command, process.argv[3]).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
