// In-memory, per-tab cache of real BPUT semester fetches. Never persisted
// (no localStorage, no cookies) so registration numbers never sit at rest.
// Only successful, non-empty real fetches are stored. The cache exists so
// that the dev-only HUD can distinguish LIVE re-fetches from CACHE hits
// during a demo, audience-facing UI never sees this data.
import type { SubjectsResponse } from "./sgpa";

type Source = "LIVE" | "CACHE";

interface Entry {
  data: SubjectsResponse;
  fetchedAt: number;
}

const memory = new Map<string, Entry>();

// Ephemeral log of every observed fetch outcome, powers the dev HUD.
export interface CacheEvent {
  rollNo: string;
  semId: string;
  session: string;
  source: Source;
  at: number;
}
const events: CacheEvent[] = [];
const listeners = new Set<() => void>();

function key(rollNo: string, semId: string, session: string) {
  return `${rollNo}::${semId}::${session}`;
}

function notify() {
  for (const l of listeners) l();
}

export function readCache(rollNo: string, semId: string, session: string): SubjectsResponse | null {
  return memory.get(key(rollNo, semId, session))?.data ?? null;
}

export function writeCache(rollNo: string, semId: string, session: string, data: SubjectsResponse) {
  memory.set(key(rollNo, semId, session), { data, fetchedAt: Date.now() });
}

export function recordEvent(rollNo: string, semId: string, session: string, source: Source) {
  events.push({ rollNo, semId, session, source, at: Date.now() });
  if (events.length > 200) events.splice(0, events.length - 200);
  notify();
}

export function getEvents(): readonly CacheEvent[] {
  return events;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function clearEvents() {
  events.length = 0;
  notify();
}
