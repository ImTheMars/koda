/**
 * Follow-up intent detection — pattern-based (no LLM, runs every message).
 *
 * Detects implicit future intents like "I'll do X tomorrow" and creates
 * one-shot reminders. Skips explicit "remind me" (handled by schedule tools).
 */

export interface FollowupIntent {
  action: string;
  timeExpression: string;
  delayMs: number;
  prompt: string;
}

// Patterns that indicate a future action the user mentioned casually
const INTENT_PATTERNS = [
  /\bi(?:'ll|'ll| will)\s+(.{5,80}?)\s+(tomorrow|tonight|next week|this weekend|on monday|on tuesday|on wednesday|on thursday|on friday|on saturday|on sunday|later today)\b/i,
  /\bi\s+(?:need|have|gotta|should|got)\s+(?:to\s+)?(.{5,80}?)\s+(?:by|before)\s+(tomorrow|tonight|next week|this weekend|monday|tuesday|wednesday|thursday|friday|end of (?:the )?(?:day|week))\b/i,
  /\b(?:gotta|should|need to|let me)\s+(.{5,80}?)\s+(tomorrow|tonight|next week|this weekend|on monday|on tuesday|on wednesday|on thursday|on friday)\b/i,
];

// Skip if user explicitly asks for a reminder (schedule tools handle that)
const EXPLICIT_REMINDER_RE = /\bremind\s+me\b/i;

const TIME_EXPRESSIONS: Record<string, () => number> = {
  "tomorrow": () => 24 * 60 * 60 * 1000,
  "tonight": () => 6 * 60 * 60 * 1000,
  "later today": () => 4 * 60 * 60 * 1000,
  "next week": () => 7 * 24 * 60 * 60 * 1000,
  "this weekend": () => {
    const now = new Date();
    const day = now.getDay();
    const daysToSat = (6 - day + 7) % 7 || 7;
    return daysToSat * 24 * 60 * 60 * 1000;
  },
  "end of day": () => {
    const now = new Date();
    const end = new Date(now);
    end.setHours(18, 0, 0, 0);
    return Math.max(end.getTime() - now.getTime(), 60 * 60 * 1000);
  },
  "end of the day": () => TIME_EXPRESSIONS["end of day"]!(),
  "end of week": () => {
    const now = new Date();
    const day = now.getDay();
    const daysToFri = (5 - day + 7) % 7 || 7;
    return daysToFri * 24 * 60 * 60 * 1000;
  },
  "end of the week": () => TIME_EXPRESSIONS["end of week"]!(),
};

// Map weekday names to delay
const WEEKDAY_MAP: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 0,
};

function resolveTimeExpression(expr: string): number {
  const lower = expr.toLowerCase().replace(/^on\s+/, "");

  // Check direct map
  const direct = TIME_EXPRESSIONS[lower];
  if (direct) return direct();

  // Check weekday
  const weekday = WEEKDAY_MAP[lower];
  if (weekday !== undefined) {
    const now = new Date();
    const currentDay = now.getDay();
    let daysUntil = (weekday - currentDay + 7) % 7;
    if (daysUntil === 0) daysUntil = 7; // next occurrence
    return daysUntil * 24 * 60 * 60 * 1000;
  }

  // Default fallback: 24 hours
  return 24 * 60 * 60 * 1000;
}

export function detectFollowup(userMessage: string): FollowupIntent | null {
  // Skip explicit reminder requests
  if (EXPLICIT_REMINDER_RE.test(userMessage)) return null;

  for (const pattern of INTENT_PATTERNS) {
    const match = userMessage.match(pattern);
    if (match) {
      const action = match[1]!.trim();
      const timeExpr = match[2]!.trim();
      const delayMs = resolveTimeExpression(timeExpr);

      return {
        action,
        timeExpression: timeExpr,
        delayMs,
        prompt: `Hey, you mentioned you'd "${action}" (${timeExpr}). Just checking in — did you get to it?`,
      };
    }
  }

  return null;
}
