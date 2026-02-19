/**
 * Process metrics — lightweight ring buffer for memory samples.
 * Populated by index.ts every 5 s, consumed by dashboard /api/memory.
 */

export interface MemSample {
  ts: number;
  heapMB: number;
  rssMB: number;
  externalMB: number;
}

const SAMPLE_LIMIT = 120; // 10 minutes @ 5 s interval
const samples: MemSample[] = [];

export function recordMemSample(): void {
  const m = process.memoryUsage();
  samples.push({
    ts: Date.now(),
    heapMB: +(m.heapUsed / 1_048_576).toFixed(1),
    rssMB: +(m.rss / 1_048_576).toFixed(1),
    externalMB: +(m.external / 1_048_576).toFixed(1),
  });
  if (samples.length > SAMPLE_LIMIT) samples.shift();
}

export function getMemSamples(): MemSample[] {
  return [...samples];
}

export function latestMem(): MemSample | null {
  return samples[samples.length - 1] ?? null;
}
