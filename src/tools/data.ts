/**
 * Data analysis tool — parse and summarize CSV/JSON datasets without running code.
 *
 * analyzeData: Accepts a raw CSV or JSON string and returns schema, column statistics,
 * and sample rows — useful for quick data exploration without spawning a sandbox.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

type ColumnStats =
  | { type: "number"; count: number; nulls: number; min: number; max: number; mean: number; unique: number }
  | { type: "string"; count: number; nulls: number; unique: number; topValues: string[] };

function detectFormat(data: string): "csv" | "json" {
  const trimmed = data.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "csv";
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const parseRow = (line: string): string[] => {
    const cols: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i] ?? "";
      if (ch === '"') {
        const next = line[i + 1];
        if (inQuote && next === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === "," && !inQuote) {
        cols.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    return cols;
  };

  const [firstLine, ...dataLines] = lines;
  if (!firstLine || dataLines.length === 0) return [];

  const headers = parseRow(firstLine);
  return dataLines.map((line) => {
    const vals = parseRow(line);
    return Object.fromEntries(headers.map((h, i) => [h.trim(), (vals[i] ?? "").trim()]));
  });
}

function computeStats(rows: Record<string, unknown>[], columns: string[]): Record<string, ColumnStats> {
  const stats: Record<string, ColumnStats> = {};

  for (const col of columns) {
    const values = rows.map((r) => r[col]);
    const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
    const nums = nonNull.map((v) => Number(v)).filter((n) => !isNaN(n));

    if (nums.length === nonNull.length && nonNull.length > 0) {
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      stats[col] = {
        type: "number",
        count: nonNull.length,
        nulls: values.length - nonNull.length,
        min,
        max,
        mean: Math.round(mean * 10_000) / 10_000,
        unique: new Set(nums).size,
      };
    } else {
      const strs = nonNull.map((v) => String(v));
      const freq = new Map<string, number>();
      for (const s of strs) freq.set(s, (freq.get(s) ?? 0) + 1);
      const topValues = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([v]) => v);
      stats[col] = {
        type: "string",
        count: nonNull.length,
        nulls: values.length - nonNull.length,
        unique: freq.size,
        topValues,
      };
    }
  }

  return stats;
}

export function registerDataTools(): ToolSet {
  const analyzeData = tool({
    description:
      "Analyze a CSV or JSON dataset and return schema, column statistics, and sample rows. Use this instead of running code when the user shares structured data and wants summaries, counts, distributions, or quick insights.",
    inputSchema: z.object({
      data: z.string().describe("Raw CSV or JSON content to analyze"),
      format: z
        .enum(["csv", "json", "auto"])
        .default("auto")
        .describe("Data format — use 'auto' to detect from content"),
      sampleRows: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of sample rows to include in the result"),
    }),
    execute: async ({ data, format, sampleRows }) => {
      try {
        const fmt = format === "auto" ? detectFormat(data) : format;
        let rows: Record<string, unknown>[] = [];

        if (fmt === "csv") {
          rows = parseCsv(data);
        } else {
          const parsed = JSON.parse(data) as unknown;
          if (Array.isArray(parsed)) {
            rows = parsed.map((item) =>
              typeof item === "object" && item !== null
                ? (item as Record<string, unknown>)
                : { value: item }
            );
          } else if (typeof parsed === "object" && parsed !== null) {
            rows = [parsed as Record<string, unknown>];
          } else {
            return { success: false, error: "JSON must be an array or object" };
          }
        }

        if (rows.length === 0) {
          return { success: false, error: "No rows found in data" };
        }

        const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        const stats = computeStats(rows, columns);
        const sample = rows.slice(0, sampleRows);

        return {
          success: true,
          format: fmt,
          rowCount: rows.length,
          columnCount: columns.length,
          columns,
          stats,
          sample,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Analysis failed" };
      }
    },
  });

  return { analyzeData };
}
