/**
 * File sending tool — queues files to be sent back to the user via the channel.
 *
 * Files are collected in ToolRuntimeContext.pendingFiles and sent by the
 * channel layer after the agent completes.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { existsSync, lstatSync } from "fs";
import { basename } from "path";
import { addPendingFile } from "./index.js";
import { safePath } from "../security.js";

export function registerFileTools(deps: { workspace: string }): ToolSet {
  const sendFile = tool({
    description: "Send a file from the workspace to the user. The file will be delivered as a document attachment in the chat. Use this to share files, exports, or generated content.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to workspace"),
      caption: z.string().optional().describe("Optional caption for the file"),
    }),
    execute: async ({ path, caption }) => {
      const resolved = safePath(path, deps.workspace, "read");

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
