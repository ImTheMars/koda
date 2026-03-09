import { describe, test, expect } from "bun:test";
import { isBlockedHost, stripHtml } from "../tools/web.js";

describe("isBlockedHost", () => {
  test("blocks localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
  });

  test("blocks 127.0.0.1", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
  });

  test("blocks 127.x.x.x range", () => {
    expect(isBlockedHost("127.0.0.2")).toBe(true);
    expect(isBlockedHost("127.255.255.255")).toBe(true);
  });

  test("blocks 10.x.x.x (private class A)", () => {
    expect(isBlockedHost("10.0.0.1")).toBe(true);
    expect(isBlockedHost("10.255.0.1")).toBe(true);
  });

  test("blocks 172.16-31.x.x (private class B)", () => {
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
  });

  test("allows 172.15.x.x and 172.32.x.x (outside private range)", () => {
    expect(isBlockedHost("172.15.0.1")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false);
  });

  test("blocks 192.168.x.x (private class C)", () => {
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("192.168.0.100")).toBe(true);
  });

  test("blocks 0.0.0.0", () => {
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });

  test("blocks 169.254.x.x (link-local)", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  test("blocks metadata.google.internal", () => {
    expect(isBlockedHost("metadata.google.internal")).toBe(true);
    expect(isBlockedHost("Metadata.Google.Internal")).toBe(true);
  });

  test("blocks IPv6 loopback", () => {
    expect(isBlockedHost("[::1]")).toBe(true);
  });

  test("allows public IPs", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("1.1.1.1")).toBe(false);
    expect(isBlockedHost("93.184.216.34")).toBe(false);
  });

  test("allows public domains", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("api.github.com")).toBe(false);
    expect(isBlockedHost("google.com")).toBe(false);
  });
});

describe("stripHtml", () => {
  test("removes script tags and content", () => {
    expect(stripHtml("<script>alert('xss')</script>hello")).toBe("hello");
  });

  test("removes style tags and content", () => {
    expect(stripHtml("<style>.foo{color:red}</style>hello")).toBe("hello");
  });

  test("removes HTML comments", () => {
    expect(stripHtml("<!-- comment -->hello")).toBe("hello");
  });

  test("removes general HTML tags", () => {
    expect(stripHtml("<p>hello</p> <b>world</b>")).toBe("hello world");
  });

  test("replaces br/p/div with newlines", () => {
    const result = stripHtml("line1<br>line2<p>para");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("para");
  });

  test("decodes HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot; &#39;")).toBe('& < > " \'');
  });

  test("collapses excessive whitespace", () => {
    expect(stripHtml("hello    world")).toBe("hello world");
  });

  test("collapses excessive newlines", () => {
    const result = stripHtml("a\n\n\n\n\nb");
    expect(result).toBe("a\n\nb");
  });

  test("handles empty string", () => {
    expect(stripHtml("")).toBe("");
  });

  test("handles plain text (no HTML)", () => {
    expect(stripHtml("just plain text")).toBe("just plain text");
  });
});
