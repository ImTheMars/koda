let enabled = false;
let jsonMode = false;

export function enableDebug() { enabled = true; }
export function enableJsonLogging() { jsonMode = true; }

// Check env at import time
if (process.env.LOG_FORMAT === "json") jsonMode = true;

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
  console.log(`[${tag}]`, ...args);
};

export const logInfo = (tag: string, msg: string) => {
  if (jsonMode) { jsonLog("info", tag, msg); return; }
  console.log(`[${tag}] ${msg}`);
};

export const logWarn = (tag: string, msg: string) => {
  if (jsonMode) { jsonLog("warn", tag, msg); return; }
  console.warn(`[${tag}] ${msg}`);
};

export const logError = (tag: string, msg: string, error?: unknown) => {
  const errStr = error instanceof Error ? error.message : error ? String(error) : "";
  const full = errStr ? `${msg}: ${errStr}` : msg;
  if (jsonMode) { jsonLog("error", tag, full); return; }
  console.error(`[${tag}] ${full}`);
};
