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
  getTools(userId: string, toolkits: string[]): Promise<ToolSet>;
  getAuthUrl(userId: string, app: string): Promise<string>;
  isConnected(userId: string, app: string): Promise<boolean>;
}

export function createComposioClient(deps: ComposioDeps): ComposioClient {
  const provider = new VercelProvider();
  const client = new Composio({ apiKey: deps.apiKey, provider: provider as any });

  return {
    async getTools(userId: string, toolkits: string[]): Promise<ToolSet> {
      const tools = await (client as any).getTools({
        apps: toolkits,
        entityId: userId,
      });
      // Composio returns Vercel AI SDK-compatible tools when using VercelProvider
      const result: ToolSet = {};
      if (Array.isArray(tools)) {
        for (const t of tools) {
          if (t && typeof t === "object") {
            const name = (t as any).name ?? (t as any).slug ?? `composio_${Object.keys(result).length}`;
            result[name] = t as any;
          }
        }
      } else if (tools && typeof tools === "object") {
        Object.assign(result, tools);
      }
      return result;
    },

    async getAuthUrl(userId: string, app: string): Promise<string> {
      try {
        const entity = (client as any).getEntity(userId);
        const connection = await entity.initiateConnection({ appName: app });
        return connection.redirectUrl ?? connection.url ?? "";
      } catch {
        // Fallback: use connectedAccounts API directly
        const response = await (client as any).connectedAccounts?.initiateConnection?.({
          entityId: userId,
          appName: app,
        });
        return response?.redirectUrl ?? response?.url ?? "";
      }
    },

    async isConnected(userId: string, app: string): Promise<boolean> {
      try {
        const entity = (client as any).getEntity(userId);
        const connections = await entity.getConnections();
        if (!Array.isArray(connections)) return false;
        return connections.some(
          (c: any) => c.appName?.toLowerCase() === app.toLowerCase() && c.status === "ACTIVE",
        );
      } catch {
        return false;
      }
    },
  };
}
