// Headless census tick.
//
// The in-page runner in `census-runner.ts` can only work while somebody has a
// tab open, which is not a census — it is a chore with a progress bar. This is
// the same walk with no browser, driven by a scheduler, resumable from the
// offset the last tick persisted, and pointed at the measured grid in
// `census-blocks.ts` rather than at one hand-typed range.
//
// It runs the identical reduction (`census-core.ts`) as the page, so a figure
// collected by a cron job and a figure collected by hand are the same kind of
// figure. It writes through PostgREST with the service role key, because
// `log_census_events` and `census_cursor_upsert` deliberately refuse an
// anonymous session: a crawl that silently failed to persist would waste hours
// of somebody else's server.
//
// Still no identity: a registration number exists inside this process only for
// the requests that read it. The only thing persisted is the offset.
//
// Concurrency is bounded and lives *across blocks*, never inside one. Each
// worker owns one college-year at a time and walks its serials in order, so a
// block's cursor stays meaningful and the upstream never sees more than
// `concurrency` requests at once. Effective rate is `concurrency / rateMs`; the
// per-request delay is unchanged, so politeness does not degrade with scale.
import {
  DEFAULT_RATE_MS,
  RateGovernor,
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
  CENSUS_YEARS,
  SKIP_AFTER_MISSES,
  censusBlocks,
  estimatedRequests,
  type CensusBlock,
} from "./census-blocks";
import {
  setUpstreamLogger,
  studentDetails as upstreamStudentDetails,
  subjects as upstreamSubjects,
} from "./bput-upstream";

/* ───────────────────────────────────────────────────────────── config ─── */

export interface CensusTickConfig {
  supabaseUrl: string;
  serviceKey: string;
  /** Single-range mode. Null means walk the measured grid instead. */
  rangeStart: string | null;
  rangeEnd: string | null;
  /** Wall-clock budget for this tick. The crawl is sliced, never endless. */
  seconds: number;
  /**
   * Aggregate request ceiling across all workers, in requests per second. The
   * number that actually decides how long the census takes.
   */
  maxRps: number;
  /**
   * When true the governor ramps up from a quarter of `maxRps` and halves on any
   * 429. When false it holds `maxRps` exactly, which is the right choice for a
   * short targeted re-run and the wrong one for a twelve-hour crawl.
   */
  adaptive: boolean;
  /** Fallback per-request delay, used only when the governor is disabled. */
  rateMs: number;
  /** Workers, each owning one college-year block at a time. */
  concurrency: number;
  /** Consecutive misses that finish a block. */
  skipMisses: number;
  /** Start at most this many blocks per tick. 0 means no cap. */
  maxBlocks: number;
  /** Batch years to walk in grid mode. Empty means all of them. */
  years: number[];
  probeBackPapers: boolean;
  /** Observations per write. */
  batchSize: number;
  /** Never let the live counter sit still longer than this. */
  flushMs: number;
}

const DEFAULT_SECONDS = 240;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_FLUSH_MS = 15_000;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;
/**
 * Default aggregate ceiling. Measured tolerance was 35.6 req/s for 45 s; 16 is
 * chosen to sit well under that for a crawl that runs for a day, and it is one
 * environment variable away from being raised.
 */
const DEFAULT_MAX_RPS = 16;
/** Blocks that could not be read from upstream before the tick gives up. */
const TRANSIENT_BLOCKS_BEFORE_QUIT = 4;

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

/** Opt-out flags: absent means on, because the crawl should self-tune by default. */
function boolEnvDefault(env: Env, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return raw === "1" || raw === "true" || raw === "yes";
}

