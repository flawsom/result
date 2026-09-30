// Headless census tick.
//
// The in-page runner in `census-runner.ts` can only work while somebody has a
// tab open, which is not a census, it is a chore with a progress bar. This is
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
  capturedSessions,
  loadStudent,
  observeSemesterForStudent,
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
  MEASURED_STUDENTS,
  SERIAL_MAX,
  SKIP_AFTER_MISSES,
  censusBlocks,
  estimatedRequests,
  measuredBlocks,
  type CensusBlock,
} from "./census-blocks";
import { SESSION_WATCH } from "./census-session-watch";
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
  /**
   * Which half of the census this slice spends its budget on.
   *
   * `auto` (the default) does maintenance first when there is any: a semester the
   * portal has only now started serving is a hole in a figure that is already
   * published, where the rest of the grid is work in progress. The first pass then
   * gets whatever budget is left. `firstpass` and `maintain` pin one phase, which
   * is what a targeted run wants.
   */
  phase: "auto" | "firstpass" | "maintain";
  probeBackPapers: boolean;
  /** Observations per write. */
  batchSize: number;
  /** Never let the live counter sit still longer than this. */
  flushMs: number;
}

const DEFAULT_SECONDS = 240;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_FLUSH_MS = 15_000;
const DEFAULT_CONCURRENCY = 16;
/**
 * Workers are the throughput lever, because the crawl is latency-bound, not
 * bandwidth-bound: `subjects` answers in ~797 ms and a student needs eight of
 * them, so requests/second ≈ workers / (8 × 0.797 s).
 *
 * Measured against the live portal, zero 429s throughout:
 *   8 workers  → 3.8 req/s
 *   24 workers → 7.4 req/s (the governor's 24 req/s ceiling reached, never binding)
 *
 * The growth is real but sub-linear, because the portal queues under concurrency:
 * per-request latency at 24-way parallelism is nearer 3 s than the 0.8 s measured
 * one-at-a-time. That also means the aggregate ceiling is mostly a safety rail
 * rather than the throttle, and that raising concurrency has diminishing returns.
 */
const MAX_CONCURRENCY = 32;
/**
 * Default aggregate ceiling. Measured tolerance was 35.6 req/s for 45 s; 16 is
 * chosen to sit well under that for a crawl that runs for a day, and it is one
 * environment variable away from being raised.
 */
const DEFAULT_MAX_RPS = 16;
/** Blocks that could not be read from upstream before the tick gives up. */
const TRANSIENT_BLOCKS_BEFORE_QUIT = 4;
/**
 * Shortest first pass worth handing a leftover budget to.
 *
 * A pass writes its cursor every fifteen seconds, so a minute is enough to
 * advance one block and be resumable; anything shorter is a phase that would
 * spend its whole budget on setup and report nothing.
 */
const MIN_FIRST_PASS_SECONDS = 60;

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

/** `CENSUS_PHASE=maintain` → maintenance only; anything else is `auto`. */
export function parsePhase(raw: string | null | undefined): CensusTickConfig["phase"] {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "maintain" || value === "maintenance") return "maintain";
  if (value === "firstpass" || value === "first-pass" || value === "grid") return "firstpass";
  return "auto";
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
  const phase = parsePhase(firstEnv(env, "CENSUS_PHASE"));

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
    phase,
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

/* ──────────────────────────────────────────────────────── the ledger ────── */

/** One unit of work, as `census_next_work` describes it. */
export interface CensusWorkUnit {
  year: number;
  code: number;
  /** Null for a first-pass unit; a semester number for a maintenance pass. */
  semester: number | null;
  maxSerial: number;
  /** Where to start: the walk offset for a first pass, 0 for a maintenance sweep. */
  serialOffset: number;
  /** Serials to cover: to the measured bound, or to the frontier. */
  serialsLeft: number;
}

export interface CensusWorkList {
  /** Semesters the portal now serves that a block has not captured, biggest year first. */
  maintenance: CensusWorkUnit[];
  /** Blocks with serials still to read for the first time. */
  firstPass: CensusWorkUnit[];
  /** False when the ledger could not be read, in which case the grid walks blind. */
  ledger: boolean;
}

