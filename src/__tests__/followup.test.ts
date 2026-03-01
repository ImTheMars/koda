import { describe, test, expect } from "bun:test";
import { detectFollowup } from "../followup.js";

describe("detectFollowup", () => {
  test("detects 'I'll X tomorrow'", () => {
    const result = detectFollowup("I'll finish the report tomorrow");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("finish the report");
    expect(result!.timeExpression).toBe("tomorrow");
    expect(result!.delayMs).toBe(24 * 60 * 60 * 1000);
    expect(result!.prompt).toContain("finish the report");
  });

  test("detects 'I will X tonight'", () => {
    const result = detectFollowup("I will call mom tonight");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("call mom");
    expect(result!.timeExpression).toBe("tonight");
    expect(result!.delayMs).toBe(6 * 60 * 60 * 1000);
  });

  test("detects 'I need to X by tomorrow'", () => {
    const result = detectFollowup("I need to submit the form by tomorrow");
    expect(result).not.toBeNull();
    expect(result!.action).toContain("submit the form");
    expect(result!.timeExpression).toBe("tomorrow");
  });

  test("detects 'gotta X tomorrow'", () => {
    const result = detectFollowup("gotta fix that bug tomorrow");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("fix that bug");
  });

  test("detects weekday references", () => {
    const result = detectFollowup("I'll send the email on monday");
    expect(result).not.toBeNull();
    expect(result!.timeExpression).toBe("on monday");
  });

  test("next week delay is 7 days", () => {
    const result = detectFollowup("I'll handle that next week");
    expect(result).not.toBeNull();
    expect(result!.delayMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("skips explicit reminder requests", () => {
    expect(detectFollowup("remind me to call mom tomorrow")).toBeNull();
    expect(detectFollowup("Remind me about the meeting")).toBeNull();
  });

  test("returns null for non-followup text", () => {
    expect(detectFollowup("hello")).toBeNull();
    expect(detectFollowup("what's the weather")).toBeNull();
    expect(detectFollowup("tell me a joke")).toBeNull();
  });

  test("action must be 5-80 chars", () => {
    // Too short action (< 5 chars)
    expect(detectFollowup("I'll do tomorrow")).toBeNull();
    // Normal action
    const result = detectFollowup("I'll clean up the garage tomorrow");
    expect(result).not.toBeNull();
  });

  test("prompt includes action and time expression", () => {
    const result = detectFollowup("I'll review the PR tomorrow");
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("review the PR");
    expect(result!.prompt).toContain("tomorrow");
  });
});
