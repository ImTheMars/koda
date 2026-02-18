/**
 * Ebbinghaus memory decay + reinforcement.
 *
 * Strength formula: S(t) = S0 * 0.5^(daysSinceRecall / halfLife)
 * Each sector has a different half-life. Usage reinforces strength.
 * Memories below archiveThreshold get archived on the daily sweep.
 *
 * Reflection: compresses old episodic memories into semantic ones
 * using a deep LLM call, then archives the originals.
 */

import { memories as dbMemories, state as dbState } from "../db.js";
import type { MemorySector, MemoryRow } from "../db.js";
import { log } from "../log.js";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

const HALF_LIVES_DAYS: Record<MemorySector, number> = {
  episodic: 7,
  semantic: 60,
  factual: 365,
  procedural: 90,
  reflective: 180,
};

/** Compute decayed strength for a memory row. */
export function computeDecayedStrength(row: MemoryRow, aggressiveness = 1.0): number {
  const halfLife = HALF_LIVES_DAYS[row.sector] / aggressiveness;
  const lastDate = row.lastRecalledAt ?? row.rememberedAt;
  const daysSince = (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24);
  return row.strength * Math.pow(0.5, daysSince / halfLife);
}

/** Reinforcement: boost strength on recall (bounded at 1.0). */
export function reinforcedStrength(current: number): number {
  return Math.min(1.0, current + (1 - current) * 0.3);
}

/** Run the daily decay sweep for a user. Archives weak memories. */
export async function runDecay(
  userId: string,
  archiveThreshold: number,
  aggressiveness: number,
): Promise<{ decayed: number; archived: number }> {
  const rows = dbMemories.getForDecay(userId);
  if (!rows.length) return { decayed: 0, archived: 0 };

  let decayed = 0;
  const toArchive: string[] = [];

  for (const row of rows) {
    const newStrength = computeDecayedStrength(row, aggressiveness);

    if (newStrength < archiveThreshold) {
      toArchive.push(row.id);
    } else if (Math.abs(newStrength - row.strength) > 0.001) {
      dbMemories.updateStrength(row.id, newStrength);
      decayed++;
    }
  }

  if (toArchive.length) {
    dbMemories.archiveBatch(toArchive);
  }

  dbState.set(`last_decay_${userId}`, new Date().toISOString());
  log("decay", "user=%s decayed=%d archived=%d", userId, decayed, toArchive.length);

  return { decayed, archived: toArchive.length };
}

/** Reinforce a specific memory on recall (in-memory update). */
export function reinforceMemory(memoryId: string, currentStrength: number): void {
  const newStrength = reinforcedStrength(currentStrength);
  dbMemories.updateStrength(memoryId, newStrength);
}

/** Weekly reflection: summarise old episodic memories into a semantic one. */
export async function runReflection(
  userId: string,
  apiKey: string,
  deepModel: string,
  insertMemoryFn: (content: string, sector: MemorySector, tags: string[]) => Promise<string>,
): Promise<{ reflected: number; compressed: number }> {
  // Pull old episodic memories (>7 days, lowest strength first)
  const candidates = dbMemories.getForReflection(userId, "episodic", 7, 30);
  if (candidates.length < 5) {
    dbState.set(`last_reflect_${userId}`, new Date().toISOString());
    return { reflected: 0, compressed: 0 };
  }

  const contentBlock = candidates.map((m, i) => `${i + 1}. [${m.eventAt.slice(0, 10)}] ${m.content}`).join("\n");

  try {
    const openrouter = createOpenRouter({ apiKey });
    const { text } = await generateText({
      model: openrouter(deepModel),
      prompt: `You are summarizing episodic memories into long-term insights.
Below are ${candidates.length} episodic memories. Extract 2-4 meaningful semantic insights
(preferences, patterns, important facts) that should be remembered long-term.
Write each insight as a single clear sentence. Return as a JSON array of strings.

Memories:
${contentBlock}

JSON array of insights:`,
      maxTokens: 400,
      temperature: 0.3,
    });

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      dbState.set(`last_reflect_${userId}`, new Date().toISOString());
      return { reflected: 0, compressed: 0 };
    }

    const insights = JSON.parse(match[0]) as string[];
    let reflected = 0;

    for (const insight of insights.filter((s) => typeof s === "string" && s.length > 10).slice(0, 4)) {
      await insertMemoryFn(insight, "reflective", ["auto-reflection"]);
      reflected++;
    }

    // Archive the compressed episodics
    dbMemories.archiveBatch(candidates.map((m) => m.id));
    dbState.set(`last_reflect_${userId}`, new Date().toISOString());

    log("decay", "reflect user=%s insights=%d compressed=%d", userId, reflected, candidates.length);
    return { reflected, compressed: candidates.length };
  } catch (err) {
    log("decay", "reflect failed: %s", (err as Error).message);
    dbState.set(`last_reflect_${userId}`, new Date().toISOString());
    return { reflected: 0, compressed: 0 };
  }
}

/** Check if the daily decay should run (once per day). */
export function shouldRunDecay(userId: string): boolean {
  const lastRun = dbState.get<string>(`last_decay_${userId}`);
  if (!lastRun) return true;
  const hoursSince = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
  return hoursSince >= 23;
}

/** Check if weekly reflection should run (once per 7 days). */
export function shouldRunReflection(userId: string, schedule: "daily" | "weekly" | "never"): boolean {
  if (schedule === "never") return false;
  const lastRun = dbState.get<string>(`last_reflect_${userId}`);
  if (!lastRun) return true;
  const daysSince = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60 * 24);
  return schedule === "daily" ? daysSince >= 1 : daysSince >= 7;
}
