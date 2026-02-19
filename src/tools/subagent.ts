/**
 * Sub-agent tool — lets the main agent delegate focused tasks to isolated child agents.
 *
 * spawnAgent runs a child createAgent() with:
 *   - filtered toolset (no recursion, no side-effectful tools)
 *   - isolated session key (no shared history, no-op memory ingest)
 *   - hard maxSteps cap (config-driven, default 10, capped at 20)
 *   - configurable timeout via Promise.race (default 90 s)
 *
 * Parallelism is free: the AI SDK runs multiple tool calls in a single step concurrently.
 * Registration happens post-boot in index.ts (after runAgent exists) to avoid circular deps.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createAgent, type AgentDeps } from "../agent.js";

// Tools that sub-agents are never allowed to use, regardless of allowlist.
const ALWAYS_BLOCKED = new Set([
  "spawnAgent",        // no recursion
  "setReminder",       // no scheduling side effects
  "listReminders",     // no scheduling side effects
  "deleteReminder",    // no scheduling side effects
  "runCode",           // no arbitrary code execution inside a sub-agent
  "skillShop",         // no installs inside a sub-agent
  "soul",              // soul is a main-agent concern
]);

// Default allowlist when the caller doesn't specify one.
const DEFAULT_ALLOWED = new Set([
  "webSearch",
  "extractUrl",
  "remember",
  "recall",
  "readFile",
  "listFiles",
  "skills",
  "systemStatus",
]);

// --- Spawn log ring buffer (exported for dashboard) ---

export interface SpawnEntry {
  name: string;
  status: "done" | "error" | "timeout";
  toolsUsed: string[];
  cost: number;
  durationMs: number;
  timestamp: string;
}

const SPAWN_LOG_MAX = 50;
const spawnLog: SpawnEntry[] = [];

export function getSpawnLog(): SpawnEntry[] {
  return [...spawnLog];
}

function appendSpawnLog(entry: SpawnEntry): void {
  spawnLog.push(entry);
  if (spawnLog.length > SPAWN_LOG_MAX) spawnLog.shift();
}

// ---

function buildSubToolset(masterTools: ToolSet, allowlist: Set<string>): ToolSet {
  return Object.fromEntries(
    Object.entries(masterTools).filter(([name]) => allowlist.has(name) && !ALWAYS_BLOCKED.has(name)),
  );
}

function freshSessionKey(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `subagent_${Date.now()}_${rand}`;
}

export function registerSubAgentTools(deps: {
  agentDeps: AgentDeps;
  masterTools: ToolSet;
  timeoutMs?: number;
  maxStepsCap?: number;
}): ToolSet {
  const { agentDeps, masterTools } = deps;
  const timeoutMs = deps.timeoutMs ?? 90_000;
  const maxStepsCap = deps.maxStepsCap ?? 10;

  const spawnAgent = tool({
    description:
      "Delegate a focused sub-task to an isolated child agent. " +
      "The child has its own tool subset, isolated memory, and a hard step limit. " +
      "Use this for parallel research, summarization, or any well-scoped sub-task. " +
      "Multiple spawnAgent calls in one step run concurrently — use this for parallel work.",
    inputSchema: z.object({
      name: z.string().describe("Short label for this sub-agent, e.g. 'ResearchAgent' or 'SummaryAgent'"),
      task: z.string().describe("The complete, self-contained task description for the sub-agent"),
      tools: z.array(z.string()).optional().describe(
        `Allowlist of tool names the sub-agent can use. Defaults to: ${[...DEFAULT_ALLOWED].join(", ")}`,
      ),
      maxSteps: z.number().min(1).max(maxStepsCap).optional().default(5).describe(`Max steps before the sub-agent stops (1–${maxStepsCap}, default 5)`),
    }),

    execute: async ({ name, task, tools: toolAllowlist, maxSteps }) => {
      const allowed = toolAllowlist ? new Set(toolAllowlist) : DEFAULT_ALLOWED;
      const subTools = buildSubToolset(masterTools, allowed);
      const sessionKey = freshSessionKey();
      const startMs = Date.now();

      console.log(`[spawn] → ${name}  ×${maxSteps} steps  [${Object.keys(subTools).join(", ")}]`);

      // Sub-agent deps: same profile/config, but isolated session, no soul, no skills summary,
      // no-op ingestConversation to prevent sub-agent turns polluting main memory.
      const subDeps: AgentDeps = {
        ...agentDeps,
        tools: subTools,
        getSoulPrompt: () =>
          `You are ${name} — a focused sub-agent.\n` +
          `Your ONLY job: ${task}\n` +
          `Complete the task thoroughly using the tools available, then stop.\n` +
          `Return your complete findings as plain text. Do not use the <|msg|> delimiter.`,
        getSkillsSummary: async () => null,
        ingestConversation: async () => {},
      };

      const runSubAgent = createAgent(subDeps);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs / 1000}s`)), timeoutMs),
      );

      try {
        const result = await Promise.race([
          runSubAgent({
            content: task,
            senderId: "subagent",
            chatId: sessionKey,
            channel: "subagent",
            sessionKey,
            source: "subagent",
          }),
          timeoutPromise,
        ]);

        const durationMs = Date.now() - startMs;
        const uniqueTools = [...new Set(result.toolsUsed)];
        console.log(`[spawn] ✓ ${name}  ${uniqueTools.join(", ")}  $${result.usage.cost.toFixed(4)}`);

        appendSpawnLog({
          name,
          status: "done",
          toolsUsed: uniqueTools,
          cost: result.usage.cost,
          durationMs,
          timestamp: new Date().toISOString(),
        });

        return {
          success: true,
          name,
          result: result.text,
          toolsUsed: result.toolsUsed,
          cost: result.usage.cost,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Sub-agent failed";
        const durationMs = Date.now() - startMs;
        const isTimeout = msg.startsWith("timeout");
        console.log(`[spawn] ✗ ${name}  ${msg}`);

        appendSpawnLog({
          name,
          status: isTimeout ? "timeout" : "error",
          toolsUsed: [],
          cost: 0,
          durationMs,
          timestamp: new Date().toISOString(),
        });

        return { success: false, name, error: msg, result: "", toolsUsed: [], cost: 0 };
      }
    },
  });

  return { spawnAgent };
}
