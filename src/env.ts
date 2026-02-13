/**
 * Lightweight .env helpers.
 *
 * Avoids adding an external dotenv dependency and supports loading
 * multiple files with predictable precedence.
 */

import { readFileSync } from "fs";

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = normalized.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    value = value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");

    out[key] = value;
  }

  return out;
}

export function readEnvFile(filePath: string): Record<string, string> {
  try {
    const text = readFileSync(filePath, "utf-8");
    return parseEnvFile(text);
  } catch {
    return {};
  }
}

export function loadEnvFromFiles(paths: string[], override = false, protectedKeys?: Set<string>): void {
  for (const path of paths) {
    const vars = readEnvFile(path);
    for (const [key, value] of Object.entries(vars)) {
      if (protectedKeys?.has(key)) continue;
      if (override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
