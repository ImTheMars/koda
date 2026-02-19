/**
 * Sub-agent tool — lets the main agent delegate focused tasks to isolated child agents.
 *
 * spawnAgent runs a child createAgent() with:
 *   - filtered toolset (no recursion, no side-effectful tools)
 *   - isolated session key (no shared history, no-op memory ingest)
 *   - config-driven maxSteps cap and timeout (default 90 s)
 *   - AbortController-based kill support
 *
 * Parallelism is free: the AI SDK runs multiple tool calls in a single step concurrently.
 * Registration happens post-boot in index.ts (after runAgent exists) to avoid circular deps.
 *
 * Named sessions: spawnAgent registers the name → sessionKey so users can resume conversation
 * with a specific sub-agent via "@AgentName: ..." syntax in any channel.
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

// --- Spawn log ring buffer ---

export interface SpawnEntry {
  sessionKey: string;
  name: string;
  status: "running" | "done" | "error" | "timeout" | "killed";
  toolsUsed: string[];
  cost: number;
  durationMs: number;
  startedAt: string;
  timestamp: string;
}

const SPAWN_LOG_MAX = 50;
const spawnLog: SpawnEntry[] = [];

/** running spawns indexed by sessionKey for live status */
const runningMap = new Map<string, SpawnEntry>();

/** AbortControllers for in-flight sub-agents */
const abortMap = new Map<string, AbortController>();

export function getSpawnLog(): SpawnEntry[] {
  const running = [...runningMap.values()];
  return [...running, ...spawnLog].slice(0, SPAWN_LOG_MAX);
}

export function killSpawn(sessionKey: string): boolean {
  const ac = abortMap.get(sessionKey);
  if (!ac) return false;
  ac.abort();
  const entry = runningMap.get(sessionKey);
  if (entry) entry.status = "killed";
  return true;
}

export function getRunningSessionKeys(): string[] {
  return [...runningMap.keys()];
}

function appendCompleted(entry: SpawnEntry): void {
  runningMap.delete(entry.sessionKey);
  abortMap.delete(entry.sessionKey);
  spawnLog.unshift(entry);
  if (spawnLog.length > SPAWN_LOG_MAX) spawnLog.pop();
}

// --- Named session registry ---

export interface NamedSession {
  name: string;
  sessionKey: string;
  tools: string[];
  createdAt: string;
}

const namedSessions = new Map<string, NamedSession>();

export function getNamedSession(name: string): NamedSession | undefined {
  return namedSessions.get(name.toLowerCase());
}

export function listNamedSessions(): NamedSession[] {
  return [...namedSessions.values()];
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
    }),

    execute: async ({ name, task, tools: toolAllowlist, maxSteps }) => {
      const allowed = toolAllowlist ? new Set(toolAllowlist) : DEFAULT_ALLOWED;
      const subTools = buildSubToolset(masterTools, allowed);
      const sessionKey = freshSessionKey();
      const startedAt = new Date().toISOString();
      const startMs = Date.now();

      console.log(`[spawn] → ${name}  ×${maxSteps} steps  [${Object.keys(subTools).join(", ")}]`);

      const entry: SpawnEntry = {
        sessionKey,
        name,
        status: "running",
        toolsUsed: [],
        cost: 0,
        durationMs: 0,
        startedAt,
        timestamp: startedAt,
      };
      runningMap.set(sessionKey, entry);

      // Register named session immediately so user can reference it
      namedSessions.set(name.toLowerCase(), {
        name,
        sessionKey,
        tools: Object.keys(subTools),
        createdAt: startedAt,
      });

      const ac = new AbortController();
      abortMap.set(sessionKey, ac);

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
            abortSignal: ac.signal,
          }),
          timeoutPromise,
        ]);

        const durationMs = Date.now() - startMs;
        const uniqueTools = [...new Set(result.toolsUsed)];
        console.log(`[spawn] ✓ ${name}  ${uniqueTools.join(", ")}  $${result.usage.cost.toFixed(4)}`);

        entry.status = entry.status === "killed" ? "killed" : "done";
        entry.toolsUsed = uniqueTools;
        entry.cost = result.usage.cost;
        entry.durationMs = durationMs;
        entry.timestamp = new Date().toISOString();
        appendCompleted(entry);

        return {
          success: true,
          name,
          sessionKey,
          result: result.text,
          toolsUsed: result.toolsUsed,
          cost: result.usage.cost,
          note: `The agent is now available as '@${name}' for follow-up questions.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Sub-agent failed";
        const durationMs = Date.now() - startMs;
        const isTimeout = msg.startsWith("timeout");
        console.log(`[spawn] ✗ ${name}  ${msg}`);

        entry.status = isTimeout ? "timeout" : entry.status === "killed" ? "killed" : "error";
        entry.durationMs = durationMs;
        entry.timestamp = new Date().toISOString();
        appendCompleted(entry);

        return { success: false, name, sessionKey, error: msg, result: "", toolsUsed: [], cost: 0 };
      }
    },
  });

  return { spawnAgent };
}
