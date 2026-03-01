/**
 * Exponential backoff retry helper with jitter.
 *
 * Used by external API calls (Exa, GitHub, Composio, MCP reconnect)
 * to gracefully handle transient failures.
 */

import { logWarn } from "./log.js";

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay in ms between retries (default: 15000). */
  maxDelayMs?: number;
  /** Tag for log messages (default: "retry"). */
  tag?: string;
  /** Custom predicate — return false to abort retries early. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Wrap an async function with exponential backoff + jitter.
 *
 * Retries on any thrown error up to `maxRetries` times.
 * Delay between attempts: min(baseDelayMs * 2^attempt + jitter, maxDelayMs).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15_000,
    tag = "retry",
    shouldRetry,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries) break;
      if (shouldRetry && !shouldRetry(err, attempt)) break;

      const jitter = Math.random() * baseDelayMs * 0.5;
      const delay = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
      logWarn(tag, `attempt ${attempt + 1}/${maxRetries} failed: ${(err as Error).message} — retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