/**
 * Write the compiled measurement and the session watch into the database.
 *
 * The crawl walks the compiled grid and the dashboard reads the database, so
 * unless the two agree the page and the crawl are describing different
 * universes. This is what makes them agree, and it is why a slice never needs a
 * human: every slice publishes the measurement it is about to walk, and the daily
 * refresh keeps that measurement true. Nothing here invents a number, each bound
 * was measured against the portal, and the watch is what the portal itself
 * answered.
 */
export async function pushUniverse(
  config: CensusTickConfig,
): Promise<{ blocks: number; years: number }> {
  const blocks = measuredBlocks().map((b) => ({ year: b.year, code: b.code, max: b.serial }));
  const stored = await rpc<number>(config, "census_note_blocks", { _rows: blocks });

  const watch = Object.entries(SESSION_WATCH).map(([year, semesters]) => ({
    year: Number(year),
    semesters: [...semesters],
  }));
  const watched = await rpc<number>(config, "census_note_watch", { _rows: watch });

  return {
    blocks: typeof stored === "number" ? stored : blocks.length,
    years: typeof watched === "number" ? watched : watch.length,
  };
}

/**
 * The outstanding work, straight from the ledger.
 *
 * A ledger that cannot be read is not an error worth failing a slice over, it
 * means the migration has not been applied yet, and the crawl then behaves as it
 * did before: walk the grid, report nothing. The caller is told which happened so
 * the log says so rather than implying the ledger was consulted.
 */
export async function fetchWork(config: CensusTickConfig, limit = 4000): Promise<CensusWorkList> {
  try {
    const rows = await rpc<CensusWorkUnit[]>(config, "census_next_work", { _limit: limit });
    const units = Array.isArray(rows) ? rows : [];
    return {
      maintenance: units.filter((u) => u.semester !== null),
      firstPass: units.filter((u) => u.semester === null),
      ledger: true,
    };
  } catch {
    return { maintenance: [], firstPass: [], ledger: false };
  }
}

/**
 * Record one block's walk.
 *
 * `_frontier` is the highest serial that answered for a student, and it is the
 * number that matters later: a maintenance pass re-reads up to it, and a measured
 * bound that has moved past it is what tells the crawl a college has admitted
 * more students rather than merely grown a longer range.
 */
async function noteWalk(
  config: CensusTickConfig,
  block: { year: number; code: number },
  offset: number,
  frontier: number,
  captured: number[],
  completed: boolean,
): Promise<void> {
  await rpc<boolean>(config, "census_note_walk", {
    _year: block.year,
    _code: block.code,
    _offset: offset,
    _frontier: frontier,
    _captured: captured,
    _completed: completed,
  });
}

/* ───────────────────────────────────────────────────────────── summary ─── */

export type CensusTickStatus = "done" | "budget" | "interrupted" | "failed";

export interface CensusTickSummary {
  mode: "range" | "grid" | "maintain";
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
  /** Blocks finished, either walked, or given up on after consecutive misses. */
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
  /** Maintenance only: passes this slice could read, and what became of them. */
  passesAvailable: number;
  passesClaimed: number;
  passesDone: number;
  passesEmpty: number;
  passesSkipped: number;
  semesters: number[];
  /** Whether the ledger answered; false means this slice walked blind. */
  ledger: boolean;
  error: string | null;
}

/**
 * Fold two phases of one slice into the summary a single log line can carry.
 *
 * `auto` runs maintenance and then the first pass out of what is left of the
 * budget, and the counters are what a reader actually wants: how much was read,
 * how much maintenance settled, how many blocks finished. The worst status wins,
 * so a failed or interrupted phase cannot be hidden by a healthy one, and the
 * positions come from the phase that ran last, because that is where the slice
 * ended up.
 */
