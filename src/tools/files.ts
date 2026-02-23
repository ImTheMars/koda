/**
 * File sending tool — queues files to be sent back to the user via the channel.
 *
 * Files are collected in ToolRuntimeContext.pendingFiles and sent by the
 * channel layer after the agent completes.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { existsSync, realpathSync, lstatSync } from "fs";
import { resolve, normalize, relative, isAbsolute, basename } from "path";
import { addPendingFile } from "./index.js";

const BLOCKED_PATTERNS = [
  /(^|[\\/])\.env(\..+)?$/i,
  /credentials/i,
  /secrets?/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /[\\/]\.git[\\/]config$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /id_rsa/i, /id_ed25519/i, /\.pem$/i, /\.key$/i,
];

function validatePath(filePath: string, workspace: string): string {
  if (filePath.includes("\0")) throw new Error("Access denied: invalid path");

  const normalized = normalize(filePath);
  const wsResolved = realpathSync(resolve(workspace));
  const resolved = isAbsolute(normalized) ? resolve(normalized) : resolve(wsResolved, normalized);

  let checkPath = resolved;
  try { checkPath = realpathSync(resolved); } catch {}

  const rel = relative(wsResolved, checkPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Access denied: path is outside workspace");

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(checkPath)) throw new Error("Access denied: sensitive file");
  }

  return resolved;
}

export function registerFileTools(deps: { workspace: string }): ToolSet {
  const sendFile = tool({
    description: "Send a file from the workspace to the user. The file will be delivered as a document attachment in the chat. Use this to share files, exports, or generated content.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to workspace"),
      caption: z.string().optional().describe("Optional caption for the file"),
    }),
    execute: async ({ path, caption }) => {
      const resolved = validatePath(path, deps.workspace);

      if (!existsSync(resolved)) {
        return { error: `File not found: ${path}` };
      }

      const stats = lstatSync(resolved);
      if (!stats.isFile()) {
        return { error: "Path is not a file" };
      }

      // 20MB Telegram limit
      if (stats.size > 20 * 1024 * 1024) {
        return { error: "File too large (max 20MB)" };
      }

      addPendingFile(resolved, caption);

      return {
        queued: true,
        filename: basename(resolved),
        size: stats.size,
        note: "File will be sent after this response.",
      };
    },
  });

  return { sendFile };
}
