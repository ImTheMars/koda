/**
 * Web tools — URL fetching and arbitrary HTTP requests.
 *
 * fetchUrl: Retrieve the text content of a public URL (low-risk, no approval needed).
 * httpRequest: Make any HTTP request with full method/headers/body control (high-risk, requires approval).
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

const FETCH_TIMEOUT_MS = 30_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function registerWebTools(deps: {
  maxBodyBytes: number;
  onCost: (amount: number) => void;
}): { fetchUrl?: ToolSet[string]; httpRequest?: ToolSet[string] } {
  const maxBytes = deps.maxBodyBytes;

  const fetchUrl = tool({
    description:
      "Fetch the text content of a URL. Use for reading web pages, articles, or documents at a known URL. Returns cleaned text, not raw HTML. Prefer webSearch + extractUrl for discovery — use fetchUrl when you already have a specific URL to read.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
    }),
    execute: async ({ url }) => {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Koda/1.0 (AI assistant)" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const truncated = raw.length > maxBytes;
        const slice = truncated ? raw.slice(0, maxBytes) : raw;
        const body = contentType.includes("text/html") ? htmlToText(slice) : slice;

        return {
          success: res.ok,
          url,
          status: res.status,
          contentType,
          body,
          truncated,
          bytesRead: raw.length,
        };
      } catch (err) {
        return { success: false, url, error: err instanceof Error ? err.message : "Fetch failed" };
      }
    },
  });

  const httpRequest = tool({
    description:
      "Make an HTTP request to any URL with full control over method, headers, and body. Use for calling external APIs, webhooks, or services. Only call when the user has explicitly asked you to interact with an external service.",
    inputSchema: z.object({
      url: z.string().url().describe("Request URL"),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
        .default("GET")
        .describe("HTTP method"),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("HTTP headers as key-value pairs"),
      body: z.string().optional().describe("Request body (JSON string or plain text)"),
    }),
    execute: async ({ url, method, headers, body }) => {
      try {
        const res = await fetch(url, {
          method,
          headers: headers as HeadersInit | undefined,
          body: method !== "GET" && method !== "HEAD" ? body : undefined,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        const raw = await res.text();
        const truncated = raw.length > maxBytes;
        const responseBody = truncated ? raw.slice(0, maxBytes) : raw;

        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        return {
          success: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
          body: responseBody,
          truncated,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Request failed" };
      }
    },
  });

  return { fetchUrl, httpRequest };
}
