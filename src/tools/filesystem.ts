/**
 * Filesystem tools — read/write/list files in workspace with security constraints.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { mkdirSync, readdirSync, realpathSync } from "fs";
import { dirname, resolve, normalize, relative, isAbsolute } from "path";

const BLOCKED_PATTERNS = [
  /(^|[\\/])\.env(\..+)?$/i,
  /credentials/i,
  /secrets?/i,
  /[\\/]\.git[\\/]config$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /id_rsa/i, /id_ed25519/i, /\.pem$/i, /\.key$/i,
];

function safePath(filePath: string, workspace: string, mode: "read" | "write"): string {
  if (filePath.includes("\0")) throw new Error("Access denied: invalid path");

  const normalized = normalize(filePath);
  const wsResolved = resolve(workspace);
  const resolved = isAbsolute(normalized) ? resolve(normalized) : resolve(wsResolved, normalized);

  let checkPath = resolved;
  if (mode === "read") {
    try { checkPath = realpathSync(resolved); } catch {}
  }

  const rel = relative(wsResolved, checkPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Access denied: path is outside workspace");

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(checkPath)) throw new Error("Access denied: sensitive file");
  }

  return resolved;
}

export function registerFilesystemTools(deps: { workspace: string }): ToolSet {
  const { workspace } = deps;

  const readFile = tool({
    description: "Read a file from the workspace directory.",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      try {
        const safe = safePath(path, workspace, "read");
        const file = Bun.file(safe);
        if (!(await file.exists())) return { success: false, error: "File not found" };
        return { success: true, content: await file.text() };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Read failed" };
      }
    },
  });

  const writeFile = tool({
    description: "Write or overwrite a file in the workspace.",
    inputSchema: z.object({
      path: z.string(),
      content: z.string().max(1_000_000, "Content exceeds 1MB limit"),
    }),
    execute: async ({ path, content }) => {
      try {
        const safe = safePath(path, workspace, "write");
        mkdirSync(dirname(safe), { recursive: true });
        await Bun.write(safe, content);
        return { success: true, path: safe };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Write failed" };
      }
    },
  });

  const listFiles = tool({
    description: "List files in a workspace directory.",
    inputSchema: z.object({ path: z.string().optional().default(".") }),
    execute: async ({ path }) => {
      try {
        const safe = safePath(path, workspace, "read");
        const entries = readdirSync(safe, { withFileTypes: true });
        return {
          success: true,
          files: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" })),
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "List failed" };
      }
    },
  });

  return { readFile, writeFile, listFiles };
}
