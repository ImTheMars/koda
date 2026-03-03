import chalk from "chalk";

let enabled = false;
let jsonMode = false;

export function enableDebug() { enabled = true; }
export function enableJsonLogging() { jsonMode = true; }

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
};

function colorTag(tag: string): string {
  const colorFn = TAG_COLORS[tag] ?? chalk.white;
  return `${chalk.dim("[")}${colorFn(tag)}${chalk.dim("]")}`;
}

const WARN_PREFIX = chalk.yellow("\u26A0");
const ERROR_PREFIX = chalk.red("\u2716");

function jsonLog(level: string, tag: string, msg: string) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, tag, msg }));
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

export const logInfo = (tag: string, msg: string) => {
  if (jsonMode) { jsonLog("info", tag, msg); return; }
  console.log(`${colorTag(tag)} ${msg}`);
};

export const logWarn = (tag: string, msg: string) => {
  if (jsonMode) { jsonLog("warn", tag, msg); return; }
  console.warn(`${WARN_PREFIX} ${colorTag(tag)} ${msg}`);
};

export const logError = (tag: string, msg: string, error?: unknown) => {
  const errStr = error instanceof Error ? error.message : error ? String(error) : "";
  const full = errStr ? `${msg}: ${errStr}` : msg;
  if (jsonMode) { jsonLog("error", tag, full); return; }
  console.error(`${ERROR_PREFIX} ${colorTag(tag)} ${full}`);
};
