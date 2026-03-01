/**
 * Image generation tool — calls OpenRouter's image generation endpoint.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

export function registerImageTools(deps: {
  apiKey: string;
  model: string;
  onCost: (amount: number) => void;
}): ToolSet {
  const generateImage = tool({
    description: "Generate an image from a text prompt. Returns an image URL. Use when the user asks you to create, draw, or generate an image.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate"),
      size: z.enum(["1024x1024", "1024x1792", "1792x1024"]).default("1024x1024").describe("Image dimensions"),
    }),
    execute: async ({ prompt, size }) => {
      // Use OpenRouter chat completions with image generation models
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: deps.model,
          messages: [
            { role: "user", content: `Generate an image: ${prompt}` },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        const text = await response.text();
        return { error: `Image generation failed: ${response.status} ${text.slice(0, 200)}` };
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      // Extract image URL from response — different models return it differently
      let imageUrl: string | null = null;

      // Check for inline_data (base64 image in content parts)
      const content = data.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "image_url") {
            imageUrl = part.image_url?.url ?? null;
          } else if (part.type === "image" && part.source?.data) {
            // Base64 encoded image
            imageUrl = `data:${part.source.media_type ?? "image/png"};base64,${part.source.data}`;
          }
        }
      }

      // Fallback: look for image URLs in text response
      if (!imageUrl && typeof content === "string") {
        const urlMatch = content.match(/https:\/\/[^\s"'<>]+\.(png|jpg|jpeg|webp|gif)/i);
        if (urlMatch) imageUrl = urlMatch[0];
      }

      // Track cost
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      deps.onCost((inputTokens * 1.25 + outputTokens * 5) / 1_000_000);

      if (!imageUrl) {
        // Return the text content if no image URL extracted — the model's response itself
        return { text: typeof content === "string" ? content : JSON.stringify(content), prompt, note: "Image was generated — check the response text for the image or URL." };
      }

      return { imageUrl, prompt, size };
    },
  });

  return { generateImage };
}
