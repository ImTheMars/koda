/**
 * Web tools — fetchUrl + httpRequest for reading web pages and calling APIs.
 *
 * Includes SSRF protection (blocks private IPs, localhost, cloud metadata endpoints).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { logInfo, logError } from "../log.js";

const FETCH_COST = 0.0001;

/** Private/reserved IP ranges that must be blocked to prevent SSRF. */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d+\.\d+$/,           // link-local
  /^metadata\.google\.internal$/i,
  /^\[::1\]$/,                       // IPv6 loopback
  /^\[fd[0-9a-f]{2}:/i,             // IPv6 ULA
  /^\[fe80:/i,                       // IPv6 link-local
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

/** Strip HTML to plain text: remove scripts, styles, tags, collapse whitespace. */
function stripHtml(html: string): string {
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Replace br/p/div/li tags with newlines
  text = text.replace(/<\s*(?:br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n");
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

export { isBlockedHost, stripHtml };

export function registerWebTools(deps: {
  maxBodyBytes: number;
  onCost?: (amount: number) => void;
}): ToolSet {
  const fetchUrl = tool({
    description: "Fetch and read the text content of any web page URL. Returns stripped plain text (no HTML). Use for reading articles, documentation, etc.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to fetch"),
    }),
    execute: async ({ url }) => {
      deps.onCost?.(FETCH_COST);
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return { success: false, error: "Only HTTP(S) URLs are supported" };
        }
        if (isBlockedHost(parsed.hostname)) {
          return { success: false, error: "Access to internal/private addresses is blocked" };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);

        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "Koda/1.0 (AI Assistant)" },
            redirect: "follow",
          });

          if (!res.ok) {
            return { success: false, error: `HTTP ${res.status} ${res.statusText}` };
          }

          const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
          if (contentLength > deps.maxBodyBytes) {
            return { success: false, error: `Response too large (${contentLength} bytes, max ${deps.maxBodyBytes})` };
          }

          const buffer = await res.arrayBuffer();
          if (buffer.byteLength > deps.maxBodyBytes) {
            return { success: false, error: `Response too large (${buffer.byteLength} bytes, max ${deps.maxBodyBytes})` };
          }

          const text = new TextDecoder().decode(buffer);
          const contentType = res.headers.get("content-type") ?? "";
          const isHtml = contentType.includes("html");
          const plainText = isHtml ? stripHtml(text) : text;
          const truncated = plainText.slice(0, 15_000);

          logInfo("tools", `fetchUrl: ${url} → ${truncated.length} chars (${isHtml ? "html→text" : "raw"})`);
          return {
            success: true,
            url,
            contentType,
            text: truncated,
            truncated: plainText.length > 15_000,
            charCount: truncated.length,
          };
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Fetch failed";
        logError("tools", `fetchUrl error: ${msg}`);
        return { success: false, error: msg.includes("abort") ? "Request timed out (15s)" : msg };
      }
    },
  });

  const httpRequest = tool({
    description: "Make an HTTP request to any API endpoint. Supports GET/POST/PUT/DELETE/PATCH with custom headers and JSON body.",
    inputSchema: z.object({
      url: z.string().url().describe("The API endpoint URL"),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
      headers: z.record(z.string(), z.string()).optional().describe("Custom request headers"),
      body: z.string().optional().describe("Request body (JSON string for POST/PUT/PATCH)"),
      timeoutSeconds: z.number().min(1).max(30).default(15).describe("Request timeout in seconds"),
    }),
    execute: async ({ url, method, headers, body, timeoutSeconds }) => {
      deps.onCost?.(FETCH_COST);
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return { success: false, error: "Only HTTP(S) URLs are supported" };
        }
        if (isBlockedHost(parsed.hostname)) {
          return { success: false, error: "Access to internal/private addresses is blocked" };
        }

        // Enforce max request body size (100KB)
        if (body && body.length > 100_000) {
          return { success: false, error: "Request body too large (max 100KB)" };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

        try {
          const reqHeaders: Record<string, string> = {
            "User-Agent": "Koda/1.0 (AI Assistant)",
            ...headers,
          };

          // Auto-set Content-Type for body requests if not already set
          if (body && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === "content-type")) {
            reqHeaders["Content-Type"] = "application/json";
          }

          const res = await fetch(url, {
            method,
            headers: reqHeaders,
            body: ["POST", "PUT", "PATCH"].includes(method) ? body : undefined,
            signal: controller.signal,
            redirect: "follow",
          });

          const resBuffer = await res.arrayBuffer();
          const resText = new TextDecoder().decode(resBuffer).slice(0, 15_000);

          // Extract relevant response headers
          const responseHeaders: Record<string, string> = {};
          for (const key of ["content-type", "x-request-id", "x-ratelimit-remaining", "retry-after", "location"]) {
            const val = res.headers.get(key);
            if (val) responseHeaders[key] = val;
          }

          logInfo("tools", `httpRequest: ${method} ${url} → ${res.status}`);
          return {
            success: res.ok,
            status: res.status,
            statusText: res.statusText,
            headers: responseHeaders,
            body: resText,
            truncated: resBuffer.byteLength > 15_000,
          };
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Request failed";
        logError("tools", `httpRequest error: ${msg}`);
        return { success: false, error: msg.includes("abort") ? `Request timed out (${timeoutSeconds}s)` : msg };
      }
    },
  });

  return { fetchUrl, httpRequest };
}
