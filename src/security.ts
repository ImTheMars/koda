/**
 * Shared security utilities — path validation, sanitization, and redaction.
 *
 * Single source of truth for filesystem safety checks used by
 * tools/filesystem.ts and tools/files.ts.
 */

import { existsSync, lstatSync, realpathSync } from "fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "path";
import { logWarn } from "./log.js";

/** Patterns that must never be read or written by tools. */
export const BLOCKED_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\..+)?$/i,
  /credentials/i,
  /secrets?/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /[\\/]\.git[\\/]config$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /id_rsa/i, /id_ed25519/i, /\.pem$/i, /\.key$/i,
];

/**
 * Resolve and validate a user-provided file path against the workspace.
 *
 * - Blocks null bytes, paths outside workspace, symlinks (write mode), and sensitive files.
 * - Read mode: follows symlinks then validates the real path.
 * - Write mode: validates nearest existing parent via realpath, rejects symlink targets.
 */
export function safePath(filePath: string, workspace: string, mode: "read" | "write"): string {
  if (filePath.includes("\0")) throw new Error("Access denied: invalid path");

  const normalized = normalize(filePath);
  const wsResolved = realpathSync(resolve(workspace));
  const resolved = isAbsolute(normalized) ? resolve(normalized) : resolve(wsResolved, normalized);

  const ensureInWorkspace = (checkPath: string): void => {
    const rel = relative(wsResolved, checkPath);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Access denied: path is outside workspace");
  };

  const checkSensitive = (checkPath: string): void => {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(checkPath)) throw new Error("Access denied: sensitive file");
    }
  };

  let checkPath = resolved;
  if (mode === "read") {
    try {
      checkPath = realpathSync(resolved);
    } catch (err) {
      logWarn("security", `realpath failed for "${resolved}": ${(err as Error).message}`);
    }
    ensureInWorkspace(checkPath);
    checkSensitive(checkPath);
    return resolved;
  }

  // Write-mode symlink guard: validate nearest existing parent via realpath.
  let existingParent = dirname(resolved);
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) throw new Error("Access denied: invalid path");
    existingParent = parent;
  }

  const parentReal = realpathSync(existingParent);
  ensureInWorkspace(parentReal);

  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Access denied: symlink writes are not allowed");
  }

  checkSensitive(resolved);

  return resolved;
}

/**
 * Escape user-provided text before interpolating into a system prompt.
 * Prevents injection of XML-like tags that could confuse the model.
 */
export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Keys whose values should be fully redacted in logs. */
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /auth/i,
  /credential/i,
  /bearer/i,
];

/**
 * Redact sensitive values from tool arguments before logging.
 * Returns a JSON string safe for log output.
 */
export function redactSensitiveArgs(args: Record<string, unknown>, maxLen = 500): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 200) {
      redacted[key] = value.slice(0, 200) + "...";
    } else {
      redacted[key] = value;
    }
  }
  return JSON.stringify(redacted).slice(0, maxLen);
}
