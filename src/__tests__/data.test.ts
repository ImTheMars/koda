import { describe, test, expect } from "bun:test";
import { parseCsv, computeStats } from "../tools/data.js";

describe("parseCsv", () => {
  test("parses simple CSV", () => {
    const result = parseCsv("a,b,c\n1,2,3\n4,5,6");
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  test("handles quoted fields", () => {
    const result = parseCsv('name,desc\n"Alice","Hello, world"');
    expect(result).toEqual([
      ["name", "desc"],
      ["Alice", "Hello, world"],
    ]);
  });

  test("handles escaped quotes (doubled)", () => {
    const result = parseCsv('a\n"She said ""hi"""');
    expect(result).toEqual([
      ["a"],
      ['She said "hi"'],
    ]);
  });

  test("handles empty fields", () => {
    const result = parseCsv("a,b,c\n1,,3");
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  test("skips empty lines", () => {
    const result = parseCsv("a\n\n1\n\n2");
    expect(result).toEqual([["a"], ["1"], ["2"]]);
  });

  test("trims whitespace around fields", () => {
    const result = parseCsv("a , b , c\n 1 , 2 , 3 ");
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  test("handles Windows-style line endings (CRLF)", () => {
    const result = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(result).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("computeStats", () => {
  test("computes min/max/avg/sum for numeric columns", () => {
    const headers = ["name", "score"];
    const rows = [
      ["Alice", "10"],
      ["Bob", "20"],
      ["Carol", "30"],
    ];
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(1);
    expect(stats[0]!.column).toBe("score");
    expect(stats[0]!.min).toBe(10);
    expect(stats[0]!.max).toBe(30);
    expect(stats[0]!.avg).toBe(20);
    expect(stats[0]!.sum).toBe(60);
    expect(stats[0]!.count).toBe(3);
  });

  test("ignores non-numeric columns", () => {
    const headers = ["name", "city"];
    const rows = [
      ["Alice", "NYC"],
      ["Bob", "LA"],
    ];
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(0);
  });

  test("handles mixed numeric/non-numeric values (>50% threshold)", () => {
    const headers = ["value"];
    const rows = [["10"], ["20"], ["N/A"]];
    // 2/3 = 66% numeric → should include
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(1);
    expect(stats[0]!.count).toBe(2);
    expect(stats[0]!.avg).toBe(15);
  });

  test("excludes columns with <50% numeric values", () => {
    const headers = ["value"];
    const rows = [["10"], ["hello"], ["world"]];
    // 1/3 = 33% numeric → should exclude
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(0);
  });

  test("handles empty values gracefully", () => {
    const headers = ["a"];
    const rows = [[""], ["5"], ["10"]];
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(1);
    expect(stats[0]!.count).toBe(2);
  });

  test("handles negative and decimal numbers", () => {
    const headers = ["temp"];
    const rows = [["-5.5"], ["0"], ["10.5"]];
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(1);
    expect(stats[0]!.min).toBe(-5.5);
    expect(stats[0]!.max).toBe(10.5);
    expect(stats[0]!.sum).toBe(5);
  });

  test("handles single-row data", () => {
    const headers = ["x"];
    const rows = [["42"]];
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(1);
    expect(stats[0]!.min).toBe(42);
    expect(stats[0]!.max).toBe(42);
    expect(stats[0]!.avg).toBe(42);
  });

  test("handles multiple numeric columns", () => {
    const headers = ["x", "y", "label"];
    const rows = [
      ["1", "10", "a"],
      ["2", "20", "b"],
      ["3", "30", "c"],
    ];
    const stats = computeStats(headers, rows);
    expect(stats.length).toBe(2);
    expect(stats.map((s) => s.column).sort()).toEqual(["x", "y"]);
  });
});
