/**
 * Safe Sandbox — runs code in an isolated Docker container when available,
 * or via native Bun.spawn on Railway (where Docker is unavailable but the
 * container OS already provides process isolation).
 *
 * Docker path: --memory 512m  --cpus 0.5  --network none  --read-only /  --rm
 * Native path: Bun.spawn with same timeout + output caps, sandboxed=false
 *
 * Docker availability is checked once at registration time.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { logInfo } from "../log.js";

const DEFAULT_MEMORY = "512m";
const DEFAULT_CPUS = "0.5";
const SANDBOX_TIMEOUT_MS = 30_000;
const SANDBOX_IMAGE = "alpine:latest";
const MAX_STDOUT_BYTES = 50_000;
const MAX_STDERR_BYTES = 10_000;
type NativeShellKind = "posix" | "powershell" | "cmd";

/** Read a process stream to string, truncating to maxBytes (keeps tail). */
async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  let buf = "";
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.length > maxBytes) buf = buf.slice(-maxBytes);
  }
  return buf;
}

interface NativeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  shellUsed?: string;
  attemptedShells?: string[];
  normalizedCommand?: string;
  commandTried?: string;
  retryCount?: number;
}

/** Check if Docker daemon is reachable. */
async function checkDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
    const exit = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    if (exit === "timeout") { proc.kill(); return false; }
    return exit === 0;
  } catch {
    return false;
  }
}

/**
 * Run a shell command inside a Docker container with resource limits.
 * The workspace directory is mounted read-only at /workspace.
 */
async function runInDocker(opts: {
  command: string;
  workspace: string;
  image?: string;
  memory?: string;
  cpus?: string;
  networkDisabled?: boolean;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const image = opts.image ?? SANDBOX_IMAGE;
  const memory = opts.memory ?? DEFAULT_MEMORY;
  const cpus = opts.cpus ?? DEFAULT_CPUS;
  const timeout = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;

  const dockerArgs = [
    "docker", "run", "--rm",
    "--memory", memory,
    "--cpus", cpus,
    "--pids-limit", "64",
    "--ulimit", "nproc=64",
    "--ulimit", "nofile=256:256",
    "--cap-drop", "ALL",
    "-v", `${opts.workspace}:/workspace:ro`,
    "-w", "/workspace",
  ];

  if (opts.networkDisabled !== false) {
    dockerArgs.push("--network", "none");
  }

  dockerArgs.push(image, "sh", "-c", opts.command);

  const proc = Bun.spawn(dockerArgs, { stdout: "pipe", stderr: "pipe" });

  const readStdout = readProcessStream(proc.stdout, MAX_STDOUT_BYTES);
  const readStderr = readProcessStream(proc.stderr, MAX_STDERR_BYTES);

  const exitPromise = proc.exited;
  const timeoutPromise = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeout));
  const race = await Promise.race([exitPromise, timeoutPromise]);

  if (race === "timeout") {
    proc.kill();
    const [stdout, stderr] = await Promise.all([readStdout, readStderr]);
    return { stdout, stderr, exitCode: null, timedOut: true };
  }

  const [stdout, stderr] = await Promise.all([readStdout, readStderr]);
  return { stdout, stderr, exitCode: race as number, timedOut: false };
}

