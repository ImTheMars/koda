/**
 * Railway build monitor — polls Railway's GraphQL API every 60s to detect new
 * deployments before SIGTERM arrives, and failed builds that would otherwise be silent.
 *
 * Auto no-ops when Railway env vars are absent (dev environments).
 *
 * Required env var (add manually in Railway dashboard):
 *   RAILWAY_TOKEN — Account Settings → Tokens
 *
 * Auto-injected by Railway (no action needed):
 *   RAILWAY_SERVICE_ID, RAILWAY_DEPLOYMENT_ID,
 *   RAILWAY_GIT_COMMIT_SHA, RAILWAY_GIT_BRANCH
 */

import { log } from "../log.js";

const RAILWAY_API = "https://backboard.railway.app/graphql/v2";
const POLL_INTERVAL_MS = 60_000;

type DeploymentStatus =
  | "INITIALIZING"
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCESS"
  | "FAILED"
  | "CRASHED"
  | "REMOVED";

interface Deployment {
  id: string;
  status: DeploymentStatus;
  createdAt: string;
}

interface RailwayMonitorCallbacks {
  onBuildDetected: (msg: string) => void;
  onBuildFailed: (msg: string) => void;
}

async function fetchLatestDeployments(
  token: string,
  serviceId: string,
): Promise<Deployment[]> {
  const query = `
    query LatestDeployments($serviceId: String!) {
      deployments(input: { serviceId: $serviceId }, first: 5) {
        edges {
          node {
            id
            status
            createdAt
          }
        }
      }
    }
  `;

  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: { serviceId } }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Railway API ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    data?: { deployments?: { edges?: Array<{ node: Deployment }> } };
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(`Railway API error: ${json.errors[0]!.message}`);
  }

  return (json.data?.deployments?.edges ?? []).map((e) => e.node);
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function gitContext(): string {
  const branch = process.env.RAILWAY_GIT_BRANCH;
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (!branch && !sha) return "";
  return ` — ${branch ?? "?"}@${shortSha(sha)}`;
}

export function startRailwayMonitor(callbacks: RailwayMonitorCallbacks): { stop(): void } {
  const token = process.env.RAILWAY_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const currentDeploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
  const env = process.env.KODA_ENV ?? "production";

  if (!token || !serviceId || !currentDeploymentId) {
    log("railway-monitor", "skipping (not Railway env)");
    return { stop() {} };
  }

  log("railway-monitor", `started (current deployment: ${currentDeploymentId.slice(0, 8)}...)`);

  // Track which deployment IDs we've already notified about to avoid repeat messages
  const notifiedBuildIds = new Set<string>([currentDeploymentId]);
  const notifiedFailIds = new Set<string>([currentDeploymentId]);

  const poll = async () => {
    try {
      const deployments = await fetchLatestDeployments(token, serviceId);
      log("railway-monitor", "polled %d deployments", deployments.length);

      for (const dep of deployments) {
        if (dep.id === currentDeploymentId) continue;

        if (
          (dep.status === "BUILDING" || dep.status === "DEPLOYING" || dep.status === "INITIALIZING") &&
          !notifiedBuildIds.has(dep.id)
        ) {
          notifiedBuildIds.add(dep.id);
          const ctx = gitContext();
          const msg = `new build incoming${ctx} [${env}]`;
          log("railway-monitor", msg);
          callbacks.onBuildDetected(msg);
        }

        if (
          (dep.status === "FAILED" || dep.status === "CRASHED") &&
          !notifiedFailIds.has(dep.id)
        ) {
          notifiedFailIds.add(dep.id);
          const ctx = gitContext();
          const msg = `build failed${ctx} [${env}]`;
          log("railway-monitor", msg);
          callbacks.onBuildFailed(msg);
        }
      }
    } catch (err) {
      log("railway-monitor", "poll error: %s", (err as Error).message);
    }
  };

  const timer = setInterval(poll, POLL_INTERVAL_MS);

  return {
    stop() {
      clearInterval(timer);
      log("railway-monitor", "stopped");
    },
  };
}
