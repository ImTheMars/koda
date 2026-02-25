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

export function createComposioClient(deps: ComposioDeps): ComposioClient {
  const provider = new VercelProvider();
  const client = new Composio({ apiKey: deps.apiKey, provider: provider as any });

  return {
    async getTools(toolkits: string[]): Promise<ToolSet> {
      // Get raw tools then wrap for Vercel AI SDK
      const rawTools = await (client.tools as any).getRawComposioTools(
        { toolkits },
        {},
      );
      if (!rawTools || rawTools.length === 0) return {};

      const executeFn = (client.tools as any).createExecuteFnForProviders({});
      const wrapped = provider.wrapTools(rawTools, executeFn);

      // wrapTools returns a ToolSet-compatible object
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
