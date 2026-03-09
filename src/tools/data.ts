/**
 * Data analysis tools — structured CSV/JSON analysis without external dependencies.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

/** Parse a CSV string into rows of string arrays, handling quoted fields. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  const lines = input.split(/\r?\n/).filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const row: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          row.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
    }
    row.push(current.trim());
    rows.push(row);
  }

  return rows;
}

interface ColumnStats {
  column: string;
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
}

/** Compute numeric stats for each column. */
export function computeStats(headers: string[], rows: string[][]): ColumnStats[] {
  const stats: ColumnStats[] = [];

  for (let col = 0; col < headers.length; col++) {
    const values: number[] = [];
    for (const row of rows) {
      const val = row[col];
      if (val !== undefined && val !== "") {
        const num = Number(val);
        if (!isNaN(num)) values.push(num);
      }
    }

    // Only report stats for columns with >50% numeric values
    if (values.length > rows.length * 0.5 && values.length > 0) {
      stats.push({
        column: headers[col]!,
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        sum: values.reduce((a, b) => a + b, 0),
        count: values.length,
      });
    }
  }

  return stats;
}

export function registerDataTools(): ToolSet {
  const analyzeData = tool({
    description: "Analyze structured data (CSV or JSON). Returns row count, column names, numeric statistics, and sample rows. Use for quick data exploration without running code.",
    inputSchema: z.object({
      data: z.string().describe("The data to analyze — CSV text or JSON string (array of objects)"),
      format: z.enum(["csv", "json"]).default("csv").describe("Data format"),
    }),
    execute: async ({ data, format }) => {
      try {
        let headers: string[];
        let dataRows: string[][];

        if (format === "json") {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed) || parsed.length === 0) {
            return { success: false, error: "Expected a non-empty JSON array of objects" };
          }
          headers = Object.keys(parsed[0] as Record<string, unknown>);
          dataRows = parsed.map((item: Record<string, unknown>) =>
            headers.map((h) => String(item[h] ?? "")),
          );
        } else {
          const allRows = parseCsv(data);
          if (allRows.length < 2) {
            return { success: false, error: "CSV needs at least a header row and one data row" };
          }
          headers = allRows[0]!;
          dataRows = allRows.slice(1);
        }

        const stats = computeStats(headers, dataRows);
        const sampleRows = dataRows.slice(0, 5).map((row) => {
          const obj: Record<string, string> = {};
          for (let i = 0; i < headers.length; i++) {
            obj[headers[i]!] = row[i] ?? "";
          }
          return obj;
        });

        return {
          success: true,
          rowCount: dataRows.length,
          columns: headers,
          numericStats: stats.map((s) => ({
            ...s,
            avg: Math.round(s.avg * 100) / 100,
            sum: Math.round(s.sum * 100) / 100,
          })),
          sampleRows,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Parse failed" };
      }
    },
  });

  return { analyzeData };
}