function mergeSummaries(first: CensusTickSummary, second: CensusTickSummary): CensusTickSummary {
  const status: CensusTickStatus =
    first.status === "failed" || second.status === "failed"
      ? "failed"
      : first.status === "interrupted" || second.status === "interrupted"
        ? "interrupted"
        : first.status === "done" && second.status === "done"
          ? "done"
          : "budget";
  const seconds = Math.round((first.seconds + second.seconds) * 10) / 10;
  const requests = first.requests + second.requests;

  return {
    ...second,
    status,
    seconds,
    requests,
    requestsPerSecond: seconds > 0 ? Math.round((requests / seconds) * 10) / 10 : 0,
    rateLimits: first.rateLimits + second.rateLimits,
    blocksTotal: first.blocksTotal + second.blocksTotal,
    blocksVisited: first.blocksVisited + second.blocksVisited,
    blocksDone: first.blocksDone + second.blocksDone,
    blocksSkipped: first.blocksSkipped + second.blocksSkipped,
    blocksPaused: first.blocksPaused + second.blocksPaused,
    blocksDeferred: first.blocksDeferred + second.blocksDeferred,
    blocksUnreachable: first.blocksUnreachable + second.blocksUnreachable,
    visited: first.visited + second.visited,
    students: first.students + second.students,
    notFound: first.notFound + second.notFound,
    observations: first.observations + second.observations,
    stored: first.stored + second.stored,
    passesAvailable: first.passesAvailable + second.passesAvailable,
    passesClaimed: first.passesClaimed + second.passesClaimed,
    passesDone: first.passesDone + second.passesDone,
    passesEmpty: first.passesEmpty + second.passesEmpty,
    passesSkipped: first.passesSkipped + second.passesSkipped,
    semesters: [...new Set([...first.semesters, ...second.semesters])].sort((a, b) => a - b),
    ledger: first.ledger || second.ledger,
    error: second.error ?? first.error,
  };
}

function emptySummary(
  config: CensusTickConfig,
  mode: CensusTickSummary["mode"],
): CensusTickSummary {
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
    passesAvailable: 0,
    passesClaimed: 0,
    passesDone: 0,
    passesEmpty: 0,
    passesSkipped: 0,
    semesters: [],
    ledger: false,
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
  /** Highest serial in this block that answered for a student. */
  frontier: number;
}

/**
 * Walk one contiguous range until it finishes, the budget runs out, or the
 * serials go quiet.
 *
 * The skip rule is the important part. Serials are dense from 001, so a run of
 * misses means the intake ended, but single-number gaps are real (college 329
 * batch 2023 is missing serials 12, 18 and 32), which is why the threshold is
 * `skipMisses` rather than one. A *transient* upstream failure never counts as a
 * miss: the block is parked at the same serial and retried next tick, because
 * a flaky portal must not be recorded as an empty college.
 */
