/**
 * Browser tools — Stagehand lazy-init, 5 actions.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

interface BrowserInstance {
  stagehand: any;
  goto(url: string): Promise<void>;
  act(action: string): Promise<string>;
  extract(instruction: string): Promise<unknown>;
  observe(instruction?: string): Promise<string[]>;
  screenshot(): Promise<string>;
  close(): Promise<void>;
}

async function createBrowser(headless: boolean): Promise<BrowserInstance> {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = new Stagehand({
    env: "LOCAL",
    enableCaching: true,
    localBrowserLaunchOptions: { headless },
  });
  await stagehand.init();

  return {
    stagehand,
    async goto(url) { await stagehand.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); },
    async act(action) { const r = await stagehand.act({ action }); return typeof r === "string" ? r : JSON.stringify(r); },
    async extract(instruction) { return stagehand.extract({ instruction }); },
    async observe(instruction) {
      const r = await stagehand.observe(instruction ? { instruction } : undefined);
      return Array.isArray(r) ? r.map((x: any) => typeof x === "string" ? x : JSON.stringify(x)) : [JSON.stringify(r)];
    },
    async screenshot() { const buf = await stagehand.page.screenshot({ type: "png" }); return Buffer.from(buf).toString("base64"); },
    async close() { try { await stagehand.close(); } catch {} },
  };
}

export function registerBrowserTools(deps: { headless: boolean }): ToolSet {
  let browser: BrowserInstance | null = null;
  const ensure = async () => { if (!browser) browser = await createBrowser(deps.headless); return browser; };

  const browseUrl = tool({
    description: "Navigate to a URL and get the page content.",
    inputSchema: z.object({
      url: z.string().url(),
      extractContent: z.string().optional().describe("If provided, extract specific content"),
    }),
    execute: async ({ url, extractContent }) => {
      try {
        const b = await ensure();
        await b.goto(url);
        if (extractContent) return { success: true, url, data: await b.extract(extractContent) };
        return { success: true, url, observations: await b.observe("Describe the main content") };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Browse failed" };
      }
    },
  });

  const browserAct = tool({
    description: "Perform an action on the current page (click, type, scroll).",
    inputSchema: z.object({ action: z.string() }),
    execute: async ({ action }) => {
      try { return { success: true, result: await (await ensure()).act(action) }; }
      catch (err) { return { success: false, error: err instanceof Error ? err.message : "Action failed" }; }
    },
  });

  const browserExtract = tool({
    description: "Extract structured data from the current page.",
    inputSchema: z.object({ instruction: z.string() }),
    execute: async ({ instruction }) => {
      try { return { success: true, data: await (await ensure()).extract(instruction) }; }
      catch (err) { return { success: false, error: err instanceof Error ? err.message : "Extract failed" }; }
    },
  });

  const browserScreenshot = tool({
    description: "Take a screenshot of the current page. Returns base64 PNG.",
    inputSchema: z.object({}),
    execute: async () => {
      try { return { success: true, format: "png", data: await (await ensure()).screenshot() }; }
      catch (err) { return { success: false, error: err instanceof Error ? err.message : "Screenshot failed" }; }
    },
  });

  const browserClose = tool({
    description: "Close the browser session.",
    inputSchema: z.object({}),
    execute: async () => {
      if (browser) { await browser.close(); browser = null; }
      return { success: true };
    },
  });

  return { browseUrl, browserAct, browserExtract, browserScreenshot, browserClose };
}
