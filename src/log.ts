import chalk from "chalk";

let enabled = false;
let jsonMode = false;

export function enableDebug() { enabled = true; }
export function enableJsonLogging() { jsonMode = true; }
export function isDebug(): boolean { return enabled; }

// Check env at import time
if (process.env.LOG_FORMAT === "json") jsonMode = true;

const TAG_COLORS: Record<string, (s: string) => string> = {
  boot: chalk.cyan,       shutdown: chalk.cyan,     context: chalk.cyan,
  agent: chalk.green,     spawn: chalk.green,       soul: chalk.green,
  telegram: chalk.magenta, msg: chalk.magenta,      webhook: chalk.magenta, http: chalk.magenta,
  db: chalk.blue,         config: chalk.blue,
  memory: chalk.yellow,   summarize: chalk.yellow,
  mcp: chalk.blueBright,  tools: chalk.blueBright,  sandbox: chalk.blueBright, skills: chalk.blueBright, composio: chalk.blueBright,
  proactive: chalk.greenBright, reminder: chalk.greenBright,
  backup: chalk.gray,     gc: chalk.gray,           "railway-monitor": chalk.gray,
  security: chalk.red,
  debug: chalk.dim,
  timing: chalk.dim,
  router: chalk.green,
};

function colorTag(tag: string): string {
  const colorFn = TAG_COLORS[tag] ?? chalk.white;
  return `${chalk.dim("[")}${colorFn(tag)}${chalk.dim("]")}`;
}

const WARN_PREFIX = chalk.yellow("\u26A0");
const ERROR_PREFIX = chalk.red("\u2716");
const DEBUG_PREFIX = chalk.dim("\u2699");

function jsonLog(level: string, tag: string, msg: string, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, tag, msg, ...extra }));
}

export const log = (tag: string, ...args: unknown[]) => {
  if (!enabled) return;
  if (jsonMode) {
    const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    jsonLog("debug", tag, msg);
    return;
  }
  console.log(colorTag(tag), ...args);
};

/** Debug-only log — only fires when features.debug is true. Accepts structured data. */
export const logDebug = (tag: string, msg: string, data?: Record<string, unknown>) => {
  if (!enabled) return;
  if (jsonMode) {
    jsonLog("debug", tag, msg, data);
    return;
  }
  if (data && Object.keys(data).length > 0) {
    const formatted = Object.entries(data)
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return `  ${chalk.dim(k + ":")} ${val}`;
      })
      .join("\n");
    console.log(`${DEBUG_PREFIX} ${colorTag(tag)} ${msg}\n${formatted}`);
  } else {
    console.log(`${DEBUG_PREFIX} ${colorTag(tag)} ${msg}`);
  }
};

export const logInfo = (tag: string, msg: string) => {
  if (jsonMode) { jsonLog("info", tag, msg); return; }
  console.log(`${colorTag(tag)} ${msg}`);
};

export const logWarn = (tag: string, msg: string) => {
  if (jsonMode) { jsonLog("warn", tag, msg); return; }
  console.warn(`${WARN_PREFIX} ${colorTag(tag)} ${msg}`);
};

export const logError = (tag: string, msg: string, error?: unknown) => {
  const errStr = error instanceof Error
    ? (enabled ? error.stack ?? error.message : error.message)
    : error ? String(error) : "";
  const full = errStr ? `${msg}: ${errStr}` : msg;
  if (jsonMode) { jsonLog("error", tag, full); return; }
  console.error(`${ERROR_PREFIX} ${colorTag(tag)} ${full}`);
};

// ---------------------------------------------------------------------------
// Timing utility — for measuring durations in debug mode
// ---------------------------------------------------------------------------

export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

export const logTiming = (tag: string, label: string, elapsedMs: number) => {
  if (!enabled) return;
  const color = elapsedMs > 5000 ? chalk.yellow : elapsedMs > 10000 ? chalk.red : chalk.dim;
  if (jsonMode) {
    jsonLog("debug", tag, `${label} ${elapsedMs}ms`, { elapsedMs });
    return;
  }
  console.log(`${DEBUG_PREFIX} ${colorTag(tag)} ${label} ${color(`${elapsedMs}ms`)}`);
};
