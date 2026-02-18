/**
 * OpenRouter embeddings client.
 *
 * Uses the OpenAI-compatible /api/v1/embeddings endpoint.
 * Batches up to 100 texts per request, caches by content hash to avoid
 * re-embedding identical content across sessions.
 */

import { state as dbState } from "../db.js";
import { log } from "../log.js";

const EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const BATCH_SIZE = 100;
const CACHE_PREFIX = "embed_cache_";

function contentHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(36);
}

export class EmbeddingService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "openai/text-embedding-3-large") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];

    // Check cache for each text
    const results: (Float32Array | null)[] = texts.map((t) => {
      const key = CACHE_PREFIX + contentHash(t);
      const cached = dbState.get<number[]>(key);
      return cached ? new Float32Array(cached) : null;
    });

    // Collect indices that need embedding
    const missing = texts
      .map((_, i) => i)
      .filter((i) => results[i] === null);

    if (missing.length === 0) {
      log("embed", "all %d from cache", texts.length);
      return results as Float32Array[];
    }

    // Batch API calls
    const missingTexts = missing.map((i) => texts[i]!);
    const embeddings = await this._batchEmbed(missingTexts);

    // Store results and cache
    for (let j = 0; j < missing.length; j++) {
      const i = missing[j]!;
      const vec = embeddings[j]!;
      results[i] = vec;
      try {
        dbState.set(CACHE_PREFIX + contentHash(texts[i]!), Array.from(vec));
      } catch {}
    }

    log("embed", "embedded %d new, %d cached", missing.length, texts.length - missing.length);
    return results as Float32Array[];
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [vec] = await this.embed([text]);
    return vec!;
  }

  private async _batchEmbed(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];

    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const vecs = await this._callApi(batch);
      results.push(...vecs);
    }

    return results;
  }

  private async _callApi(texts: string[], retries = 3): Promise<Float32Array[]> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(EMBED_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
        }

        const json = await res.json() as { data: Array<{ embedding: number[] }> };
        return json.data.map((d) => new Float32Array(d.embedding));
      } catch (err) {
        if (attempt === retries) throw err;
        await Bun.sleep(500 * attempt);
      }
    }
    throw new Error("Embedding failed after retries");
  }
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
