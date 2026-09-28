// Headless census tick.
//
// The in-page runner in `census-runner.ts` can only work while somebody has a
// tab open, which is not a census — it is a chore with a progress bar. This is
// the same walk with no browser: one bounded slice of a declared range, driven
// by a scheduler, resumable from the offset the last tick persisted.
//
// It runs the identical reduction (`census-core.ts`) as the page, so a figure
// collected by a cron job and a figure collected by hand are the same kind of
// figure. It writes through PostgREST with the service role key, because
// `log_census_events` and `census_cursor_upsert` deliberately refuse an
// anonymous session: a crawl that silently failed to persist would waste hours
// of somebody else's server.
//
// Still no identity: a registration number exists inside this process only for
// the two requests that read it. The only thing persisted is the offset.
import {
  DEFAULT_RATE_MS,
  loadStudent,
  observeStudent,
  parseCensusRange,
  rollAt,
  sleep,
  type CensusFetchers,
  type CensusObservation,
  type CensusRuntime,
} from "./census-core";
import {
  setUpstreamLogger,
  studentDetails as upstreamStudentDetails,
  subjects as upstreamSubjects,
} from "./bput-upstream";

/* ───────────────────────────────────────────────────────────── config ─── */

export interface CensusTickConfig {
  supabaseUrl: string;
  serviceKey: string;
  rangeStart: string;
  rangeEnd: string;
  /** Wall-clock budget for this tick. The crawl is sliced, never endless. */
  seconds: number;
  rateMs: number;
  probeBackPapers: boolean;
  /** Observations per write. */
  batchSize: number;
  /** Never let the live counter sit still longer than this. */
  flushMs: number;
}

const DEFAULT_SECONDS = 240;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_FLUSH_MS = 15_000;

type Env = Record<string, string | undefined>;

