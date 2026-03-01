/**
 * LLM Simulator — generates realistic user messages from scenario descriptions.
 *
 * Uses the fast model via OpenRouter to create messages that match Koda's typical user persona:
 * casual, lowercase, slang, technically skilled, impatient.
 */

import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const SYSTEM_PROMPT = `You are simulating a user of an AI assistant called Koda.
The user persona:
- Casual, uses lowercase, minimal punctuation
- Technically skilled (developer/engineer)
- Uses slang and abbreviations (nvm, tbh, ngl, lmk)
- Impatient, gets straight to the point
- Never overly polite or formal

You will be given a scenario description. Generate ONLY the user's message — no quotes, no explanation, no prefix.
The message should feel natural, like a real person typing in a chat.
Keep it short (1-2 sentences max) unless the scenario calls for more.`;

export interface SimulatorOptions {
  apiKey: string;
  model: string;
}

let provider: ReturnType<typeof createOpenRouter> | null = null;
let simulatorCost = 0;

export function getSimulatorCost(): number {
  return simulatorCost;
}

export async function simulateUserMessage(
  scenario: string,
  previousResponse?: string,
  options?: SimulatorOptions,
): Promise<string> {
  if (!options) throw new Error("Simulator options required (apiKey + model)");

  if (!provider) {
    provider = createOpenRouter({ apiKey: options.apiKey });
  }

  const userPrompt = previousResponse
    ? `Scenario: ${scenario}\n\nThe AI assistant previously responded:\n"${previousResponse.slice(0, 500)}"\n\nGenerate the user's follow-up message:`
    : `Scenario: ${scenario}\n\nGenerate the user's message:`;

  const result = await generateText({
    model: provider(options.model),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxOutputTokens: 200,
    temperature: 0.8,
  });

  // Track approximate cost
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  simulatorCost += (inputTokens * 0.5 + outputTokens * 3) / 1_000_000;

  return result.text.trim();
}

/** Reset cost tracking between runs. */
export function resetSimulatorCost(): void {
  simulatorCost = 0;
}
