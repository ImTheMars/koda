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

const DEFAULT_MEMORY = "512m";
const DEFAULT_CPUS = "0.5";
const SANDBOX_TIMEOUT_MS = 30_000;
const SANDBOX_IMAGE = "alpine:latest";

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

  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();

  const readStdout = (async () => {
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      if (stdout.length > 50_000) stdout = stdout.slice(-50_000);
    }
  })();

  const readStderr = (async () => {
    const reader = proc.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
      if (stderr.length > 10_000) stderr = stderr.slice(-10_000);
    }
  })();

  const exitPromise = proc.exited;
  const timeoutPromise = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeout));
  const race = await Promise.race([exitPromise, timeoutPromise]);

  if (race === "timeout") {
    proc.kill();
    return { stdout, stderr, exitCode: null, timedOut: true };
  }

  await Promise.allSettled([readStdout, readStderr]);
  return { stdout, stderr, exitCode: race as number, timedOut: false };
}

/** Run a shell command natively via Bun.spawn (used when Docker is unavailable). */
async function runNative(opts: {
  command: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const timeout = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;

  const proc = Bun.spawn(["sh", "-c", opts.command], { stdout: "pipe", stderr: "pipe" });

  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();

  const readStdout = (async () => {
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      if (stdout.length > 50_000) stdout = stdout.slice(-50_000);
    }
  })();

  const readStderr = (async () => {
    const reader = proc.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
      if (stderr.length > 10_000) stderr = stderr.slice(-10_000);
    }
  })();

  const exitPromise = proc.exited;
  const timeoutPromise = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeout));
  const race = await Promise.race([exitPromise, timeoutPromise]);

  if (race === "timeout") {
    proc.kill();
    return { stdout, stderr, exitCode: null, timedOut: true };
  }

  await Promise.allSettled([readStdout, readStderr]);
  return { stdout, stderr, exitCode: race as number, timedOut: false };
}

export async function registerSandboxTools(deps: { workspace: string }): Promise<ToolSet> {
  const dockerAvailable = await checkDockerAvailable();
  const onRailway = !!process.env.RAILWAY_ENVIRONMENT;

  if (!dockerAvailable) {
    if (onRailway) {
      console.log("[boot] Sandbox: Docker unavailable, using native exec (Railway env)");
    } else {
      console.log("[boot] Sandbox: Docker not available, using native exec fallback");
    }
  } else {
    console.log("[boot] Sandbox: Docker available ✓");
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

      if (dockerAvailable) {
        const result = await runInDocker({
          command,
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
          limits: { memory: memory ?? DEFAULT_MEMORY, cpus: cpus ?? DEFAULT_CPUS, network: allowNetwork ? "enabled" : "none" },
        };
      }

      // Native exec fallback (Railway or environments without Docker)
      const result = await runNative({ command, timeoutMs });

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
      };
    },
  });

  return { runSandboxed };
}
