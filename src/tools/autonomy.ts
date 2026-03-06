/**
 * Autonomy tools — structured assessment state, durable plans, and outcome verification.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { assessment, plans, tasks as dbTasks } from "../db.js";
import { safePath } from "../security.js";

export type ToolRiskLevel = "low" | "medium" | "high";

export interface ToolGovernancePolicy {
  risk: ToolRiskLevel;
  reversible: boolean;
  requiresApproval: boolean;
  verification: string;
}

export const TOOL_GOVERNANCE: Record<string, ToolGovernancePolicy> = {
  remember: { risk: "low", reversible: true, requiresApproval: false, verification: "confirm the memory stored reflects the user's wording" },
  recall: { risk: "low", reversible: true, requiresApproval: false, verification: "quote only retrieved facts" },
  readFile: { risk: "low", reversible: true, requiresApproval: false, verification: "summarize actual file contents" },
  writeFile: { risk: "medium", reversible: true, requiresApproval: false, verification: "confirm the file path and resulting contents" },
  runSandboxed: { risk: "high", reversible: false, requiresApproval: true, verification: "report stdout/stderr and whether the command succeeded" },
  createReminder: { risk: "low", reversible: true, requiresApproval: false, verification: "confirm the reminder exists with the expected time" },
  createRecurringTask: { risk: "medium", reversible: true, requiresApproval: false, verification: "confirm the recurring task exists with the intended cadence" },
  deleteTask: { risk: "medium", reversible: false, requiresApproval: false, verification: "confirm the intended task was deleted" },
  sendFile: { risk: "medium", reversible: false, requiresApproval: false, verification: "confirm the file path and destination" },
  httpRequest: { risk: "high", reversible: false, requiresApproval: true, verification: "confirm response status and downstream effect before claiming success" },
  fetchUrl: { risk: "low", reversible: true, requiresApproval: false, verification: "cite the fetched page or URL" },
  generateImage: { risk: "low", reversible: true, requiresApproval: false, verification: "confirm the generated asset matches the request" },
  spawnAgent: { risk: "medium", reversible: true, requiresApproval: false, verification: "review the sub-agent result before acting on it" },
  createPlanRecord: { risk: "low", reversible: true, requiresApproval: false, verification: "confirm the plan goal, steps, and success criteria" },
  updatePlanStep: { risk: "low", reversible: true, requiresApproval: false, verification: "confirm the step state matches the actual outcome" },
  approvePlan: { risk: "medium", reversible: true, requiresApproval: false, verification: "only approve after reviewing the goal, risk, and side effects" },
  verifyOutcome: { risk: "low", reversible: true, requiresApproval: false, verification: "use the check that matches the artifact or side effect" },
};

export function summarizeToolGovernance(toolNames: string[]): string | null {
  const lines = toolNames
    .map((name) => {
      const policy = TOOL_GOVERNANCE[name];
      if (!policy) return null;
      return `- ${name}: risk=${policy.risk}, approval=${policy.requiresApproval ? "required" : "not required"}, verify=${policy.verification}`;
    })
    .filter(Boolean) as string[];
  return lines.length > 0 ? lines.join("\n") : null;
}

function shouldRequireApproval(risk: ToolRiskLevel, threshold: "medium" | "high"): boolean {
  return threshold === "medium" ? risk === "medium" || risk === "high" : risk === "high";
}

function toIso(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildAssessmentSummary(userId: string): string {
  const snapshot = assessment.buildSummary(userId);
  const lines: string[] = [];

  if (snapshot.goals.length > 0) {
    lines.push("goals:");
    for (const goal of snapshot.goals) {
      lines.push(`- [${goal.status}] ${goal.title} (${goal.domain})`);
    }
  }
  if (snapshot.observations.length > 0) {
    lines.push("recent observations:");
    for (const observation of snapshot.observations.slice(0, 4)) {
      lines.push(`- ${observation.statement} [${observation.source}, ${observation.confidence.toFixed(2)}]`);
    }
  }
  if (snapshot.interventions.length > 0) {
    lines.push("interventions:");
    for (const intervention of snapshot.interventions.slice(0, 3)) {
      lines.push(`- [${intervention.status}] ${intervention.recommendation}`);
    }
  }
  if (snapshot.reviews.length > 0) {
    lines.push("latest review:");
    lines.push(`- ${snapshot.reviews[0]!.findings}`);
  }

  return lines.join("\n");
}

async function readFilePreview(path: string): Promise<{ exists: boolean; contentPreview?: string; bytes?: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { exists: false };
  const text = await file.text();
  return { exists: true, contentPreview: text.slice(0, 800), bytes: text.length };
}

export function registerAutonomyTools(deps: {
  workspace: string;
  getUserId: () => string;
  getChatId: () => string;
  autonomy: {
    approvalRiskLevel: "medium" | "high";
    perPlanBudgetUsd: number;
    monthlyBudgetUsd: number;
    allowBrowserAutomation: boolean;
  };
}): ToolSet {
  const { workspace, getUserId, getChatId } = deps;

  const assessmentSnapshot = tool({
    description: "Get the current structured assessment state for the user: goals, observations, interventions, and recent reviews.",
    inputSchema: z.object({}),
    execute: async () => {
      const userId = getUserId();
      const snapshot = assessment.buildSummary(userId);
      return {
        success: true,
        summary: buildAssessmentSummary(userId),
        goals: snapshot.goals,
        observations: snapshot.observations,
        interventions: snapshot.interventions,
        reviews: snapshot.reviews,
      };
    },
  });

  const upsertGoal = tool({
    description: "Create or update a structured user goal for longitudinal planning and assessment.",
    inputSchema: z.object({
      id: z.string().optional(),
      title: z.string(),
      domain: z.string().default("general"),
      status: z.enum(["active", "paused", "done", "cancelled"]).optional(),
      targetDate: z.string().optional(),
      successCriteria: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      notes: z.string().optional(),
    }),
    execute: async ({ id, title, domain, status, targetDate, successCriteria, confidence, notes }) => {
      const goalId = id ?? `goal-${crypto.randomUUID().slice(0, 8)}`;
      assessment.upsertGoal({
        id: goalId,
        userId: getUserId(),
        title,
        domain,
        status,
        targetDate: toIso(targetDate),
        successCriteria: successCriteria ?? null,
        confidence,
        notes: notes ?? null,
      });
      return { success: true, id: goalId };
    },
  });

  const listGoals = tool({
    description: "List the user's structured goals.",
    inputSchema: z.object({
      status: z.enum(["active", "paused", "done", "cancelled"]).optional(),
    }),
    execute: async ({ status }) => ({
      success: true,
      goals: assessment.listGoals(getUserId(), status),
    }),
  });

  const logObservation = tool({
    description: "Store a structured observation about the user or project with evidence source and confidence.",
    inputSchema: z.object({
      statement: z.string(),
      domain: z.string().default("general"),
      source: z.string().default("conversation"),
      evidenceType: z.string().default("self_report"),
      confidence: z.number().min(0).max(1).optional(),
      contradicts: z.string().optional(),
      observedAt: z.string().optional(),
    }),
    execute: async ({ statement, domain, source, evidenceType, confidence, contradicts, observedAt }) => {
      const id = `obs-${crypto.randomUUID().slice(0, 8)}`;
      assessment.addObservation({
        id,
        userId: getUserId(),
        domain,
        statement,
        source,
        evidenceType,
        confidence,
        contradicts: contradicts ?? null,
        observedAt: toIso(observedAt) ?? new Date().toISOString(),
      });
      return { success: true, id };
    },
  });

  const listObservations = tool({
    description: "List recent structured observations about the user.",
    inputSchema: z.object({
      limit: z.number().min(1).max(50).default(10),
    }),
    execute: async ({ limit }) => ({
      success: true,
      observations: assessment.listObservations(getUserId(), limit),
    }),
  });

  const createIntervention = tool({
    description: "Store a recommended intervention or coaching experiment and track its follow-up.",
    inputSchema: z.object({
      recommendation: z.string(),
      rationale: z.string().optional(),
      goalId: z.string().optional(),
      status: z.enum(["planned", "active", "done", "abandoned"]).optional(),
      startDate: z.string().optional(),
      followUpAt: z.string().optional(),
      outcome: z.string().optional(),
    }),
    execute: async ({ recommendation, rationale, goalId, status, startDate, followUpAt, outcome }) => {
      const id = `int-${crypto.randomUUID().slice(0, 8)}`;
      assessment.addIntervention({
        id,
        userId: getUserId(),
        goalId: goalId ?? null,
        recommendation,
        rationale: rationale ?? null,
        status,
        startDate: toIso(startDate),
        followUpAt: toIso(followUpAt),
        outcome: outcome ?? null,
      });
      return { success: true, id };
    },
  });

  const listInterventions = tool({
    description: "List stored interventions and their follow-up state.",
    inputSchema: z.object({
      status: z.enum(["planned", "active", "done", "abandoned"]).optional(),
    }),
    execute: async ({ status }) => ({
      success: true,
      interventions: assessment.listInterventions(getUserId(), status),
    }),
  });

  const storeReview = tool({
    description: "Store a structured review for a time window, such as a weekly review or goal drift audit.",
    inputSchema: z.object({
      periodStart: z.string(),
      periodEnd: z.string(),
      findings: z.string(),
      risks: z.string().optional(),
      wins: z.string().optional(),
      nextActions: z.string().optional(),
    }),
    execute: async ({ periodStart, periodEnd, findings, risks, wins, nextActions }) => {
      const id = `review-${crypto.randomUUID().slice(0, 8)}`;
      assessment.addReview({
        id,
        userId: getUserId(),
        periodStart: toIso(periodStart) ?? new Date().toISOString(),
        periodEnd: toIso(periodEnd) ?? new Date().toISOString(),
        findings,
        risks: risks ?? null,
        wins: wins ?? null,
        nextActions: nextActions ?? null,
      });
      return { success: true, id };
    },
  });

  const listReviews = tool({
    description: "List the user's recent structured reviews.",
    inputSchema: z.object({
      limit: z.number().min(1).max(20).default(5),
    }),
    execute: async ({ limit }) => ({
      success: true,
      reviews: assessment.listReviews(getUserId(), limit),
    }),
  });

  const createPlanRecord = tool({
    description: "Create a durable multi-step plan with success criteria and verification details. Use this for hard, long-horizon, or high-impact tasks.",
    inputSchema: z.object({
      title: z.string(),
      goal: z.string(),
      successCriteria: z.string().optional(),
      verificationStrategy: z.string().optional(),
      riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
      requiresApproval: z.boolean().optional(),
      steps: z.array(z.object({
        title: z.string(),
        instructions: z.string().optional(),
        expectedArtifact: z.string().optional(),
        verificationHint: z.string().optional(),
        assignedAgent: z.string().optional(),
      })).min(1),
    }),
    execute: async ({ title, goal, successCriteria, verificationStrategy, riskLevel, requiresApproval, steps }) => {
      const planId = `plan-${crypto.randomUUID().slice(0, 8)}`;
      plans.create({
        id: planId,
        userId: getUserId(),
        chatId: getChatId(),
        title,
        goal,
        status: "active",
        successCriteria: successCriteria ?? null,
        verificationStrategy: verificationStrategy ?? null,
        riskLevel,
        requiresApproval: requiresApproval ?? shouldRequireApproval(riskLevel, deps.autonomy.approvalRiskLevel),
        nextRunAt: new Date().toISOString(),
      });
      plans.addSteps(planId, steps.map((step) => ({ id: `step-${crypto.randomUUID().slice(0, 8)}`, ...step })));
      return {
        success: true,
        id: planId,
        requiresApproval: requiresApproval ?? shouldRequireApproval(riskLevel, deps.autonomy.approvalRiskLevel),
        budgets: {
          perPlanUsd: deps.autonomy.perPlanBudgetUsd,
          monthlyUsd: deps.autonomy.monthlyBudgetUsd,
        },
        browserAutomationAllowed: deps.autonomy.allowBrowserAutomation,
      };
    },
  });

  const listPlans = tool({
    description: "List durable plans for the current user.",
    inputSchema: z.object({
      status: z.enum(["draft", "active", "blocked", "done", "cancelled"]).optional(),
    }),
    execute: async ({ status }) => ({
      success: true,
      plans: plans.listByUser(getUserId(), status),
    }),
  });

  const getPlan = tool({
    description: "Get a durable plan with all of its steps.",
    inputSchema: z.object({
      id: z.string(),
    }),
    execute: async ({ id }) => {
      const plan = plans.get(id);
      return plan ? { success: true, plan } : { success: false, error: "Plan not found" };
    },
  });

  const updatePlanStep = tool({
    description: "Update a durable plan step after work is done, blocked, failed, or reprioritized.",
    inputSchema: z.object({
      planId: z.string(),
      stepId: z.string(),
      status: z.enum(["pending", "in_progress", "done", "blocked", "failed", "cancelled"]).optional(),
      notes: z.string().optional(),
      lastError: z.string().optional(),
      assignedAgent: z.string().optional(),
      nextRunAt: z.string().optional(),
    }),
    execute: async ({ planId, stepId, status, notes, lastError, assignedAgent, nextRunAt }) => {
      plans.updateStep(planId, stepId, {
        status,
        notes: notes ?? null,
        lastError: lastError ?? null,
        assignedAgent: assignedAgent ?? null,
      });
      if (nextRunAt) {
        plans.markRun(planId, toIso(nextRunAt));
      }
      const plan = plans.get(planId);
      return plan ? { success: true, plan } : { success: false, error: "Plan not found" };
    },
  });

  const approvePlan = tool({
    description: "Mark a durable plan as approved so high-risk work can continue.",
    inputSchema: z.object({
      planId: z.string(),
    }),
    execute: async ({ planId }) => {
      plans.setStatus(planId, "active", { approvedAt: new Date().toISOString(), nextRunAt: new Date().toISOString() });
      return { success: true, planId };
    },
  });

  const verifyOutcome = tool({
    description: "Verify that a file, reminder, plan, or URL outcome actually exists before claiming success.",
    inputSchema: z.object({
      targetType: z.enum(["file", "task", "plan", "url"]),
      path: z.string().optional(),
      taskId: z.string().optional(),
      planId: z.string().optional(),
      url: z.string().optional(),
    }),
    execute: async ({ targetType, path, taskId, planId, url }) => {
      if (targetType === "file") {
        if (!path) return { success: false, error: "path is required for file verification" };
        try {
          const safe = safePath(path, workspace, "read");
          const preview = await readFilePreview(safe);
          return preview.exists
            ? { success: true, verified: true, path: safe, contentPreview: preview.contentPreview, bytes: preview.bytes }
            : { success: false, verified: false, error: "File not found" };
        } catch (err) {
          return { success: false, verified: false, error: err instanceof Error ? err.message : "File verification failed" };
        }
      }

      if (targetType === "task") {
        if (!taskId) return { success: false, error: "taskId is required for task verification" };
        const task = dbTasks.listByUser(getUserId()).find((entry) => entry.id === taskId) ?? null;
        return task
          ? { success: true, verified: true, task }
          : { success: false, verified: false, error: "Task not found" };
      }

      if (targetType === "plan") {
        if (!planId) return { success: false, error: "planId is required for plan verification" };
        const plan = plans.get(planId);
        if (!plan) return { success: false, verified: false, error: "Plan not found" };
        const incompleteSteps = plan.steps.filter((step) => step.status !== "done" && step.status !== "cancelled");
        return {
          success: true,
          verified: incompleteSteps.length === 0 && plan.status === "done",
          plan,
          incompleteStepCount: incompleteSteps.length,
        };
      }

      if (!url) return { success: false, error: "url is required for URL verification" };
      try {
        const res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        return {
          success: res.ok,
          verified: res.ok,
          status: res.status,
          finalUrl: res.url,
        };
      } catch (err) {
        return { success: false, verified: false, error: err instanceof Error ? err.message : "URL verification failed" };
      }
    },
  });

  return {
    assessmentSnapshot,
    upsertGoal,
    listGoals,
    logObservation,
    listObservations,
    createIntervention,
    listInterventions,
    storeReview,
    listReviews,
    createPlanRecord,
    listPlans,
    getPlan,
    updatePlanStep,
    approvePlan,
    verifyOutcome,
  };
}
