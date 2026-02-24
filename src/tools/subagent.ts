/**
 * Sub-agent tool — lets the main agent delegate focused tasks to isolated child agents.
 *
 * spawnAgent runs a child createAgent() with:
 *   - filtered toolset (no recursion, no side-effectful tools)
 *   - isolated session key (no shared history, no-op memory ingest)
 *   - config-driven maxSteps cap and timeout (default 90 s)
 *   - AbortController-based kill support
 *
 * State is persisted to SQLite (subagents table) for crash-resilience and dashboard queries.
 * Named sessions are resolved from SQLite so @AgentName routing survives restarts.
 *
 * Parallelism is free: the AI SDK runs multiple tool calls in a single step concurrently.
 * Registration happens post-boot in index.ts (after runAgent exists) to avoid circular deps.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createAgent, type AgentDeps } from "../agent.js";
import { subagents as dbSubagents, type SpawnRow } from "../db.js";
import { emit } from "../events.js";

/** Structured results stored by sub-agents that call returnResult. */
const structuredResults = new Map<string, { summary: string; data?: Record<string, unknown> }>();

// Tools that sub-agents are never allowed to use, regardless of allowlist.
const ALWAYS_BLOCKED = new Set([
  "spawnAgent",           // no recursion
  "createReminder",       // no scheduling side effects
  "createRecurringTask",  // no scheduling side effects
  "listTasks",            // no scheduling side effects
  "deleteTask",           // no scheduling side effects
  "runSandboxed",         // sandbox access only from main agent
  "getSoul",              // soul is a main-agent concern
  "updateSoul",           // soul is a main-agent concern
]);

// Default allowlist when the caller doesn't specify one.
const DEFAULT_ALLOWED = new Set([
  "webSearch",
  "extractUrl",
  "remember",
  "recall",
  "readFile",
  "writeFile",
  "listFiles",
  "skills",
  "systemStatus",
]);

// Re-export SpawnEntry shape from db for backward compat with dashboard
export type SpawnEntry = SpawnRow;

/** AbortControllers for in-flight sub-agents (in-memory only — not persisted). */
const abortMap = new Map<string, AbortController>();

export function getSpawnLog(): SpawnEntry[] {
  return dbSubagents.listRecent(50);
}

export function killSpawn(sessionKey: string): boolean {
  const ac = abortMap.get(sessionKey);
  if (!ac) return false;
  ac.abort();
  dbSubagents.markCompleted(sessionKey, { status: "killed", toolsUsed: [], cost: 0, durationMs: 0 });
  const updated = dbSubagents.listRecent(1).find((r) => r.sessionKey === sessionKey);
  if (updated) emit("spawn", updated);
  return true;
}

export function getRunningSessionKeys(): string[] {
  return [...abortMap.keys()];
}

export function getNamedSession(name: string): { sessionKey: string } | undefined {
  const row = dbSubagents.getByName(name);
  return row ?? undefined;
}

