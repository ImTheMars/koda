/**
 * Search tools — web search + URL extraction via Tavily.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { tavily } from "@tavily/core";

export function registerSearchTools(deps: { apiKey: string }): ToolSet {
  const client = tavily({ apiKey: deps.apiKey });

  const webSearch = tool({
    description: "Search the web for current information. Always cite sources in your response.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      maxResults: z.number().min(1).max(10).optional().default(5),
      searchDepth: z.enum(["basic", "advanced"]).optional().default("basic"),
    }),
    execute: async ({ query, maxResults, searchDepth }) => {
      try {
        const response = await client.search(query, { maxResults, searchDepth, includeAnswer: true, includeRawContent: false });
        return {
          success: response.results.length > 0,
          answer: response.answer,
          results: response.results.map((r, i) => ({ index: i + 1, title: r.title, url: r.url, snippet: r.content, citation: `[${r.title}](${r.url})` })),
          resultCount: response.results.length,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Search failed", results: [] };
      }
    },
  });

  const extractUrl = tool({
    description: "Extract full content from URLs. Returns page content as markdown.",
    inputSchema: z.object({
      urls: z.array(z.string().url()).min(1).max(5),
      format: z.enum(["markdown", "text"]).optional().default("markdown"),
    }),
    execute: async ({ urls, format }) => {
      try {
        const response = await client.extract(urls, { format });
        return {
          success: response.results.length > 0,
          results: response.results.map((r) => ({ url: r.url, title: r.title, content: r.rawContent })),
          failedUrls: response.failedResults?.map((f) => f.url),
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Extract failed", results: [] };
      }
    },
  });

  return { webSearch, extractUrl };
}
