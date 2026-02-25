/**
 * Composio integration — wraps Composio v3 API as Vercel AI SDK tools.
 *
 * The SDK's VercelProvider wrapTools has a bug (sends both `text` and `arguments`
 * in the execute payload, causing 400 errors). We bypass it by:
 * 1. Using the SDK to discover tool schemas (getRawComposioTools)
 * 2. Building Vercel AI SDK tools manually with direct v3 API execute calls
 */

import { Composio } from "@composio/core";
import { z } from "zod";
import type { ToolSet } from "ai";

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

/** Build a Zod schema from Composio's raw inputParameters */
function buildZodSchema(inputParams: any[]): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!Array.isArray(inputParams)) return z.object({});

  for (const param of inputParams) {
    const name = param.name;
    if (!name) continue;

    let field: z.ZodTypeAny;
    switch (param.type) {
      case "number": case "integer": field = z.number(); break;
      case "boolean": field = z.boolean(); break;
      case "array": field = z.array(z.any()); break;
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

    const data = await res.json() as any;
    if (!res.ok || data.error) {
      const msg = data.error?.message ?? data.error ?? `HTTP ${res.status}`;
      throw new Error(`Composio ${slug}: ${msg}`);
    }
    return data.data ?? data;
  }

  return {
    async getTools(toolkits: string[]): Promise<ToolSet> {
      const allRawTools: any[] = [];
      for (const tk of toolkits) {
        const raw = await (client.tools as any).getRawComposioTools(
          { toolkits: [tk] },
          {},
        );
        if (!raw?.length) continue;

        const keep = ESSENTIAL_TOOLS[tk];
        if (keep) {
          allRawTools.push(...raw.filter((t: any) => {
            const slug = (t.slug ?? t.name ?? "").toUpperCase();
            return keep.some((k) => slug.includes(k));
          }));
        } else {
          allRawTools.push(...raw);
        }
      }
      if (allRawTools.length === 0) return {};

      // Build Vercel AI SDK tools with direct API execution
      const tools: Record<string, any> = {};
      for (const rawTool of allRawTools) {
        const slug = rawTool.slug as string;
        const description = rawTool.description ?? rawTool.name ?? slug;
        const parameters = buildZodSchema(rawTool.inputParameters ?? []);

        tools[slug] = {
          description,
          parameters,
          execute: async (args: any) => executeToolDirect(slug, args as Record<string, unknown>),
        };
      }
      return tools as ToolSet;
    },

    async getAuthUrl(app: string): Promise<string> {
      try {
        const result = await (client.connectedAccounts as any).initiate({
          appName: app,
        });
        return (result as any).redirectUrl ?? (result as any).url ?? "";
      } catch {
        return "";
      }
    },

    async isConnected(app: string): Promise<boolean> {
      try {
        const connections = await client.connectedAccounts.list({});
        if (!connections?.items) return false;
        return connections.items.some(
          (c: any) => c.toolkit?.slug?.toLowerCase() === app.toLowerCase() && c.status === "ACTIVE",
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
          connections.items
            .filter((c: any) => c.status === "ACTIVE")
            .map((c: any) => c.toolkit?.slug?.toLowerCase())
            .filter(Boolean) as string[],
        )];
      } catch {
        return [];
      }
    },
  };
}