export function listNamedSessions(): Array<{ name: string; sessionKey: string }> {
  return dbSubagents.getRunning().map((r) => ({ name: r.name, sessionKey: r.sessionKey }));
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
      "Multiple spawnAgent calls in one step run concurrently — use this for parallel work. " +
      "The sub-agent is registered by name so the user can resume chatting with it via '@AgentName: ...'.",
    inputSchema: z.object({
      name: z.string().describe("Short label for this sub-agent, e.g. 'ResearchAgent' or 'SummaryAgent'"),
      task: z.string().describe("The complete, self-contained task description for the sub-agent"),
      tools: z.array(z.string()).optional().describe(
        `Allowlist of tool names the sub-agent can use. Defaults to: ${[...DEFAULT_ALLOWED].join(", ")}`,
      ),
      maxSteps: z.number().min(1).max(maxStepsCap).optional().default(5).describe(`Max steps before the sub-agent stops (1–${maxStepsCap}, default 5)`),
      tier: z.enum(["fast", "deep"]).optional().describe("Force sub-agent to use a specific tier"),
      context: z.string().optional().describe("Relevant context from the current conversation to share with the sub-agent"),
      timeoutMs: z.number().min(10_000).max(300_000).optional().describe("Custom timeout (default from config, max 5 min)"),
    }),

    execute: async ({ name, task, tools: toolAllowlist, maxSteps, tier: tierOverride, context, timeoutMs: customTimeout }) => {
      const allowed = toolAllowlist ? new Set(toolAllowlist) : DEFAULT_ALLOWED;
      const subTools = buildSubToolset(masterTools, allowed);
      const sessionKey = freshSessionKey();
      const startedAt = new Date().toISOString();
      const startMs = Date.now();

      console.log(`[spawn] → ${name}  ×${maxSteps} steps  [${Object.keys(subTools).join(", ")}]`);

      // Persist spawn record immediately
      dbSubagents.upsert({ sessionKey, name, startedAt });
      emit("spawn", {
        sessionKey, name, status: "running",
        toolsUsed: [], cost: 0, durationMs: 0, startedAt, timestamp: startedAt,
      });

      const ac = new AbortController();
      abortMap.set(sessionKey, ac);

      // streamUpdate: bound to this session — lets the sub-agent broadcast live progress
      const streamUpdateTool = tool({
        description: "Send a brief live progress update visible in the dashboard. Call this between steps to show what you're doing.",
        inputSchema: z.object({
          message: z.string().describe("Brief status, e.g. 'Searching for pricing data...' or 'Found 3 sources, summarising...'"),
        }),
        execute: async ({ message }) => {
          emit("subagent_update", { sessionKey, name, message, ts: new Date().toISOString() });
          console.log(`[spawn:${name}] ${message}`);
          return { sent: true };
        },
      });

      // returnResult: forces structured output so the main agent gets clean, parseable data
      const returnResultTool = tool({
        description: "Submit your final structured result. ALWAYS call this when you have finished your task instead of just returning text.",
        inputSchema: z.object({
          summary: z.string().describe("Concise prose summary of findings (1-3 sentences)"),
          data: z.record(z.string(), z.unknown()).describe("Optional structured data: tables, lists, counts, URLs, etc.").optional(),
        }),
        execute: async ({ summary, data }) => {
          structuredResults.set(sessionKey, { summary, data });
          return { stored: true };
        },
      });

      const subToolsWithExtras: ToolSet = { ...subTools, streamUpdate: streamUpdateTool, returnResult: returnResultTool };

      const subDeps: AgentDeps = {
        ...agentDeps,
        tools: subToolsWithExtras,
        getSoulPrompt: () => {
          const lines = [
            `You are ${name} — a focused sub-agent spawned by the main Koda agent.`,
            ``, `## Your task`, task,
          ];
          if (context) lines.push(``, `## Context from parent`, context);
          lines.push(``, `## Rules`,
            `- Use streamUpdate after each major step to show progress.`,
            `- When DONE, call returnResult({ summary, data }) with your findings.`,
            `- Do NOT use the <|msg|> delimiter.`,
            `- Be thorough but concise. If stuck, return what you have so far.`,
          );
          return lines.join("\n");
        },
        getSkillsSummary: async () => null,
        ingestConversation: async () => {},
      };

      const runSubAgent = createAgent(subDeps);
      structuredResults.delete(sessionKey); // clear any stale result from prior run

      const effectiveTimeout = customTimeout ?? timeoutMs;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${effectiveTimeout / 1000}s`)), effectiveTimeout),
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
            tierOverride,
            requestId: `sub-${sessionKey.slice(-8)}`,
            abortSignal: ac.signal,
          }),
          timeoutPromise,
        ]);

        const durationMs = Date.now() - startMs;
        const uniqueTools = [...new Set(result.toolsUsed)];
        const wasKilled = !abortMap.has(sessionKey); // killed externally clears the map entry
        const status = wasKilled ? "killed" : "done";

        console.log(`[spawn] ✓ ${name}  ${uniqueTools.join(", ")}  $${result.usage.cost.toFixed(4)}`);

        dbSubagents.markCompleted(sessionKey, { status, toolsUsed: uniqueTools, cost: result.usage.cost, durationMs });
        abortMap.delete(sessionKey);

        const finalEntry: SpawnEntry = {
          sessionKey, name, status,
          toolsUsed: uniqueTools, cost: result.usage.cost, durationMs,
          startedAt, timestamp: new Date().toISOString(),
        };
        emit("spawn", finalEntry);

        const structured = structuredResults.get(sessionKey) ?? null;
        structuredResults.delete(sessionKey);

        return {
          success: true,
          name,
          sessionKey,
          result: structured?.summary ?? result.text,
          structured,
          toolsUsed: result.toolsUsed,
          cost: result.usage.cost,
          note: `The agent is now available as '@${name}' for follow-up questions.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Sub-agent failed";
        const durationMs = Date.now() - startMs;
        const isTimeout = msg.startsWith("timeout");
        const wasKilled = !abortMap.has(sessionKey);
        const status = isTimeout ? "timeout" : wasKilled ? "killed" : "error";

        console.log(`[spawn] ✗ ${name}  ${msg}`);

        dbSubagents.markCompleted(sessionKey, { status, toolsUsed: [], cost: 0, durationMs });
        abortMap.delete(sessionKey);

        const finalEntry: SpawnEntry = {
          sessionKey, name, status,
          toolsUsed: [], cost: 0, durationMs,
          startedAt, timestamp: new Date().toISOString(),
        };
        emit("spawn", finalEntry);

        return { success: false, name, sessionKey, error: msg, result: "", toolsUsed: [], cost: 0 };
      }
    },
  });

  return { spawnAgent };
}
