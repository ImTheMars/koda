/**
 * Search tools — web search + URL extraction via Exa.
 */

import Exa from "exa-js";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export function registerSearchTools(deps: { apiKey: string; numResults?: number }): ToolSet {
  const exa = new Exa(deps.apiKey);
  const defaultNum = deps.numResults ?? 5;

  const webSearch = tool({
    description: "Search the web for current information. Always cite sources in your response.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      numResults: z.number().min(1).max(10).optional(),
    }),
    execute: async ({ query, numResults }) => {
      try {
        const result = await exa.searchAndContents(query, {
          type: "auto",
          numResults: numResults ?? defaultNum,
          summary: true,
          useAutoprompt: true,
        });
        return {
          success: result.results.length > 0,
          answer: result.results[0]?.summary ?? "No summary available.",
          results: result.results.map((r, i) => ({
            index: i + 1,
            title: r.title,
            url: r.url,
            snippet: (r as any).summary ?? ((r as any).text?.slice(0, 280) ?? ""),
            citation: `[${r.title}](${r.url})`,
          })),
          resultCount: result.results.length,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Search failed", results: [] };
      }
    },
  });

  const extractUrl = tool({
    description: "Extract full content from URLs. Returns page content as text.",
    inputSchema: z.object({
      urls: z.array(z.string().url()).min(1).max(5),
    }),
    execute: async ({ urls }) => {
      try {
        const result = await exa.getContents(urls.slice(0, 5) as [string, ...string[]], { text: true });
        return {
          success: result.results.length > 0,
          results: result.results.map((r) => ({
            url: r.url,
            title: r.title,
            content: (r as any).text ?? "",
          })),
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Extract failed", results: [] };
      }
    },
  });

  return { webSearch, extractUrl };
}
