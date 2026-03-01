import { describe, test, expect } from "bun:test";
import { parseEnvFile } from "../env.js";

describe("parseEnvFile", () => {
  test("parses simple key=value", () => {
    expect(parseEnvFile("FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("parses multiple lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("ignores comments", () => {
    expect(parseEnvFile("# comment\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  test("ignores empty lines", () => {
    expect(parseEnvFile("\n\nFOO=bar\n\n")).toEqual({ FOO: "bar" });
  });

  test("strips export prefix", () => {
    expect(parseEnvFile("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("handles double-quoted values", () => {
    expect(parseEnvFile('FOO="hello world"')).toEqual({ FOO: "hello world" });
  });

  test("handles single-quoted values", () => {
    expect(parseEnvFile("FOO='hello world'")).toEqual({ FOO: "hello world" });
  });

  test("handles escape sequences", () => {
    const result = parseEnvFile("FOO=line1\\nline2");
    expect(result.FOO).toBe("line1\nline2");
  });

  test("handles \\t and \\r", () => {
    expect(parseEnvFile("FOO=a\\tb\\rc")).toEqual({ FOO: "a\tb\rc" });
  });

  test("skips lines without equals", () => {
    expect(parseEnvFile("NOVALUE")).toEqual({});
  });

  test("preserves value after first equals", () => {
    expect(parseEnvFile("FOO=bar=baz")).toEqual({ FOO: "bar=baz" });
  });

  test("rejects invalid key names", () => {
    expect(parseEnvFile("123=invalid")).toEqual({});
    expect(parseEnvFile("key-name=invalid")).toEqual({});
  });

  test("accepts underscore keys", () => {
    expect(parseEnvFile("_FOO=bar")).toEqual({ _FOO: "bar" });
    expect(parseEnvFile("FOO_BAR=baz")).toEqual({ FOO_BAR: "baz" });
  });

  test("handles Windows CRLF line endings", () => {
    expect(parseEnvFile("FOO=bar\r\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("trims whitespace around key and value", () => {
    expect(parseEnvFile("  FOO  =  bar  ")).toEqual({ FOO: "bar" });
  });
});