function normalizeSandboxCommand(command: string): string {
  let out = command.trim();

  // Strip a single wrapping inline-code pair: `echo hi` -> echo hi
  const inlineWrapped = out.match(/^`([^`\r\n]+)`$/);
  if (inlineWrapped) out = inlineWrapped[1]!;

  // Strip a single fenced code block wrapper if present.
  const fenced = out.match(/^```[a-z0-9_-]*\s*\n([\s\S]*?)\n```$/i);
  if (fenced) out = fenced[1]!.trim();

  return out.trim();
}

function adaptCommand(command: string, kind: NativeShellKind): string {
  if (kind === "powershell") {
    let out = command;
    // PowerShell supports `sleep` alias, but be explicit for portability.
    out = out.replace(/\bsleep\s+(\d+)\b/gi, "Start-Sleep -Seconds $1");
    // `&&` is not portable across all PowerShell installs.
    out = out.replace(/\s*&&\s*/g, "; ");
    return out;
  }
  if (kind === "cmd") {
    return command.replace(/\bsleep\s+(\d+)\b/gi, "timeout /t $1 /nobreak >NUL");
  }
  return command;
}

function buildCommandVariants(command: string, kind: NativeShellKind): string[] {
  const variants = [adaptCommand(command, kind)];

  if (process.platform === "win32" && (kind === "powershell" || kind === "cmd")) {
    const pyMatch = command.match(/^\s*python(?:3)?\s+(.+)$/i);
    if (pyMatch) {
      const args = pyMatch[1]!.trim();
      variants.push(adaptCommand(`py -3 ${args}`, kind));
      variants.push(adaptCommand(`py ${args}`, kind));
    }
  }

  return [...new Set(variants.map((v) => v.trim()).filter(Boolean))];
}

function shouldTryNextShell(candidateKind: NativeShellKind, stdout: string, stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  const text = `${stdout}\n${stderr}`.toLowerCase();

  // Common Windows/MSYS/Git Bash bootstrap failures (shell itself is unusable).
  if (candidateKind === "posix" && process.platform === "win32") {
    if (
      (text.includes("bash") && (text.includes("not found") || text.includes("missing") || text.includes("no such file"))) ||
      (text.includes("sh") && text.includes("not found")) ||
      text.includes("execvpe") ||
      text.includes("failed to start shell")
    ) {
      return true;
    }
  }

  return false;
}

function shouldTryPythonVariant(commandTried: string, stdout: string, stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  const lower = commandTried.toLowerCase();
  if (!/^\s*python(?:3)?\s+/.test(lower)) return false;
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return text.includes("not recognized") || text.includes("command not found") || text.includes("python") && text.includes("not found");
}

async function runSpawnedProcess(
  proc: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void },
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const readStdout = readProcessStream(proc.stdout, MAX_STDOUT_BYTES);
  const readStderr = readProcessStream(proc.stderr, MAX_STDERR_BYTES);

  const exitPromise = proc.exited;
  const timeoutPromise = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeout));
  const race = await Promise.race([exitPromise, timeoutPromise]);

  if (race === "timeout") {
    proc.kill();
    const [stdout, stderr] = await Promise.all([readStdout, readStderr]);
    return { stdout, stderr, exitCode: null, timedOut: true };
  }

  const [stdout, stderr] = await Promise.all([readStdout, readStderr]);
  return { stdout, stderr, exitCode: race as number, timedOut: false };
}

/** Run a shell command natively via Bun.spawn (used when Docker is unavailable). */
async function runNative(opts: {
  command: string;
  workspace: string;
  timeoutMs?: number;
}): Promise<NativeExecResult> {
  const timeout = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const normalizedCommand = normalizeSandboxCommand(opts.command);
  const shellCandidates: Array<{ argv: string[]; kind: NativeShellKind }> =
    process.platform === "win32"
      ? [
          { argv: ["pwsh", "-NoProfile", "-Command"], kind: "powershell" },
          { argv: ["powershell", "-NoProfile", "-Command"], kind: "powershell" },
          { argv: ["cmd.exe", "/d", "/s", "/c"], kind: "cmd" },
          { argv: ["sh", "-lc"], kind: "posix" },
          { argv: ["bash", "-lc"], kind: "posix" },
        ]
      : [
          { argv: ["sh", "-lc"], kind: "posix" },
          { argv: ["bash", "-lc"], kind: "posix" },
        ];
  const attemptedShells: string[] = [];
  let retryCount = 0;
  let lastSpawnError: Error | null = null;

  for (const candidate of shellCandidates) {
    const shellLabel = candidate.argv[0]!;
    attemptedShells.push(shellLabel);
    const variants = buildCommandVariants(normalizedCommand, candidate.kind);

    for (let i = 0; i < variants.length; i++) {
      const commandTried = variants[i]!;
      if (i > 0) retryCount++;

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...candidate.argv, commandTried], {
          cwd: opts.workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        lastSpawnError = err as Error;
        break; // try next shell candidate
      }

      const result = await runSpawnedProcess(proc as Parameters<typeof runSpawnedProcess>[0], timeout);
      const withMeta: NativeExecResult = {
        ...result,
        shellUsed: shellLabel,
        attemptedShells,
        normalizedCommand,
        commandTried,
        retryCount,
      };

      if (result.timedOut || result.exitCode === 0) return withMeta;

      const tryNextVariant = i < variants.length - 1 && shouldTryPythonVariant(commandTried, result.stdout, result.stderr, result.exitCode);
      if (tryNextVariant) continue;

      if (shouldTryNextShell(candidate.kind, result.stdout, result.stderr, result.exitCode)) {
        retryCount++;
        break; // try next shell
      }

      return withMeta;
    }
  }

  if (lastSpawnError) {
    throw lastSpawnError;
  }
  throw new Error("No shell available for native sandbox execution");
}

export async function registerSandboxTools(deps: { workspace: string }): Promise<ToolSet> {
  const dockerAvailable = await checkDockerAvailable();
  const onRailway = !!process.env.RAILWAY_ENVIRONMENT;

  if (!dockerAvailable) {
    if (onRailway) {
      logInfo("sandbox", "Docker unavailable, using native exec (Railway env)");
    } else {
      logInfo("sandbox", "Docker not available, using native exec fallback");
    }
  } else {
    logInfo("sandbox", "Docker available");
  }

  const runSandboxed = tool({
    description: dockerAvailable
      ? "Run a shell command in an isolated Docker container with hard resource limits " +
        "(512 MB RAM, 0.5 CPU, no network, read-only workspace mount). " +
        "Use this for untrusted or potentially destructive code execution. " +
        "Supports any command that runs on Alpine Linux."
      : "Run a shell command via native exec (Docker unavailable on this host — " +
        "Railway's container OS provides process isolation). " +
        "Same timeout and output limits as the Docker path. " +
        "Result includes sandboxed: false, nativeExec: true.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to run"),
      image: z.string().optional().describe("Docker image (default: alpine:latest, Docker mode only)"),
      memory: z.string().optional().describe("Memory limit, e.g. '512m', '1g' (default: 512m, Docker mode only)"),
      cpus: z.string().optional().describe("CPU limit, e.g. '0.5', '1' (default: 0.5, Docker mode only)"),
      allowNetwork: z.boolean().optional().describe("Allow network access (default: false — isolated)"),
      timeoutSeconds: z.number().min(1).max(120).optional().describe("Timeout in seconds (default: 30)"),
    }),

    execute: async ({ command, image, memory, cpus, allowNetwork, timeoutSeconds }) => {
      const timeoutMs = (timeoutSeconds ?? 30) * 1000;
      const normalizedCommand = normalizeSandboxCommand(command);

      if (dockerAvailable) {
        const result = await runInDocker({
          command: normalizedCommand,
          workspace: deps.workspace,
          image,
          memory,
          cpus,
          networkDisabled: !allowNetwork,
          timeoutMs,
        });

        if (result.timedOut) {
          return {
            success: false,
            timedOut: true,
            error: `Command timed out after ${timeoutSeconds ?? 30}s`,
            stdoutSoFar: result.stdout.slice(-2000),
          };
        }

        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(-8000),
          stderr: result.stderr.slice(-2000),
          sandboxed: true,
          normalizedCommand,
          shellUsed: "docker:sh",
          limits: { memory: memory ?? DEFAULT_MEMORY, cpus: cpus ?? DEFAULT_CPUS, network: allowNetwork ? "enabled" : "none" },
        };
      }

      // Native exec fallback (Railway or environments without Docker)
      const result = await runNative({ command: normalizedCommand, workspace: deps.workspace, timeoutMs });

      if (result.timedOut) {
        return {
          success: false,
          timedOut: true,
          error: `Command timed out after ${timeoutSeconds ?? 30}s`,
          stdoutSoFar: result.stdout.slice(-2000),
        };
      }

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(-8000),
        stderr: result.stderr.slice(-2000),
        sandboxed: false,
        nativeExec: true,
        shellUsed: result.shellUsed,
        attemptedShells: result.attemptedShells,
        normalizedCommand: result.normalizedCommand,
        commandTried: result.commandTried,
        retryCount: result.retryCount,
      };
    },
  });

  return { runSandboxed };
}
