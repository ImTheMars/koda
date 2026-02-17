/**
 * Exec tools — local Bun.spawn() with auto-background after 10s timeout.
 *
 * Replaces E2B sandbox. Tools: exec (foreground with auto-bg), process (poll/log/kill).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

interface ProcessEntry {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: string;
  stderr: string;
  startedAt: number;
  exitCode: number | null;
  done: boolean;
}

const processes = new Map<string, ProcessEntry>();
const processOrder: string[] = [];

const BLOCKED_COMMANDS = [
  /^\s*rm\s+-rf\s+\//i,
  /^\s*sudo\b/i,
  /^\s*shutdown\b/i,
  /^\s*reboot\b/i,
  /^\s*mkfs\b/i,
  /^\s*dd\s+if=/i,
  /^\s*:\(\)\{.*\}/,
  /^\s*(del|erase)\s+/i,
  /^\s*format\b/i,
];

const AUTO_BG_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 50_000;
const MAX_ENTRIES = 50;

function isBlocked(cmd: string): boolean {
  return BLOCKED_COMMANDS.some((p) => p.test(cmd.trim()));
}

function appendBuffered(existing: string, chunk: string): string {
  const next = existing + chunk;
  return next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next;
}

function cleanupFinishedProcesses(): void {
  while (processOrder.length > MAX_ENTRIES) {
    const oldest = processOrder.shift();
    if (!oldest) break;
    const entry = processes.get(oldest);
    if (entry?.done) {
      processes.delete(oldest);
      continue;
    }
    processOrder.push(oldest);
    break;
  }
}

export function registerExecTools(deps: { workspace: string }): ToolSet {
  const { workspace } = deps;

  const exec = tool({
    description: "Execute a shell command in the workspace. Auto-backgrounds after 10s. Returns stdout/stderr or a session ID for long-running processes.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
      if (isBlocked(command)) {
        return { success: false, error: "Command is blocked for safety." };
      }

      const sessionId = crypto.randomUUID().slice(0, 8);
      const entry: ProcessEntry = {
        proc: null as any,
        stdout: "",
        stderr: "",
        startedAt: Date.now(),
        exitCode: null,
        done: false,
      };

      try {
        const shellCommand = process.platform === "win32"
          ? ["cmd.exe", "/d", "/s", "/c", command]
          : ["sh", "-lc", command];

        const proc = Bun.spawn(shellCommand, {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
        entry.proc = proc;
        processes.set(sessionId, entry);
        processOrder.push(sessionId);
        cleanupFinishedProcesses();

        // Collect output
        const stdoutReader = (async () => {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            entry.stdout = appendBuffered(entry.stdout, decoder.decode(value, { stream: true }));
          }
        })();

        const stderrReader = (async () => {
          const reader = proc.stderr.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            entry.stderr = appendBuffered(entry.stderr, decoder.decode(value, { stream: true }));
          }
        })();

        // Wait with auto-background timeout
        const exitPromise = proc.exited.then((code) => {
          entry.exitCode = code;
          entry.done = true;
          return code;
        });

        const timeoutPromise = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), AUTO_BG_TIMEOUT_MS));
        const race = await Promise.race([exitPromise, timeoutPromise]);

        if (race === "timeout") {
          return {
            success: true,
            backgrounded: true,
            sessionId,
            message: `Command still running after ${AUTO_BG_TIMEOUT_MS / 1000}s — use the process tool with sessionId "${sessionId}" to check output.`,
            stdoutSoFar: entry.stdout.slice(-2000),
          };
        }

        // Completed within timeout
        await Promise.all([stdoutReader, stderrReader]);

        return {
          success: entry.exitCode === 0,
          exitCode: entry.exitCode,
          stdout: entry.stdout.slice(-8000),
          stderr: entry.stderr.slice(-2000),
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Exec failed" };
      }
    },
  });

  const processCmd = tool({
    description: "Manage a background process: poll for output, get logs, or kill it.",
    inputSchema: z.object({
      sessionId: z.string().describe("Session ID from exec"),
      action: z.enum(["poll", "log", "kill"]).describe("Action to take"),
    }),
    execute: async ({ sessionId, action }) => {
      const entry = processes.get(sessionId);
      if (!entry) return { success: false, error: "Session not found" };

      if (action === "kill") {
        entry.proc.kill();
        entry.done = true;
        processes.delete(sessionId);
        const idx = processOrder.indexOf(sessionId);
        if (idx !== -1) processOrder.splice(idx, 1);
        return { success: true, message: "Process killed" };
      }

      if (action === "log") {
        return {
          success: true,
          done: entry.done,
          exitCode: entry.exitCode,
          stdout: entry.stdout.slice(-8000),
          stderr: entry.stderr.slice(-2000),
          runningMs: Date.now() - entry.startedAt,
        };
      }

      // poll
      return {
        success: true,
        done: entry.done,
        exitCode: entry.exitCode,
        stdoutTail: entry.stdout.slice(-2000),
        runningMs: Date.now() - entry.startedAt,
      };
    },
  });

  return { exec, process: processCmd };
}
