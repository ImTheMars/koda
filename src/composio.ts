/**
 * Composio integration — thin wrapper around Composio SDK.
 *
 * Manages per-user connections and exposes Vercel AI SDK-compatible tools
 * for Gmail, Calendar, GitHub, and other services.
 */

import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import type { ToolSet } from "ai";

export interface ComposioDeps {
  apiKey: string;
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

export function createComposioClient(deps: ComposioDeps): ComposioClient {
  const provider = new VercelProvider();
  const client = new Composio({ apiKey: deps.apiKey, provider: provider as any });

  return {
    async getTools(toolkits: string[]): Promise<ToolSet> {
      // Fetch each toolkit separately — Composio caps combined requests at 20 tools,
      // which means some toolkits get zero tools when requested together.
      const allRawTools: any[] = [];
      for (const tk of toolkits) {
        const raw = await (client.tools as any).getRawComposioTools(
          { toolkits: [tk] },
          {},
        );
        if (!raw?.length) continue;

        // Filter to essential tools per toolkit to avoid prompt bloat (76 → ~25)
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

      const executeFn = (client.tools as any).createExecuteFnForProviders({});
      const wrapped = provider.wrapTools(allRawTools, executeFn);

      if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
        return wrapped as ToolSet;
      }
      return {};
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
