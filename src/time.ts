/**
 * Time utilities — timezone-aware formatting and cron scheduling.
 *
 * Uses Intl.DateTimeFormat for all timezone math (no external library).
 */

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function nowInTz(at: Date, tz: string): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "numeric", weekday: "short", hour12: false,
  }).formatToParts(at);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value?.toLowerCase().slice(0, 3) ?? "mon";
  return { hour, minute, weekday: DAY_MAP[weekdayStr] ?? 1 };
}

export function formatUserTime(date: Date, tz: string): string {
  return date.toLocaleString("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Compute the next run time for a simple cron schedule.
 * Supports: "HH:MM" (daily) or "mon,wed,fri HH:MM" (specific weekdays)
 */
export function parseCronNext(schedule: string, from: Date, tz: string): Date {
  const parts = schedule.trim().split(/\s+/);
  let targetDays: number[] | null = null;
  let timeStr: string;

  if (parts.length === 2) {
    const rawDays = parts[0]!.toLowerCase().split(",").map((d) => d.trim()).filter(Boolean);
    if (rawDays.length === 0) throw new Error("Invalid schedule format");

    targetDays = [];
    for (const d of rawDays) {
      const day = DAY_MAP[d];
      if (day === undefined) throw new Error(`Invalid weekday token: ${d}`);
      if (!targetDays.includes(day)) targetDays.push(day);
    }

    timeStr = parts[1]!;
  } else if (parts.length === 1) {
    timeStr = parts[0]!;
  } else {
    throw new Error("Invalid schedule format");
  }

  if (!/^\d{1,2}:\d{2}$/.test(timeStr)) throw new Error("Invalid time format");
  const timeParts = timeStr.split(":").map(Number);
  const targetH = timeParts[0] ?? -1;
  const targetM = timeParts[1] ?? -1;
  if (targetH < 0 || targetH > 23 || targetM < 0 || targetM > 59) {
    throw new Error("Invalid time value");
  }
  const { hour, minute, weekday } = nowInTz(from, tz);
  const currentMinutes = hour * 60 + minute;
  const targetMinutes = targetH * 60 + targetM;

  let daysAhead = 0;

  if (targetDays) {
    for (let i = 0; i < 7; i++) {
      const checkDay = (weekday + i) % 7;
      if (targetDays.includes(checkDay)) {
        if (i === 0 && currentMinutes >= targetMinutes) continue;
        daysAhead = i;
        break;
      }
    }
    if (daysAhead === 0 && currentMinutes >= targetMinutes) {
      for (let i = 1; i <= 7; i++) {
        if (targetDays.includes((weekday + i) % 7)) { daysAhead = i; break; }
      }
    }
  } else {
    if (currentMinutes >= targetMinutes) daysAhead = 1;
  }

  const result = new Date(from.getTime() + daysAhead * 86_400_000);
  const dateStr = result.toLocaleDateString("en-CA", { timeZone: tz });
  const isoStr = `${dateStr}T${String(targetH).padStart(2, "0")}:${String(targetM).padStart(2, "0")}:00`;

  const naiveUtc = new Date(isoStr + "Z");
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(naiveUtc);

  const get = (type: string) => Number(tzParts.find((p) => p.type === type)?.value ?? 0);
  const tzAtNaive = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")));
  const offset = tzAtNaive.getTime() - naiveUtc.getTime();
  const finalDate = new Date(naiveUtc.getTime() - offset);

  if (finalDate.getTime() <= from.getTime()) {
    return parseCronNext(schedule, new Date(from.getTime() + 86_400_000), tz);
  }

  return finalDate;
}

/**
 * Parse natural-language schedule strings into cron format understood by parseCronNext.
 * Examples:
 *   "every day at 8 AM"           → "08:00"
 *   "every Monday at 9:30"        → "mon 09:30"
 *   "every weekday at 6pm"        → "mon,tue,wed,thu,fri 18:00"
 *   "every weekend at 10 am"      → "sat,sun 10:00"
 *   "every Monday and Wednesday"  → "mon,wed 08:00"  (defaults to 08:00 if no time)
 * Returns null if the text doesn't look like a schedule.
 */
export function parseNaturalSchedule(text: string): string | null {
  const lower = text.toLowerCase().trim();

  // Extract time: "8 am", "9:30 pm", "14:00", "9", "9 o'clock"
  const timeRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*o'?clock)?/;
  const timeMatch = lower.match(timeRe);
  let hour = 8;
  let minute = 0;
  let hasTime = false;
  if (timeMatch) {
    hasTime = true;
    hour = parseInt(timeMatch[1]!);
    minute = parseInt(timeMatch[2] ?? "0");
    const mer = timeMatch[3];
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    // Ambiguous single-digit w/ no am/pm: treat noon+ as pm if < 8 (e.g. "at 7" = 07:00, "at 3" = 15:00)
    if (!mer && hour < 8 && hour !== 0) hour += 12;
  }
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  // Named shorthand patterns
  if (/every\s+day|daily|each\s+day/.test(lower)) return timeStr;
  if (/every\s+weekday|weekdays|monday.+through.+friday|mon.+fri/.test(lower)) return `mon,tue,wed,thu,fri ${timeStr}`;
  if (/every\s+weekend|weekends/.test(lower)) return `sat,sun ${timeStr}`;
  if (/every\s+morning/.test(lower)) return hasTime ? timeStr : "08:00";
  if (/every\s+evening/.test(lower)) return hasTime ? timeStr : "18:00";
  if (/every\s+night/.test(lower)) return hasTime ? timeStr : "21:00";

  // Specific weekday(s)
  const DAY_PATTERNS: Array<[RegExp, string]> = [
    [/monday|mondays|\bmon\b/, "mon"],
    [/tuesday|tuesdays|\btue\b/, "tue"],
    [/wednesday|wednesdays|\bwed\b/, "wed"],
    [/thursday|thursdays|\bthu\b/, "thu"],
    [/friday|fridays|\bfri\b/, "fri"],
    [/saturday|saturdays|\bsat\b/, "sat"],
    [/sunday|sundays|\bsun\b/, "sun"],
  ];
  const days: string[] = [];
  for (const [re, abbr] of DAY_PATTERNS) {
    if (re.test(lower)) days.push(abbr);
  }
  if (days.length > 0) return `${days.join(",")} ${timeStr}`;

  // If we found a time but no day context, assume daily
  if (hasTime && /every|each|repeat|recurring|remind/.test(lower)) return timeStr;

  return null;
}

export function validateTimezone(tz: string): boolean {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

export function isActiveHours(tz: string, startHour = 8, endHour = 23): boolean {
  const { hour } = nowInTz(new Date(), tz);
  return hour >= startHour && hour < endHour;
}
