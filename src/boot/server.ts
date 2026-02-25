/**
 * Boot phase 4 — Bun.serve with health, webhook, OAuth, dashboard.
 */

import type { Config } from "../config.js";
import type { TelegramResult } from "../channels/telegram.js";
import type { SkillLoader } from "../tools/skills.js";
import type { MemoryProvider } from "../tools/memory.js";
import { handleDashboardRequest } from "../dashboard.js";
import { VERSION } from "../version.js";

export interface ServerDeps {
  config: Config;
  telegram: TelegramResult | null;
  skillLoader: SkillLoader;
  memoryProvider: MemoryProvider;
  defaultUserId: string;
}

export function bootServer(deps: ServerDeps) {
  const { config, telegram, skillLoader, memoryProvider, defaultUserId } = deps;

  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", version: VERSION, uptime: process.uptime() });
      }

      // OAuth callback (Composio handles exchange)
      if (url.pathname === "/oauth/callback" && req.method === "GET") {
        const status = url.searchParams.get("status") ?? "success";
        const html = status === "error"
          ? `<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Authorization Failed</h2><p>Something went wrong. Try again from the CLI.</p></body></html>`
          : `<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Authorization Successful</h2><p>You can close this tab and return to the terminal.</p></body></html>`;
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }

      // Telegram webhook endpoint
      if (url.pathname === "/telegram" && req.method === "POST" && telegram?.handleWebhook) {
        return telegram.handleWebhook(req);
      }

      const dash = await handleDashboardRequest(req, {
        skillLoader,
        defaultUserId,
        config,
        version: VERSION,
        memoryProvider,
      });
      if (dash) return dash;

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[boot] Health server on :${server.port}/health`);
  console.log(`[boot] Dashboard on :${server.port}/`);

  return server;
}