async function walkRange(
  config: CensusTickConfig,
  range: { start: string; end: string },
  block: { year: number; code: number } | null,
  deadline: number,
  runtime: CensusRuntime,
  fetchers: CensusFetchers,
  aborted: () => boolean,
  now: () => number,
  /** Where the ledger says to start, when it knows better than the cursor does. */
  ledgerOffset: number | null = null,
): Promise<SliceResult> {
  const { start, end, width, total } = parseCensusRange(range.start, range.end);

  /*
   * The ledger is the better authority, and it is not a detail: a block that was
   * read through has its cursor at the end of the range, so resuming from the
   * cursor can never see a college that admitted more students afterwards. The
   * ledger knows the highest serial that actually resolved, which is where the
   * re-read has to start. The cursor is still written (it is what the progress
   * panel counts) and still read when the ledger has nothing to say, an explicit
   * range run, or a deployment without the maintenance migration.
   */
  const cursor =
    ledgerOffset === null
      ? await rpc<{ exists: boolean; nextIndex: number }>(config, "census_cursor_state", {
          _range_start: start,
          _range_end: end,
        })
      : null;
  const resumedFrom = Math.min(
    Math.max(
      ledgerOffset !== null ? ledgerOffset : cursor?.exists ? (cursor.nextIndex ?? 0) : 0,
      0,
    ),
    total,
  );

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
    frontier: 0,
  };

  // The semesters this walk actually captured, reported to the ledger so a
  // finished block is not read again for them.
  const captured = new Set<number>();

  if (resumedFrom >= total) {
    res.status = "done";
    // Re-stating a finished block is idempotent, and it keeps a fresh ledger in
    // step with work that a cursor already recorded.
    if (block) await noteWalk(config, block, res.nextIndex, 0, [], true);
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
    // The ledger is what the dashboard reads, so it is written on every flush
    // rather than only when a block finishes: a slice that is killed by the
    // scheduler still leaves the page describing the right amount of work.
    if (block) {
      await noteWalk(
        config,
        block,
        res.nextIndex,
        res.frontier,
        [...captured].sort((a, b) => a - b),
        status === "done",
      );
    }
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
        // Index 0 is serial 001, so the serial this student answered for is
        // `index + 1`, the frontier a maintenance pass will re-read.
        if (index + 1 > res.frontier) res.frontier = index + 1;
        const observations = await observeStudent(fetchers, student, rollNo, runtime);
        res.observations += observations.length;
        for (const semester of capturedSessions(observations)) captured.add(semester);
        // Stamped with the block they came from: that is what lets a later
        // maintenance pass replace them rather than duplicate them.
        if (observations.length > 0) {
          pending.push(
            ...(block
              ? observations.map((o) => ({ ...o, collegeCode: block.code }))
              : observations),
          );
        }
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
      null,
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
 * for the next one, the schedule, not this function, decides how long the
 * census takes.
 */
export async function runCensusGrid(
  config: CensusTickConfig,
  now: () => number = Date.now,
  work?: CensusWorkList,
): Promise<CensusTickSummary> {
  const all = selectedBlocks(config);
  /*
   * The ledger decides what still needs reading, and it is consulted only when it
   * answered and the measurement inside it is present. Reading it the other way
   * round would be dangerous: an unreadable ledger lists no work, and a crawl that
   * trusts an empty list would quietly stop doing the census. So a slice with a
   * silent ledger walks the whole selected grid, exactly as it did before the
   * ledger existed.
   */
  const pending =
    work && work.ledger && work.firstPass.length > 0
      ? new Map(work.firstPass.map((u) => [`${u.year}:${u.code}`, u.serialOffset]))
      : null;
  const blocks = pending ? all.filter((b) => pending.has(`${b.year}:${b.code}`)) : all;
  const summary = emptySummary(config, "grid");
  summary.ledger = pending !== null;
  if (pending) {
    const grown = [...pending.values()].filter((offset) => offset > 0).length;
    console.log(
      `[census] ledger knows what is left, ${pending.size} of ${all.length} selected block(s) still have serials to read ` +
        `(${grown} resuming past a measured frontier)`,
    );
  }
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
        block,
        deadline,
        runtime,
        fetchers,
        () => state.interrupted,
        now,
        pending?.get(`${block.year}:${block.code}`) ?? null,
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

interface PassResult {
  status: "done" | "empty" | "failed";
  visited: number;
  students: number;
  notFound: number;
  observations: number;
  stored: number;
}

/** Registration number at the start of a block: `YY01CCC001`. */
function blockStart(year: number, code: number): string {
  const yy = String(year % 100).padStart(2, "0");
  const ccc = String(code).padStart(3, "0");
  return `${yy}01${ccc}001`;
}

/**
 * Re-read one semester of one block, the read that keeps a published figure true.
 *
 * Deliberately the cheapest read that can do the job: one record and one term per
 * student, for the serials the first pass already resolved, and nothing else. The
 * six semesters that block has already captured are not touched, which is what
 * makes keeping the census current cost thousands of requests instead of another
 * million and a half.
 *
 * The sweep is buffered and applied in one transaction at the end, which is what
 * makes it safe to re-read a semester at all. Nothing is written until the block
 * has been read through; then `census_apply_pass` deletes this block's rows for
 * that semester and stores what the re-read found. Either the corrected
 * population is in place or nothing changed, never a half-populated semester
 * sitting beside the rows it was meant to replace, and never a student counted
 * twice. A pass that dies halfway has written nothing, so it starts again from the
 * first serial rather than trying to resume into a replacement it cannot
 * reconstruct.
 */
async function sweepBlockForSemester(
  config: CensusTickConfig,
  unit: CensusWorkUnit & { semester: number },
  deadline: number,
  runtime: CensusRuntime,
  fetchers: CensusFetchers,
  aborted: () => boolean,
  now: () => number,
): Promise<PassResult> {
  const start = blockStart(unit.year, unit.code);
  const sweep = Math.min(Math.max(unit.serialsLeft, 0), SERIAL_MAX);
  const res: PassResult = {
    status: "done",
    visited: 0,
    students: 0,
    notFound: 0,
    observations: 0,
    stored: 0,
  };

  // Nothing below the frontier: the block answered for nobody, so there is no
  // serial to re-read for any semester. Recorded as empty rather than guessed.
  if (sweep === 0) {
    res.status = "empty";
    await closePass(config, unit, "empty", 0);
    return res;
  }

  const rows: CensusObservation[] = [];
  let misses = 0;
  let index = 0;

  while (index < sweep) {
    if (aborted() || now() >= deadline - 1_000) {
      // Out of budget: nothing was written, so a later slice retries this block
      // from the start rather than resuming into a replacement.
      res.status = "failed";
      break;
    }

    const rollNo = rollAt(start, index, start.length);
    if (runtime.governor) await runtime.governor.acquire();
    else await sleep(config.rateMs);

    const student = await loadStudent(fetchers, rollNo, runtime.governor);
    res.visited += 1;

    if (student === undefined) {
      // Upstream trouble, not a missing student: hand the pass back untouched.
      res.status = "failed";
      break;
    }

    if (student === null) {
      res.notFound += 1;
      misses += 1;
    } else {
      misses = 0;
      res.students += 1;
      const observation = await observeSemesterForStudent(
        fetchers,
        student,
        rollNo,
        unit.semester,
        runtime,
      );
      if (observation) {
        res.observations += 1;
        rows.push({ ...observation, collegeCode: unit.code });
      }
    }

    index += 1;

    // The intake is dense from 001, so a long run of misses means the block ends
    // here; single-number gaps are real, which is why this is a run and not one.
    if (misses >= config.skipMisses) break;
  }

  if (res.status !== "done") {
    await closePass(config, unit, "failed", res.students);
    return res;
  }

  // One transaction: replace what the semester used to say with what it says now.
  const stored = await rpc<number>(config, "census_apply_pass", {
    _year: unit.year,
    _code: unit.code,
    _semester: unit.semester,
    _rows: rows,
  });
  res.stored = typeof stored === "number" ? stored : 0;
  return res;
}

/** Close a pass with nothing to replace: nothing below the frontier, or a failure. */
async function closePass(
  config: CensusTickConfig,
  unit: { year: number; code: number; semester: number },
  status: "done" | "empty" | "failed",
  subjects: number,
): Promise<void> {
  await rpc<boolean>(config, "census_report_pass", {
    _year: unit.year,
    _code: unit.code,
    _semester: unit.semester,
    _status: status,
    _subjects: subjects,
  });
}

/**
 * Spend a slice on maintenance: the semesters the portal has started serving for
 * blocks that were read before those semesters existed.
 *
 * This is the half of the census that makes it self-sustaining. Without it a
 * batch year read once keeps whatever it answered for on the day of the read, and
 * the only way to notice a later session would be for a person to notice. With
 * it, the work list comes from the portal's own answer and the ledger, and the
 * slice drains it.
 */
export async function runCensusMaintenance(
  config: CensusTickConfig,
  now: () => number = Date.now,
  units?: CensusWorkUnit[],
): Promise<CensusTickSummary> {
  const summary = emptySummary(config, "maintain");
  const work = units ?? (await fetchWork(config)).maintenance;
  const passes = work.filter((u) => u.semester !== null) as Array<
    CensusWorkUnit & { semester: number }
  >;
  summary.ledger = units !== undefined;
  summary.passesAvailable = passes.length;
  summary.blocksTotal = passes.length;

  const counter = { requests: 0 };
  const fetchers = countingFetchers(counter);
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

  const semesters = new Set<number>();
  let index = 0;
  let firstError: unknown = null;

  try {
    for (; index < passes.length; index += 1) {
      if (state.interrupted || now() >= deadline - 1_000) break;
      const unit = passes[index];

      const claimed = await rpc<boolean>(config, "census_claim_pass", {
        _year: unit.year,
        _code: unit.code,
        _semester: unit.semester,
      });
      if (claimed !== true) {
        // Already captured, or in flight in another slice. Either way: not ours.
        summary.passesSkipped += 1;
        continue;
      }

      summary.passesClaimed += 1;
      semesters.add(unit.semester);
      const result = await sweepBlockForSemester(
        config,
        unit,
        deadline,
        runtime,
        fetchers,
        () => state.interrupted,
        now,
      );

      summary.blocksVisited += 1;
      summary.visited += result.visited;
      summary.students += result.students;
      summary.notFound += result.notFound;
      summary.observations += result.observations;
      summary.stored += result.stored;
      if (result.status === "done") summary.passesDone += 1;
      else if (result.status === "empty") summary.passesEmpty += 1;
      else summary.blocksPaused += 1;

      if (result.status === "failed" && now() >= deadline - 1_000) break;
    }

    summary.blocksDeferred = Math.max(passes.length - index - 1, 0);
    summary.status = state.interrupted
      ? "interrupted"
      : summary.blocksDeferred > 0 || summary.blocksPaused > 0
        ? "budget"
        : "done";
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
    summary.semesters = [...semesters].sort((a, b) => a - b);
    setUpstreamLogger(null);
  }

  if (firstError) {
    throw Object.assign(new Error(summary.error ?? "census maintenance failed"), { summary });
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
          `Supabase answers with this for a legacy JWT that no longer belongs to the project, for example a key saved ` +
          `before the project was deleted and recreated. Take the current service_role secret (Project Settings → API ` +
          `keys) or create an sb_secret_… secret key, paste it with no quotes and no trailing newline, and re-run. ` +
          `Upstream said: ${detail}`,
      );
    }
    if (noWritePermission) {
      throw new Error(
        `Census credentials are valid but have no write permission on ${project}: the key is not the service_role key. ` +
          `An anon/publishable key is refused here on purpose, census_cursor_state is gated by census_can_write(), which ` +
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
      `[census] progress (whole grid), blocks ${done}/${totalBlocks} finished, ` +
        `${(progress?.observations ?? 0).toLocaleString()} observations, ` +
        `${(progress?.visited ?? 0).toLocaleString()} numbers probed, ` +
        `${(progress?.notFound ?? 0).toLocaleString()} genuinely absent`,
    );
    console.log(
      `[census] this tick ${summary.requests.toLocaleString()} requests at ` +
        `${rps} req/s (${summary.rateLimits} rate-limit answer(s)); ` +
        `remaining ≈ ${remaining.toLocaleString()} blocks ≈ ${Math.round(requests * (remaining / totalBlocks)).toLocaleString()} requests` +
        (etaHours > 0
          ? ` → ETA ≈ ${etaHours < 48 ? `${etaHours.toFixed(1)} h` : `${(etaHours / 24).toFixed(1)} days`} at this pace (estimate basis: the measured ${MEASURED_STUDENTS.toLocaleString()} students over ${totalBlocks.toLocaleString()} blocks)`
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
    `[census] tick starting, ${scope}, budget ${config.seconds}s, ` +
      `${config.concurrency} worker(s), rate ${startRps.toFixed(1)}` +
      `${config.adaptive ? `→${config.maxRps}` : ""} req/s aggregate` +
      `${config.maxBlocks > 0 ? `, max ${config.maxBlocks} blocks` : ""}`,
  );

  // Fail with a diagnosis, not with a 401 halfway through a slice.
  await preflightCensus(config);
  console.log("[census] preflight ok, service role accepted, cursor state readable");

  /*
   * Publish the universe before walking it. The crawl walks the compiled grid and
   * the dashboard reads the database, so this is the step that stops the two from
   * describing different populations: the measurement goes in, the portal's
   * session window goes in, and the work list that comes back is what still needs
   * reading, including any semester that appeared since the last slice.
   */
  let work: CensusWorkList | null = null;
  if (grid) {
    try {
      const pushed = await pushUniverse(config);
      work = await fetchWork(config);
      console.log(
        `[census] universe published, ${pushed.blocks} measured bound(s), ${pushed.years} year(s) of session watch · ` +
          `${work.firstPass.length} block(s) with serials left, ${work.maintenance.length} maintenance pass(es) pending`,
      );
    } catch (e) {
      // Walking blind is the old behaviour, and it is better than a slice that
      // does nothing because a migration has not been applied yet.
      console.log(
        `[census] ledger unavailable (${(e as Error)?.message ?? "unknown"}), walking the grid without a maintenance record`,
      );
    }
  }

  /*
   * Which half of the census this slice is for. Maintenance wins the tie whenever
   * there is any: a semester BPUT has just started serving is a hole in a figure
   * somebody may already be reading, where the rest of the grid is work in
   * progress that the next slice will pick up anyway.
   */
  const phase: "grid" | "maintain" = !grid
    ? "grid"
    : config.phase === "maintain"
      ? "maintain"
      : config.phase === "firstpass"
        ? "grid"
        : work && work.maintenance.length > 0
          ? "maintain"
          : "grid";

  let summary: CensusTickSummary;
  if (!grid) {
    summary = await runCensusTick(config);
  } else if (phase === "maintain" && config.phase === "maintain") {
    // Pinned by `CENSUS_PHASE=maintain`: a targeted run asked for maintenance and
    // gets nothing else.
    summary = await runCensusMaintenance(config, Date.now, work?.maintenance);
  } else if (phase === "maintain") {
    /*
     * `auto`: maintenance first, then the first pass on whatever budget is left.
     *
     * The maintenance list is usually empty and always small, but it can also be
     * permanently small: one pass whose block answers with an upstream error at
     * the same serial every time keeps its status `failed`, and a failed pass is
     * retried from the first serial by design. A slice that ended as soon as that
     * list drained would leave the first pass untouched for as long as the pass
     * kept failing, which is coverage that stops moving while every run reports a
     * healthy summary. So draining the list hands the rest of the budget over
     * instead of ending the slice.
     */
    const maintenance = await runCensusMaintenance(config, Date.now, work?.maintenance);
    const remaining = config.seconds - Math.ceil(maintenance.seconds);
    if (maintenance.status === "interrupted" || remaining < MIN_FIRST_PASS_SECONDS) {
      summary = maintenance;
    } else {
      console.log(
        `[census] maintenance settled ${maintenance.passesDone + maintenance.passesEmpty} of ` +
          `${maintenance.passesAvailable} pass(es) in ${Math.round(maintenance.seconds)}s, ` +
          `${remaining}s left for the first pass`,
      );
      const firstPass = await runCensusGrid(
        { ...config, seconds: remaining },
        Date.now,
        work ?? undefined,
      );
      summary = mergeSummaries(maintenance, firstPass);
    }
  } else {
    summary = await runCensusGrid(config, Date.now, work ?? undefined);
  }
  console.log(`[census] ${JSON.stringify(summary)}`);
  await reportProgress(config, summary);
  if (grid) await reportPlan(config);
  return summary;
}

/**
 * Say what the ledger thinks is left.
 *
 * Reported separately from the tick's own counters because they answer different
 * questions: the tick says what this slice did, the plan says how much of the
 * census remains, including the maintenance passes that a completed block does
 * not have.
 */
async function reportPlan(config: CensusTickConfig): Promise<void> {
  try {
    const plan = await rpc<{
      blocks: number;
      blocksDone: number;
      serialsRemaining: number;
      passesPending: number;
      passSerialsPending: number;
    }>(config, "census_plan", {});

    console.log(
      `[census] ledger, ${plan.blocksDone}/${plan.blocks} block(s) read through, ` +
        `${Math.round(plan.serialsRemaining).toLocaleString()} serial(s) left to read, ` +
        `${plan.passesPending} maintenance pass(es) pending ` +
        `(${Math.round(plan.passSerialsPending).toLocaleString()} serials to sweep) · ` +
        `a pass costs two requests per student and never re-reads a captured semester`,
    );
  } catch (e) {
    console.log(`[census] plan unavailable: ${(e as Error)?.message ?? "unknown"}`);
  }
}
