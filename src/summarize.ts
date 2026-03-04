/**
 * Conversation summarization — sends trimmed messages to fast LLM
 * and stores bullet-point summaries in the database.
 */

import { messages as dbMessages, summaries as dbSummaries } from "./db.js";
import { log } from "./log.js";
import type { Config } from "./config.js";

/**
 * Summarize recent unsummarized messages for a session and store the result.
 * Intended to be called async (non-blocking) from finalizeResult().
 */
export async function summarizeAndStore(sessionKey: string, config: Config): Promise<void> {
  const msgCount = dbMessages.count(sessionKey);
  const latestSummary = dbSummaries.getLatest(sessionKey, 1);
  const summarizedUpTo = latestSummary.length > 0 ? latestSummary[0]!.messageRangeEnd : 0;

  if (msgCount - summarizedUpTo < config.agent.summarizationBatchSize) return;

  // Fetch the unsummarized messages (from history, most recent batch)
  const allHistory = dbMessages.getHistory(sessionKey, 50);
  const batchSize = config.agent.summarizationBatchSize;
  // Take the oldest unsummarized messages (up to batchSize)
  const toSummarize = allHistory.slice(0, batchSize);

  if (toSummarize.length < 3) return; // too few to summarize

  const conversation = toSummarize
    .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
    .join("\n");

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openrouter.fastModel,
        messages: [{
          role: "user",
          content: `Summarize this conversation in 3-5 bullet points. Focus on:
- Decisions made
- Facts established
- Tasks discussed or completed
- User preferences expressed
${sessionKey.includes("-") ? "- Who said what (messages may be prefixed with [sender name])\n- Action items and responsibilities per person" : ""}

Keep each bullet concise (one sentence). Return only the bullet points, nothing else.

Conversation:
${conversation}`,
        }],
        max_tokens: 300,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      log("summarize", "LLM call failed: HTTP %d", res.status);
      return;
    }

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) return;

    dbSummaries.store(sessionKey, summary, summarizedUpTo + 1, msgCount);
    log("summarize", "stored summary for session %s (msgs %d-%d)", sessionKey, summarizedUpTo + 1, msgCount);
  } catch (err) {
    log("summarize", "failed: %s", (err as Error).message);
  }
}
