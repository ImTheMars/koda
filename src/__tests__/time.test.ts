import { describe, test, expect } from "bun:test";
import { parseCronNext, formatUserTime, validateTimezone, parseNaturalSchedule } from "../time.js";

describe("validateTimezone", () => {
  test("accepts valid IANA timezones", () => {
    expect(validateTimezone("America/New_York")).toBe(true);
    expect(validateTimezone("Europe/London")).toBe(true);
    expect(validateTimezone("Asia/Tokyo")).toBe(true);
    expect(validateTimezone("UTC")).toBe(true);
  });

  test("rejects invalid timezones", () => {
    expect(validateTimezone("Fake/Zone")).toBe(false);
    expect(validateTimezone("")).toBe(false);
    expect(validateTimezone("Not_A_Timezone")).toBe(false);
  });
});

describe("formatUserTime", () => {
  test("formats date with timezone", () => {
    const date = new Date("2025-06-15T12:00:00Z");
    const result = formatUserTime(date, "UTC");
    expect(result).toContain("2025");
    expect(result).toContain("June");
    expect(result).toContain("15");
  });

  test("adjusts for timezone offset", () => {
    const date = new Date("2025-06-15T02:00:00Z");
    const nyResult = formatUserTime(date, "America/New_York");
    const tokyoResult = formatUserTime(date, "Asia/Tokyo");
    // NY is UTC-4 in June, Tokyo is UTC+9 — different days
    expect(nyResult).toContain("14"); // June 14 in NY
    expect(tokyoResult).toContain("15"); // June 15 in Tokyo
  });
});

describe("parseCronNext", () => {
  const tz = "UTC";

  test("daily schedule — time in future today", () => {
    const from = new Date("2025-06-15T08:00:00Z"); // 08:00 UTC
    const next = parseCronNext("10:00", from, tz);
    expect(next.getUTCHours()).toBe(10);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCDate()).toBe(15); // same day
  });

  test("daily schedule — time already passed wraps to tomorrow", () => {
    const from = new Date("2025-06-15T12:00:00Z"); // 12:00 UTC
    const next = parseCronNext("08:00", from, tz);
    expect(next.getUTCHours()).toBe(8);
    expect(next.getUTCDate()).toBe(16); // next day
  });

  test("weekly schedule — correct weekday", () => {
    // June 15, 2025 is a Sunday
    const from = new Date("2025-06-15T08:00:00Z");
    const next = parseCronNext("mon 10:00", from, tz);
    expect(next.getUTCDate()).toBe(16); // Monday June 16
    expect(next.getUTCHours()).toBe(10);
  });

  test("weekly schedule — wraps to next week if past", () => {
    // June 16, 2025 is Monday at 12:00
    const from = new Date("2025-06-16T12:00:00Z");
    const next = parseCronNext("mon 08:00", from, tz);
    expect(next.getUTCDate()).toBe(23); // next Monday
  });

  test("multi-day schedule", () => {
    // June 15 is Sunday
    const from = new Date("2025-06-15T08:00:00Z");
    const next = parseCronNext("wed,fri 09:00", from, tz);
    expect(next.getUTCDate()).toBe(18); // Wednesday June 18
  });

  test("throws on invalid time format", () => {
    const from = new Date();
    expect(() => parseCronNext("25:00", from, tz)).toThrow();
    expect(() => parseCronNext("8:60", from, tz)).toThrow();
    expect(() => parseCronNext("abc", from, tz)).toThrow();
  });

  test("throws on invalid weekday", () => {
    const from = new Date();
    expect(() => parseCronNext("xyz 10:00", from, tz)).toThrow();
  });

  test("throws on empty schedule", () => {
    const from = new Date();
    expect(() => parseCronNext("", from, tz)).toThrow();
  });

  test("handles midnight correctly", () => {
    const from = new Date("2025-06-15T23:00:00Z");
    const next = parseCronNext("00:00", from, tz);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCDate()).toBe(16);
  });
});

describe("parseNaturalSchedule", () => {
  test("every day with time", () => {
    expect(parseNaturalSchedule("every day at 8 am")).toBe("08:00");
    expect(parseNaturalSchedule("daily at 9:30 pm")).toBe("21:30");
  });

  test("every weekday", () => {
    expect(parseNaturalSchedule("every weekday at 9 am")).toBe("mon,tue,wed,thu,fri 09:00");
  });

  test("every weekend", () => {
    expect(parseNaturalSchedule("every weekend at 10 am")).toBe("sat,sun 10:00");
  });

  test("every morning/evening/night", () => {
    expect(parseNaturalSchedule("every morning")).toBe("08:00");
    expect(parseNaturalSchedule("every evening")).toBe("18:00");
    expect(parseNaturalSchedule("every night")).toBe("21:00");
  });

  test("every morning with time overrides default", () => {
    expect(parseNaturalSchedule("every morning at 7 am")).toBe("07:00");
  });

  test("specific weekday", () => {
    expect(parseNaturalSchedule("every Monday at 9 am")).toBe("mon 09:00");
    expect(parseNaturalSchedule("every tuesday")).toBe("tue 08:00");
  });

  test("multiple weekdays", () => {
    expect(parseNaturalSchedule("every Monday and Wednesday at 10 am")).toBe("mon,wed 10:00");
  });

  test("ambiguous single digit hours", () => {
    // < 8 without am/pm → treated as PM
    expect(parseNaturalSchedule("every day at 3")).toBe("15:00");
    // 8 or above stays as-is
    expect(parseNaturalSchedule("every day at 8")).toBe("08:00");
  });

  test("returns null for non-schedule text", () => {
    expect(parseNaturalSchedule("hello world")).toBeNull();
    expect(parseNaturalSchedule("what's the weather")).toBeNull();
  });

  test("recurring keyword triggers daily with time", () => {
    expect(parseNaturalSchedule("remind me recurring at 8 am")).toBe("08:00");
  });
});
