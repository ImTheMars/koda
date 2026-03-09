/**
 * Composio integration — wraps Composio v3 API as Vercel AI SDK tools.
 *
 * The SDK's VercelProvider wrapTools has a bug (sends both `text` and `arguments`
 * in the execute payload, causing 400 errors). We bypass it by:
 * 1. Using the SDK to discover tool schemas (getRawComposioTools)
 * 2. Building Vercel AI SDK tools manually with direct v3 API execute calls
 */

import { Composio } from "@composio/core";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { logError } from "./log.js";

// --- Composio SDK response types ---

interface ComposioToolParam {
  name?: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

interface ComposioRawTool {
  slug: string;
  name?: string;
  description?: string;
  inputParameters?: ComposioToolParam[];
}

interface ComposioExecResponse {
  data?: unknown;
  error?: { message?: string } | string;
}

interface ComposioConnection {
  status?: string;
  toolkit?: { slug?: string };
}

interface ComposioInitiateResult {
  redirectUrl?: string;
  url?: string;
}

export interface ComposioDeps {
  apiKey: string;
  entityId?: string;
}

export interface ComposioClient {
  getTools(toolkits: string[]): Promise<ToolSet>;
  getAuthUrl(app: string): Promise<string>;
  isConnected(app: string): Promise<boolean>;
  listConnectedApps(): Promise<string[]>;
}

/** Essential tool slugs per toolkit — keeps prompt lean while covering real use cases. */
const ESSENTIAL_TOOLS: Record<string, string[]> = {
  gmail: ["FETCH_EMAILS", "SEND_EMAIL", "REPLY_TO", "CREATE_EMAIL_DRAFT", "SEARCH_PEOPLE"],
  googlecalendar: ["LIST_EVENTS", "FIND_EVENT", "CREATE_EVENT", "DELETE_EVENT", "GET_EVENT", "FREE_BUSY", "GET_CALENDAR_PROFILE"],
  github: ["CREATE_AN_ISSUE", "CREATE_A_PULL_REQUEST", "FIND_PULL_REQUESTS", "CREATE_AN_ISSUE_COMMENT", "COMMIT_MULTIPLE", "CREATE_OR_UPDATE_FILE"],
  googlesheets: ["CREATE_A_GOOGLE", "GET_SPREADSHEET_INFO", "BATCH_GET_SPREADSHEET_VALUES", "APPEND_DIMENSION", "GET_SHEET_NAMES"],
};

/** Override Composio's stingy defaults for specific tools (matched by slug substring). */
const TOOL_ARG_DEFAULTS: Record<string, Record<string, unknown>> = {
  GMAIL_FETCH_EMAILS: { max_results: 25 },
};

/** Build a Zod schema from Composio's raw inputParameters */
function buildZodSchema(inputParams: ComposioToolParam[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!Array.isArray(inputParams)) return z.object({});

  for (const param of inputParams) {
    const name = param.name;
    if (!name) continue;

    let field: z.ZodTypeAny;
    switch (param.type) {
      case "number": case "integer": field = z.number(); break;
      case "boolean": field = z.boolean(); break;
      case "array": field = z.array(z.unknown()); break;
      default: field = z.string(); break;
    }

    if (param.description) field = field.describe(param.description);
    if (param.default !== undefined) field = field.default(param.default);
    if (!param.required) field = field.optional();

    shape[name] = field;
  }

  return z.object(shape);
}

export function createComposioClient(deps: ComposioDeps): ComposioClient {
  const apiKey = deps.apiKey;
  const entityId = deps.entityId ?? "default";
  const client = new Composio({ apiKey });

  /** Execute a tool via Composio v3 REST API directly (bypasses broken SDK wrapper) */
  async function executeToolDirect(slug: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`https://backend.composio.dev/api/v3/tools/execute/${slug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        arguments: args,
        entity_id: entityId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = (await res.json()) as ComposioExecResponse;
    if (!res.ok || data.error) {
      const errObj = data.error;
      const msg = typeof errObj === "object" ? errObj?.message ?? `HTTP ${res.status}` : errObj ?? `HTTP ${res.status}`;
      throw new Error(`Composio ${slug}: ${msg}`);
    }
    return data.data ?? data;
  }

  return {
    async getTools(toolkits: string[]): Promise<ToolSet> {
      const allRawTools: ComposioRawTool[] = [];
      for (const tk of toolkits) {
        const raw = await (client.tools as { getRawComposioTools(opts: Record<string, unknown>, extra: Record<string, unknown>): Promise<ComposioRawTool[]> }).getRawComposioTools(
          { toolkits: [tk] },
          {},
        );
        if (!raw?.length) continue;

        const keep = ESSENTIAL_TOOLS[tk];
        if (keep) {
          allRawTools.push(...raw.filter((t) => {
            const slug = (t.slug ?? t.name ?? "").toUpperCase();
            return keep.some((k) => slug.includes(k));
          }));
        } else {
          allRawTools.push(...raw);
        }
      }
      if (allRawTools.length === 0) return {};

      // Build AI SDK tools with direct API execution.
      const tools: ToolSet = {};
      for (const rawTool of allRawTools) {
        const slug = rawTool.slug;
        let description = rawTool.description ?? rawTool.name ?? slug;
        // Augment descriptions so model knows to request a reasonable batch size.
        if (slug.toUpperCase().includes("GMAIL_FETCH_EMAILS")) {
          description += " Default fetches 25 emails. Use max_results to request more.";
        }
        const inputSchema = buildZodSchema(rawTool.inputParameters ?? []);

        const toolDefaults = Object.entries(TOOL_ARG_DEFAULTS).find(([key]) => slug.toUpperCase().includes(key))?.[1] ?? {};
        tools[slug] = tool({
          description,
          inputSchema,
          execute: async (args: Record<string, unknown>) => executeToolDirect(slug, { ...toolDefaults, ...args }),
        });
      }
      return tools;
    },

    async getAuthUrl(app: string): Promise<string> {
      try {
        const result = await (client.connectedAccounts as unknown as { initiate(opts: { appName: string }): Promise<ComposioInitiateResult> }).initiate({
          appName: app,
        });
        return result.redirectUrl ?? result.url ?? "";
      } catch (err) {
        logError("composio", "getAuthUrl failed", err);
        return "";
      }
    },

    async isConnected(app: string): Promise<boolean> {
      try {
        const connections = await client.connectedAccounts.list({});
        if (!connections?.items) return false;
        return (connections.items as ComposioConnection[]).some(
          (c) => c.toolkit?.slug?.toLowerCase() === app.toLowerCase() && c.status === "ACTIVE",
        );
      } catch {
        return false;
      }
    },

    async listConnectedApps(): Promise<string[]> {
      try {
        const connections = await client.connectedAccounts.list({});
        if (!connections?.items) return [];
        return [...new Set(
          (connections.items as ComposioConnection[])
            .filter((c) => c.status === "ACTIVE")
            .map((c) => c.toolkit?.slug?.toLowerCase())
            .filter((s): s is string => Boolean(s)),
        )];
      } catch {
        return [];
      }
    },
  };
}