function firstEnv(env: Env, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function boolEnv(env: Env, name: string): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Read configuration from the environment. Throws with the exact missing key
 * name rather than a generic failure, because this runs in a scheduler log
 * nobody is watching.
 */
export function readCensusConfig(env: Env = process.env): CensusTickConfig {
  const supabaseUrl = firstEnv(env, "SUPABASE_URL", "VITE_SUPABASE_URL");
  // Either the legacy service-role JWT or the new-format secret key.
  const serviceKey = firstEnv(env, "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
  const rangeStart = firstEnv(env, "CENSUS_RANGE_START");
  const rangeEnd = firstEnv(env, "CENSUS_RANGE_END");

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!rangeStart) missing.push("CENSUS_RANGE_START");
  if (!rangeEnd) missing.push("CENSUS_RANGE_END");
  if (missing.length > 0) {
    throw new Error(`Missing census configuration: ${missing.join(", ")}.`);
  }

  return {
    supabaseUrl: supabaseUrl!.replace(/\/+$/, ""),
    serviceKey: serviceKey!,
    rangeStart: rangeStart!,
    rangeEnd: rangeEnd!,
    seconds: Math.max(20, intEnv(env, "CENSUS_SECONDS", DEFAULT_SECONDS)),
    rateMs: Math.max(200, intEnv(env, "CENSUS_RATE_MS", DEFAULT_RATE_MS)),
    probeBackPapers: boolEnv(env, "CENSUS_PROBE_BACKPAPERS"),
    batchSize: Math.min(200, Math.max(1, intEnv(env, "CENSUS_BATCH_SIZE", DEFAULT_BATCH_SIZE))),
    flushMs: Math.max(2_000, intEnv(env, "CENSUS_FLUSH_MS", DEFAULT_FLUSH_MS)),
  };
}

/* ──────────────────────────────────────────────────────────── postgrest ─── */

class CensusWriteError extends Error {}

function restHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: key,
  };
  // New-format Supabase keys are opaque strings, not bearer JWTs; sending them
  // as a bearer token makes the gateway reject the request.
  if (!key.startsWith("sb_publishable_") && !key.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function rpc<T>(config: CensusTickConfig, fn: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: restHeaders(config.serviceKey),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new CensusWriteError(`${fn} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CensusWriteError(`${fn} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/* ───────────────────────────────────────────────────────────── summary ─── */

export interface CensusTickSummary {
  rangeStart: string;
  rangeEnd: string;
  total: number;
  resumedFrom: number;
  nextIndex: number;
  /** Probes made this tick. */
  visited: number;
  students: number;
  notFound: number;
  observations: number;
  stored: number;
  /** Upstream requests actually issued, counted, not estimated. */
  requests: number;
  status: "done" | "budget" | "interrupted" | "failed";
  seconds: number;
  error: string | null;
}

/* ─────────────────────────────────────────────────────────────── tick ─── */

/**
 * Run one bounded slice of a census range. Never throws for upstream problems
 * (they become `unreachable` observations, which is data). Throws only when the
 * database refuses the write, because that is the one failure that makes the
 * whole tick pointless.
 */
export async function runCensusTick(
  config: CensusTickConfig,
  now: () => number = Date.now,
): Promise<CensusTickSummary> {
  const { start, end, width, total } = parseCensusRange(config.rangeStart, config.rangeEnd);

  const cursor = await rpc<{ exists: boolean; nextIndex: number; status: string }>(
    config,
    "census_cursor_state",
    { _range_start: start, _range_end: end },
  );
  const resumedFrom = cursor?.exists ? cursor.nextIndex : 0;

  let requests = 0;
  const fetchers: CensusFetchers = {
    studentDetails: (rollNo) => {
      requests += 1;
      return upstreamStudentDetails(rollNo);
    },
    subjects: (input) => {
      requests += 1;
      return upstreamSubjects(input);
    },
  };

  const startedAt = now();
  const deadline = startedAt + config.seconds * 1_000;

  const runtime: CensusRuntime = {
    rateMs: config.rateMs,
    probeBackPapers: config.probeBackPapers,
  };

  const summary: CensusTickSummary = {
    rangeStart: start,
    rangeEnd: end,
    total,
    resumedFrom,
    nextIndex: resumedFrom,
    visited: 0,
    students: 0,
    notFound: 0,
    observations: 0,
    stored: 0,
    requests: 0,
    status: "budget",
    seconds: 0,
    error: null,
  };

  if (resumedFrom >= total) {
    summary.status = "done";
    return summary;
  }

  let pending: CensusObservation[] = [];
  let winVisited = 0;
  let winNotFound = 0;
  let winStored = 0;
  let lastFlushAt = startedAt;
  let interrupted = false;

  const onSignal = () => {
    interrupted = true;
  };
  const signals = process as unknown as { once?: (s: string, f: () => void) => void };
  signals.once?.("SIGTERM", onSignal);
  signals.once?.("SIGINT", onSignal);

  const flush = async (status: "running" | "paused" | "done") => {
    if (pending.length > 0) {
      const rows = pending;
      pending = [];
      const stored = await rpc<number>(config, "log_census_events", { _rows: rows });
      winStored += typeof stored === "number" ? stored : 0;
    }
    await rpc<number>(config, "census_cursor_upsert", {
      _range_start: start,
      _range_end: end,
      _next_index: summary.nextIndex,
      _visited_add: winVisited,
      _not_found_add: winNotFound,
      _facts_add: winStored,
      _status: status,
    });
    winVisited = 0;
    winNotFound = 0;
    winStored = 0;
    lastFlushAt = now();
  };

  let index = resumedFrom;
  try {
    while (index < total) {
      if (interrupted || now() >= deadline - 1_000) break;

      const rollNo = rollAt(start, index, width);
      await sleep(config.rateMs);

      const student = await loadStudent(fetchers, rollNo);
      summary.visited += 1;
      winVisited += 1;

      if (student === null) {
        summary.notFound += 1;
        winNotFound += 1;
      } else if (student !== undefined) {
        summary.students += 1;
        const observations = await observeStudent(fetchers, student, rollNo, runtime);
        summary.observations += observations.length;
        if (observations.length > 0) pending.push(...observations);
      }

      if (interrupted) {
        index += 1;
        summary.nextIndex = index;
        break;
      }

      index += 1;
      summary.nextIndex = index;

      const dueBySize = pending.length >= config.batchSize;
      const dueByTime = now() - lastFlushAt >= config.flushMs;
      if (pending.length > 0 && (dueBySize || dueByTime)) {
        await flush(index >= total ? "done" : "running");
      }
    }

    if (index >= total) summary.status = "done";
    else if (interrupted) summary.status = "interrupted";
    else summary.status = "budget";

    await flush(summary.status === "done" ? "done" : "paused");
  } catch (e) {
    summary.status = "failed";
    summary.error = (e as Error)?.message ?? String(e);
    // Best effort: park the cursor so the next tick resumes rather than
    // restarting from zero. A failed park is not worth masking the real error.
    try {
      await flush("paused");
    } catch {
      /* the original failure is the one worth reporting */
    }
    throw Object.assign(new Error(summary.error), { summary });
  } finally {
    summary.seconds = Math.round((now() - startedAt) / 100) / 10;
    summary.requests = requests;
    setUpstreamLogger(null);
  }

  return summary;
}

/** Run a tick from process env and report it the way a CI log wants. */
export async function runCensusTickFromEnv(env: Env = process.env): Promise<CensusTickSummary> {
  const config = readCensusConfig(env);
  const at = () => new Date().toISOString().slice(11, 19);
  setUpstreamLogger((line) => console.log(`${at()} [bput] ${line}`));

  console.log(
    `[census] tick starting — range ${config.rangeStart}..${config.rangeEnd}, ` +
      `budget ${config.seconds}s, pace ${config.rateMs}ms`,
  );

  const summary = await runCensusTick(config);
  console.log(`[census] ${JSON.stringify(summary)}`);
  return summary;
}
