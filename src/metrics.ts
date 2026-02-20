/**
 * Process metrics — lightweight ring buffer for memory samples.
 * Populated by index.ts every 5 s, consumed by dashboard /api/memory
 * and broadcast in real-time via the SSE event bus.
 */

import { emit } from "./events.js";

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
  const sample: MemSample = {
    ts: Date.now(),
    heapMB: +(m.heapUsed / 1_048_576).toFixed(1),
    rssMB: +(m.rss / 1_048_576).toFixed(1),
    externalMB: +(m.external / 1_048_576).toFixed(1),
  };
  samples.push(sample);
  if (samples.length > SAMPLE_LIMIT) samples.shift();

  // Real-time push to dashboard SSE clients
  emit("memory", sample);
}

export function getMemSamples(): MemSample[] {
  return [...samples];
}

export function latestMem(): MemSample | null {
  return samples[samples.length - 1] ?? null;
}
