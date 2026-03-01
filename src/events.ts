/**
 * Lightweight event bus for real-time server-sent events.
 *
 * Any module can emit events; the dashboard SSE endpoint subscribes and
 * forwards them to connected browser clients — zero polling, zero latency.
 */

import { logError } from "./log.js";

export type KodaEventName = "spawn" | "subagent_update" | "heartbeat";

type Listener = (name: KodaEventName, data: unknown) => void;

const listeners = new Set<Listener>();

/** Subscribe to all events. Returns an unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Broadcast an event to all active SSE connections. */
export function emit(name: KodaEventName, data: unknown = {}): void {
  for (const fn of listeners) {
    try { fn(name, data); } catch (err) {
      logError("events", `listener error on ${name}`, err);
    }
  }
}

/** Number of active SSE client connections. */
export function connectionCount(): number {
  return listeners.size;
}