/** `CENSUS_YEARS=23,24,25` (or `2023,2024`) → `[23, 24, 25]`. */
export function parseYears(raw: string | null | undefined): number[] {
  if (!raw || !raw.trim()) return [];
  const out = new Set<number>();
  for (const part of raw.split(/[,\s]+/)) {
    const n = Number(part.trim());
    if (!Number.isFinite(n)) continue;
    // Accept both `23` and `2023`; both mean the batch that started in 2023.
    const year = n >= 2000 ? n - 2000 : n;
    if (year >= 0 && year <= 99) out.add(year);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Read configuration from the environment. Throws with the exact missing key
 * name rather than a generic failure, because this runs in a scheduler log
 * nobody is watching.
 *
 * Two modes: an explicit `CENSUS_RANGE_START`/`CENSUS_RANGE_END` pair walks that
 * one range (the old behaviour, still useful for a targeted re-run), and
 * anything else walks the measured grid, optionally narrowed by `CENSUS_YEARS`.
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
  if (missing.length > 0) {
    throw new Error(`Missing census configuration: ${missing.join(", ")}.`);
  }

  // Half a range is a typo, and guessing the other bound would silently crawl
  // something nobody asked for.
  if (Boolean(rangeStart) !== Boolean(rangeEnd)) {
    throw new Error(
      "CENSUS_RANGE_START and CENSUS_RANGE_END must be set together (or both left unset to walk the measured grid).",
    );
  }

  const years = parseYears(firstEnv(env, "CENSUS_YEARS"));

  return {
    supabaseUrl: supabaseUrl!.replace(/\/+$/, ""),
    serviceKey: serviceKey!,
    rangeStart,
    rangeEnd,
    seconds: Math.max(20, intEnv(env, "CENSUS_SECONDS", DEFAULT_SECONDS)),
    maxRps: Math.max(0.5, intEnv(env, "CENSUS_MAX_RPS", DEFAULT_MAX_RPS)),
    adaptive: boolEnvDefault(env, "CENSUS_ADAPTIVE", true),
    rateMs: Math.max(200, intEnv(env, "CENSUS_RATE_MS", DEFAULT_RATE_MS)),
    concurrency: Math.min(
      MAX_CONCURRENCY,
      Math.max(1, intEnv(env, "CENSUS_CONCURRENCY", DEFAULT_CONCURRENCY)),
    ),
    skipMisses: Math.min(999, Math.max(1, intEnv(env, "CENSUS_SKIP_MISSES", SKIP_AFTER_MISSES))),
    maxBlocks: Math.max(0, intEnv(env, "CENSUS_MAX_BLOCKS", 0)),
    years,
    probeBackPapers: boolEnv(env, "CENSUS_PROBE_BACKPAPERS"),
    batchSize: Math.min(200, Math.max(1, intEnv(env, "CENSUS_BATCH_SIZE", DEFAULT_BATCH_SIZE))),
    flushMs: Math.max(2_000, intEnv(env, "CENSUS_FLUSH_MS", DEFAULT_FLUSH_MS)),
  };
}

/** Grid blocks a config selects, in stable order. */
export function selectedBlocks(config: CensusTickConfig): CensusBlock[] {
  const all = censusBlocks();
  if (config.years.length === 0) return all;
  const wanted = new Set(config.years);
  return all.filter((block) => wanted.has(block.year - 2000));
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
    const err = new CensusWriteError(`${fn} failed (${res.status}): ${text.slice(0, 300)}`);
    // Keep the status: a rejected credential and a rejected payload are the same
    // shape of error to the callers that only log, but not to the preflight.
    throw Object.assign(err, { status: res.status });
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CensusWriteError(`${fn} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/* ───────────────────────────────────────────────────────────── summary ─── */

export type CensusTickStatus = "done" | "budget" | "interrupted" | "failed";

export interface CensusTickSummary {
  mode: "range" | "grid";
  status: CensusTickStatus;
  seconds: number;
  /** Upstream requests actually issued, counted, not estimated. */
  requests: number;
  /** Achieved aggregate rate, computed from real requests and real seconds. */
  requestsPerSecond: number;
  /** Ceiling this run was allowed to reach. */
  maxRps: number;
  /** Where the governor finished (it ramps up, and halves on a 429). */
  finalRps: number;
  /** 429s seen. Zero is the expected answer, and any other number is a finding. */
  rateLimits: number;
  /** Blocks this tick intended to walk. */
  blocksTotal: number;
  /** Blocks that made progress. */
  blocksVisited: number;
  /** Blocks finished — either walked, or given up on after consecutive misses. */
  blocksDone: number;
  /** Blocks finished early because consecutive misses hit the threshold. */
  blocksSkipped: number;
  /** Blocks parked mid-way, waiting for a later tick. */
  blocksPaused: number;
  /** Blocks no worker touched before the budget ran out. */
  blocksDeferred: number;
  /** Blocks left alone because upstream was failing, not because they were empty. */
  blocksUnreachable: number;
  /** Probes made this tick. */
  visited: number;
  students: number;
  notFound: number;
  observations: number;
  stored: number;
  rangeStart: string | null;
  rangeEnd: string | null;
  total: number;
  resumedFrom: number;
  nextIndex: number;
  years: number[];
  error: string | null;
}

function emptySummary(config: CensusTickConfig, mode: "range" | "grid"): CensusTickSummary {
  return {
    mode,
    status: "budget",
    seconds: 0,
    requests: 0,
    requestsPerSecond: 0,
    maxRps: config.maxRps,
    finalRps: config.maxRps,
    rateLimits: 0,
    blocksTotal: 0,
    blocksVisited: 0,
    blocksDone: 0,
    blocksSkipped: 0,
    blocksPaused: 0,
    blocksDeferred: 0,
    blocksUnreachable: 0,
    visited: 0,
    students: 0,
    notFound: 0,
    observations: 0,
    stored: 0,
    rangeStart: config.rangeStart,
    rangeEnd: config.rangeEnd,
    total: 0,
    resumedFrom: 0,
    nextIndex: 0,
    years: config.years,
    error: null,
  };
}

/**
 * Counted upstream requests, shared by every worker so the summary reports the
 * real cost of a tick rather than an estimate.
 */
function countingFetchers(counter: { requests: number }): CensusFetchers {
  return {
    studentDetails: (rollNo) => {
      counter.requests += 1;
      return upstreamStudentDetails(rollNo);
    },
    subjects: (input) => {
      counter.requests += 1;
      return upstreamSubjects(input);
    },
  };
}

/* ─────────────────────────────────────────────────────────── the walk ─── */

type SliceStatus = "done" | "budget" | "interrupted" | "paused";

interface SliceResult {
  /** True when the block could not be read at all (upstream failing, not empty). */
  unreachable: boolean;
  skipped: boolean;
  status: SliceStatus;
  resumedFrom: number;
  nextIndex: number;
  total: number;
  visited: number;
  students: number;
  notFound: number;
  observations: number;
  stored: number;
}

/**
 * Walk one contiguous range until it finishes, the budget runs out, or the
 * serials go quiet.
 *
 * The skip rule is the important part. Serials are dense from 001, so a run of
 * misses means the intake ended — but single-number gaps are real (college 329
 * batch 2023 is missing serials 12, 18 and 32), which is why the threshold is
 * `skipMisses` rather than one. A *transient* upstream failure never counts as a
 * miss: the block is parked at the same serial and retried next tick, because
 * a flaky portal must not be recorded as an empty college.
 */
async function walkRange(
  config: CensusTickConfig,
  range: { start: string; end: string },
  deadline: number,
  runtime: CensusRuntime,
  fetchers: CensusFetchers,
  aborted: () => boolean,
  now: () => number,
): Promise<SliceResult> {
  const { start, end, width, total } = parseCensusRange(range.start, range.end);

  const cursor = await rpc<{ exists: boolean; nextIndex: number }>(config, "census_cursor_state", {
    _range_start: start,
    _range_end: end,
  });
  const resumedFrom = Math.min(Math.max(cursor?.exists ? (cursor.nextIndex ?? 0) : 0, 0), total);

  const res: SliceResult = {
    unreachable: false,
    skipped: false,
    status: "budget",
    resumedFrom,
    nextIndex: resumedFrom,
    total,
    visited: 0,
    students: 0,
    notFound: 0,
    observations: 0,
    stored: 0,
  };

  if (resumedFrom >= total) {
    res.status = "done";
    return res;
  }

  let pending: CensusObservation[] = [];
  let visitDelta = 0;
  let notFoundDelta = 0;
  let storedDelta = 0;
  let consecutiveMisses = 0;
  let lastFlushAt = now();

  const flush = async (status: "running" | "paused" | "done") => {
    if (pending.length > 0) {
      const rows = pending;
      pending = [];
      const stored = await rpc<number>(config, "log_census_events", { _rows: rows });
      const n = typeof stored === "number" ? stored : 0;
      res.stored += n;
      storedDelta += n;
    }
    await rpc<number>(config, "census_cursor_upsert", {
      _range_start: start,
      _range_end: end,
      _next_index: res.nextIndex,
      _visited_add: visitDelta,
      _not_found_add: notFoundDelta,
      _facts_add: storedDelta,
      _status: status,
    });
    visitDelta = 0;
    notFoundDelta = 0;
    storedDelta = 0;
    lastFlushAt = now();
  };

  let index = resumedFrom;
  try {
    while (index < total) {
      if (aborted() || now() >= deadline - 1_000) break;

      const rollNo = rollAt(start, index, width);
      // The governor decides the aggregate pace; `rateMs` is only the fallback
      // when one is not attached (a single `runCensusTick` with pacing off).
      if (runtime.governor) await runtime.governor.acquire();
      else await sleep(config.rateMs);

      const student = await loadStudent(fetchers, rollNo, runtime.governor);
      res.visited += 1;
      visitDelta += 1;

      if (student === undefined) {
        // Upstream trouble, not an empty serial. Park and let the next tick
        // retry this exact number.
        res.unreachable = true;
        res.nextIndex = index;
        res.status = "paused";
        break;
      }

      if (student === null) {
        res.notFound += 1;
        notFoundDelta += 1;
        consecutiveMisses += 1;
      } else {
        consecutiveMisses = 0;
        res.students += 1;
        const observations = await observeStudent(fetchers, student, rollNo, runtime);
        res.observations += observations.length;
        if (observations.length > 0) pending.push(...observations);
      }

      index += 1;
      res.nextIndex = index;

      if (consecutiveMisses >= config.skipMisses) {
        res.skipped = true;
        res.nextIndex = total;
        res.status = "done";
        break;
      }

      const dueBySize = pending.length >= config.batchSize;
      const dueByTime = now() - lastFlushAt >= config.flushMs;
      if (pending.length > 0 && (dueBySize || dueByTime)) await flush("running");
    }

    if (res.status !== "done" && res.status !== "paused") {
      if (aborted()) res.status = "interrupted";
      else if (res.nextIndex >= total) res.status = "done";
    }

    await flush(res.status === "done" ? "done" : "paused");
  } catch (e) {
    // Best effort: park the cursor so the next tick resumes rather than
    // restarting from zero. A failed park is not worth masking the real error.
    try {
      await flush("paused");
    } catch {
      /* the original failure is the one worth reporting */
    }
    throw e;
  }

  return res;
}

/* ─────────────────────────────────────────────────────────────── ticks ─── */

interface Signals {
  once?: (signal: string, fn: () => void) => void;
}

function installSignals(state: { interrupted: boolean }): void {
  const signals = process as unknown as Signals;
  const onSignal = () => {
    state.interrupted = true;
  };
  signals.once?.("SIGTERM", onSignal);
  signals.once?.("SIGINT", onSignal);
}

function merge(summary: CensusTickSummary, slice: SliceResult): void {
  summary.blocksVisited += 1;
  summary.visited += slice.visited;
  summary.students += slice.students;
  summary.notFound += slice.notFound;
  summary.observations += slice.observations;
  summary.stored += slice.stored;
  if (slice.unreachable) summary.blocksUnreachable += 1;
  else if (slice.status === "done") {
    summary.blocksDone += 1;
    if (slice.skipped) summary.blocksSkipped += 1;
  } else summary.blocksPaused += 1;
  summary.resumedFrom = slice.resumedFrom;
  summary.nextIndex = slice.nextIndex;
  summary.total = slice.total;
}

/**
 * Walk one explicitly declared range. Kept for targeted re-runs: a bad block can
 * be re-probed without touching the grid.
 */
export async function runCensusTick(
  config: CensusTickConfig,
  now: () => number = Date.now,
): Promise<CensusTickSummary> {
  if (!config.rangeStart || !config.rangeEnd) {
    throw new Error("runCensusTick needs CENSUS_RANGE_START and CENSUS_RANGE_END.");
  }
  const summary = emptySummary({ ...config, years: [] }, "range");
  summary.blocksTotal = 1;

  const counter = { requests: 0 };
  const state = { interrupted: false };
  installSignals(state);

  const startedAt = now();
  const deadline = startedAt + config.seconds * 1_000;
  const governor = new RateGovernor(config.maxRps, config.adaptive ? undefined : config.maxRps);
  const runtime: CensusRuntime = {
    rateMs: config.rateMs,
    probeBackPapers: config.probeBackPapers,
    governor,
  };

  try {
    const slice = await walkRange(
      config,
      { start: config.rangeStart, end: config.rangeEnd },
      deadline,
      runtime,
      countingFetchers(counter),
      () => state.interrupted,
      now,
    );
    merge(summary, slice);
    summary.status = slice.unreachable
      ? "budget"
      : slice.status === "paused"
        ? "budget"
        : slice.status;
  } catch (e) {
    summary.status = "failed";
    summary.error = (e as Error)?.message ?? String(e);
    summary.seconds = Math.round((now() - startedAt) / 100) / 10;
    summary.requests = counter.requests;
    throw Object.assign(new Error(summary.error), { summary });
  } finally {
    summary.seconds = Math.round((now() - startedAt) / 100) / 10;
    summary.requests = counter.requests;
    summary.requestsPerSecond =
      summary.seconds > 0 ? Math.round((counter.requests / summary.seconds) * 10) / 10 : 0;
    summary.finalRps = Math.round(governor.currentRps * 10) / 10;
    summary.rateLimits = governor.rateLimits;
    setUpstreamLogger(null);
  }

  return summary;
}

/**
 * Walk the measured grid: every batch year × every college code that has one,
 * `concurrency` blocks at a time, resuming each block from its own persisted
 * offset. A tick that runs out of budget leaves the rest of the grid untouched
 * for the next one — the schedule, not this function, decides how long the
 * census takes.
 */
export async function runCensusGrid(
  config: CensusTickConfig,
  now: () => number = Date.now,
): Promise<CensusTickSummary> {
  const blocks = selectedBlocks(config);
  const summary = emptySummary(config, "grid");
  summary.blocksTotal =
    config.maxBlocks > 0 ? Math.min(config.maxBlocks, blocks.length) : blocks.length;

  const counter = { requests: 0 };
  const fetchers = countingFetchers(counter);
  const state = { interrupted: false };
  installSignals(state);

  const startedAt = now();
  const deadline = startedAt + config.seconds * 1_000;
  // One governor for every worker: the ceiling is a property of the crawl, not
  // of a worker, so no worker can outrun the others into the rate limiter.
  const governor = new RateGovernor(config.maxRps, config.adaptive ? undefined : config.maxRps);
  const runtime: CensusRuntime = {
    rateMs: config.rateMs,
    probeBackPapers: config.probeBackPapers,
    governor,
  };

  let next = 0;
  let started = 0;
  let unreachableRun = 0;
  let firstError: unknown = null;

  const workers = Math.min(config.concurrency, Math.max(blocks.length, 1));
  const worker = async () => {
    while (!state.interrupted && !firstError && now() < deadline - 1_000) {
      if (config.maxBlocks > 0 && started >= config.maxBlocks) return;
      if (next >= blocks.length) return;
      if (unreachableRun >= TRANSIENT_BLOCKS_BEFORE_QUIT) return;

      const block = blocks[next++];
      started += 1;
      const slice = await walkRange(
        config,
        { start: block.start, end: block.end },
        deadline,
        runtime,
        fetchers,
        () => state.interrupted,
        now,
      );
      merge(summary, slice);
      unreachableRun = slice.unreachable ? unreachableRun + 1 : 0;
    }
  };

  try {
    await Promise.all(Array.from({ length: workers }, worker));
    summary.blocksDeferred = Math.max(blocks.length - next, 0);
    summary.status = state.interrupted ? "interrupted" : "budget";
    if (next >= blocks.length && summary.blocksPaused === 0) summary.status = "done";
  } catch (e) {
    firstError = e;
    summary.status = "failed";
    summary.error = (e as Error)?.message ?? String(e);
  } finally {
    summary.seconds = Math.round((now() - startedAt) / 100) / 10;
    summary.requests = counter.requests;
    summary.requestsPerSecond =
      summary.seconds > 0 ? Math.round((counter.requests / summary.seconds) * 10) / 10 : 0;
    summary.finalRps = Math.round(governor.currentRps * 10) / 10;
    summary.rateLimits = governor.rateLimits;
    setUpstreamLogger(null);
  }

  if (firstError) {
    throw Object.assign(new Error(summary.error ?? "census failed"), { summary });
  }
  return summary;
}

/**
 * Prove the credentials before walking anything.
 *
 * `census_cursor_state` is the cheapest call that requires both a valid key *and*
 * the service role, so it is the right probe: it fails exactly the way the crawl
 * would, but before an hour has been spent finding out. The failure is then
 * translated into the one sentence that says what to change, because "401 Invalid
 * API key" in a scheduler log costs somebody an afternoon.
 */
export async function preflightCensus(config: CensusTickConfig): Promise<void> {
  const blocks = selectedBlocks(config);
  const probe = blocks[0] ?? censusBlocks()[0];
  const project = config.supabaseUrl.replace(/^https?:\/\//, "");

  try {
    await rpc(config, "census_cursor_state", {
      _range_start: probe.start,
      _range_end: probe.end,
    });
  } catch (e) {
    const detail = (e as Error)?.message ?? String(e);
    const status = (e as { status?: number })?.status ?? 0;
    const invalidKey = /invalid api key/i.test(detail);
    const noWritePermission =
      status === 401 || status === 403 || /42501|not readable|not permitted/i.test(detail);

    if (invalidKey) {
      throw new Error(
        `Census credentials rejected: the value in SUPABASE_SERVICE_ROLE_KEY is not a valid API key for ${project}. ` +
          `Supabase answers with this for a legacy JWT that no longer belongs to the project — for example a key saved ` +
          `before the project was deleted and recreated. Take the current service_role secret (Project Settings → API ` +
          `keys) or create an sb_secret_… secret key, paste it with no quotes and no trailing newline, and re-run. ` +
          `Upstream said: ${detail}`,
      );
    }
    if (noWritePermission) {
      throw new Error(
        `Census credentials are valid but have no write permission on ${project}: the key is not the service_role key. ` +
          `An anon/publishable key is refused here on purpose — census_cursor_state is gated by census_can_write(), which ` +
          `accepts only service_role or an admin session. Upstream said: ${detail}`,
      );
    }
    throw new Error(`Census preflight could not read ${project}/rest/v1: ${detail}`);
  }
}

/**
 * Report where the census actually is, and how long the rest should take.
 *
 * The ETA is deliberately crude and labelled as such: it scales the estimated
 * total request count by the fraction of blocks still unfinished and divides by
 * the rate *this tick* achieved. It assumes the remaining blocks cost what the
 * finished ones did, which is true on average because block cost is dominated by
 * intake size. A failed read is not worth failing a tick over.
 */
async function reportProgress(config: CensusTickConfig, summary: CensusTickSummary): Promise<void> {
  try {
    const progress = await rpc<{
      ranges: number;
      doneRanges: number;
      visited: number;
      notFound: number;
      observations: number;
      lastBatchAt: string | null;
    }>(config, "census_progress", {});

    const totalBlocks = censusBlocks().length;
    const done = progress?.doneRanges ?? 0;
    const remaining = Math.max(totalBlocks - done, 0);
    const rps = summary.requestsPerSecond;
    const requests = estimatedRequests();
    const etaHours = rps > 0 ? (requests * (remaining / totalBlocks)) / rps / 3600 : 0;

    console.log(
      `[census] progress (whole grid) — blocks ${done}/${totalBlocks} finished, ` +
        `${(progress?.observations ?? 0).toLocaleString()} observations, ` +
        `${(progress?.visited ?? 0).toLocaleString()} numbers probed, ` +
        `${(progress?.notFound ?? 0).toLocaleString()} genuinely absent`,
    );
    console.log(
      `[census] this tick ${summary.requests.toLocaleString()} requests at ` +
        `${rps} req/s (${summary.rateLimits} rate-limit answer(s)); ` +
        `remaining ≈ ${remaining.toLocaleString()} blocks ≈ ${Math.round(requests * (remaining / totalBlocks)).toLocaleString()} requests` +
        (etaHours > 0
          ? ` → ETA ≈ ${etaHours < 48 ? `${etaHours.toFixed(1)} h` : `${(etaHours / 24).toFixed(1)} days`} at this pace (estimate: assumes intake averages ${145} per block)`
          : ""),
    );
  } catch (e) {
    console.log(`[census] progress unavailable: ${(e as Error)?.message ?? "unknown"}`);
  }
}

/** Run a tick from process env and report it the way a CI log wants. */
export async function runCensusTickFromEnv(env: Env = process.env): Promise<CensusTickSummary> {
  const config = readCensusConfig(env);
  const at = () => new Date().toISOString().slice(11, 19);
  setUpstreamLogger((line) => console.log(`${at()} [bput] ${line}`));

  const grid = !config.rangeStart;
  const scope = grid
    ? `grid${config.years.length > 0 ? ` (years ${config.years.join(",")})` : ` (all ${CENSUS_YEARS.length} years)`}`
    : `range ${config.rangeStart}..${config.rangeEnd}`;

  const startRps = config.adaptive ? Math.max(0.5, config.maxRps / 4) : config.maxRps;
  console.log(
    `[census] tick starting — ${scope}, budget ${config.seconds}s, ` +
      `${config.concurrency} worker(s), rate ${startRps.toFixed(1)}` +
      `${config.adaptive ? `→${config.maxRps}` : ""} req/s aggregate` +
      `${config.maxBlocks > 0 ? `, max ${config.maxBlocks} blocks` : ""}`,
  );

  // Fail with a diagnosis, not with a 401 halfway through a slice.
  await preflightCensus(config);
  console.log("[census] preflight ok — service role accepted, cursor state readable");

  const summary = grid ? await runCensusGrid(config) : await runCensusTick(config);
  console.log(`[census] ${JSON.stringify(summary)}`);
  await reportProgress(config, summary);
  return summary;
}
