import { describe, test, expect } from "bun:test";
import { classifyTier, classifyIntent, calculateCost, shouldAck } from "../router.js";

describe("classifyTier", () => {
  test("hard prefix /think → deep", () => {
    expect(classifyTier("/think about this")).toBe("deep");
  });

  test("hard prefix /deep → deep", () => {
    expect(classifyTier("/deep analysis please")).toBe("deep");
  });

  test("strong keyword → deep", () => {
    expect(classifyTier("explain this step by step")).toBe("deep");
    expect(classifyTier("formally prove this theorem")).toBe("deep");
  });

  test("single soft keyword → fast", () => {
    expect(classifyTier("analyze this")).toBe("fast");
  });

  test("accumulated soft keywords → deep", () => {
    expect(classifyTier("analyze and compare and contrast the tradeoffs")).toBe("deep");
  });

  test("short casual message → fast", () => {
    expect(classifyTier("hello")).toBe("fast");
    expect(classifyTier("what time is it")).toBe("fast");
  });

  test("empty string → fast", () => {
    expect(classifyTier("")).toBe("fast");
  });

  test("case insensitive", () => {
    expect(classifyTier("STEP BY STEP")).toBe("deep");
    expect(classifyTier("Step By Step")).toBe("deep");
  });

  test("long message with connectors → higher score", () => {
    const words = Array(125).fill("word").join(" ");
    const msg = `first ${words} then something also more finally done analyze`;
    expect(classifyTier(msg)).toBe("deep");
  });

  test("very long message hits length bonuses", () => {
    const words = Array(305).fill("test").join(" ");
    // 305 words = +2 from length, only needs 1 soft keyword to reach deep
    expect(classifyTier(`${words} analyze`)).toBe("deep");
  });
});

describe("classifyIntent", () => {
  test("greeting → chat", () => {
    expect(classifyIntent("hello")).toBe("chat");
    expect(classifyIntent("hey how are you")).toBe("chat");
  });

  test("task keywords", () => {
    expect(classifyIntent("fix this bug")).toBe("task");
    expect(classifyIntent("build me a website")).toBe("task");
    expect(classifyIntent("deploy the app")).toBe("task");
  });

  test("research keywords", () => {
    expect(classifyIntent("research the latest AI news")).toBe("research");
    expect(classifyIntent("search for pricing info")).toBe("research");
  });

  test("code keywords", () => {
    expect(classifyIntent("write a typescript function")).toBe("code");
    expect(classifyIntent("debug this python script")).toBe("code");
  });

  test("schedule keywords", () => {
    expect(classifyIntent("remind me tomorrow")).toBe("schedule");
    expect(classifyIntent("schedule a meeting every day")).toBe("schedule");
  });

  test("memory keywords", () => {
    expect(classifyIntent("remember my favorite color is blue")).toBe("memory");
    expect(classifyIntent("save this note about my preferences")).toBe("memory");
  });

  test("no matches → chat", () => {
    expect(classifyIntent("")).toBe("chat");
    expect(classifyIntent("asdfghjkl")).toBe("chat");
  });

  test("multiple intents — highest score wins", () => {
    // "fix" (task) + "code" + "debug" (code x2) → code wins
    expect(classifyIntent("fix and debug this code")).toBe("code");
  });
});

describe("calculateCost", () => {
  test("zero tokens → zero cost", () => {
    expect(calculateCost("google/gemini-3-flash-preview", 0, 0)).toBe(0);
  });

  test("known model pricing", () => {
    // Gemini Flash: input $0.50/M, output $3/M
    const cost = calculateCost("google/gemini-3-flash-preview", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(3.5, 2);
  });

  test("Claude Sonnet pricing", () => {
    // Claude: input $3/M, output $15/M
    const cost = calculateCost("anthropic/claude-sonnet-4.6", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 2);
  });

  test("unknown model → zero cost", () => {
    expect(calculateCost("unknown/model", 1000, 1000)).toBe(0);
  });

  test("realistic token counts", () => {
    // 500 input, 200 output with Gemini Flash
    const cost = calculateCost("google/gemini-3-flash-preview", 500, 200);
    expect(cost).toBeCloseTo(0.00085, 5);
  });
});

describe("shouldAck", () => {
  test("empty content → false", () => {
    expect(shouldAck({ content: "", tier: "deep", intent: "task" })).toBe(false);
    expect(shouldAck({ content: "   ", tier: "deep", intent: "task" })).toBe(false);
  });

  test("scheduler source → false", () => {
    expect(shouldAck({ content: "do something", tier: "deep", intent: "task", source: "scheduler" })).toBe(false);
  });

  test("heartbeat source → false", () => {
    expect(shouldAck({ content: "check in", tier: "deep", intent: "task", source: "heartbeat" })).toBe(false);
  });

  test("short acknowledgment → false", () => {
    expect(shouldAck({ content: "ok", tier: "deep", intent: "task" })).toBe(false);
    expect(shouldAck({ content: "thanks", tier: "deep", intent: "task" })).toBe(false);
    expect(shouldAck({ content: "Cool", tier: "deep", intent: "task" })).toBe(false);
    expect(shouldAck({ content: "got it", tier: "deep", intent: "task" })).toBe(false);
  });

  test("deep tier + task intent → ack (score 5)", () => {
    expect(shouldAck({ content: "build a new feature", tier: "deep", intent: "task" })).toBe(true);
  });

  test("fast tier + chat intent → no ack (score 0)", () => {
    expect(shouldAck({ content: "hello there", tier: "fast", intent: "chat" })).toBe(false);
  });

  test("fast tier + task intent + long message → ack (score 3)", () => {
    const longContent = "a".repeat(180) + " do this";
    expect(shouldAck({ content: longContent, tier: "fast", intent: "task" })).toBe(true);
  });

  test("fast tier + task intent + short message → no ack (score 2)", () => {
    expect(shouldAck({ content: "fix bug", tier: "fast", intent: "task" })).toBe(false);
  });

  test("deep tier + chat → ack (score 3)", () => {
    expect(shouldAck({ content: "tell me something interesting", tier: "deep", intent: "chat" })).toBe(true);
  });
});
