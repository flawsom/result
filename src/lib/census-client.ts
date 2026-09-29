// Read/write client for the anonymous BPUT census.
//
// Reading is public: the landing page shows census aggregates with no account,
// and the database exposes only k-anonymised cells (see the census migration).
//
// Writing is not public. `logCensusEvents` and `saveCursor` only succeed for an
// admin session or the service role, which is why they throw instead of
// swallowing errors the way the fire-and-forget telemetry writer does: a crawl
// that quietly failed to persist is a crawl that wasted hours of upstream load.
import {
  TelemetryError,
  classifyTelemetryError,
  withTimeout,
  type LiveSubscription,
} from "@/lib/analytics-client";
import { supabase } from "@/integrations/supabase/client";
import type { CensusObservation } from "@/lib/census-core";

// The observation shape is the reducer's, not this module's: the same type is
// written by the in-page runner and by the scheduled headless tick.
export type { CensusObservation };

export interface CensusProgress {
  ranges: number;
  doneRanges: number;
  visited: number;
  notFound: number;
  observations: number;
  updatedAt: string | null;
  /** When the newest batch landed, as distinct from when the run last spoke. */
  lastBatchAt?: string | null;
  active: boolean;
}

/**
 * The single broadcast row the database maintains as the crawl ingests.
 *
 * Counts only. Deliberately not "the newest observation": a single row is not
 * k-anonymous, and this row is readable by anyone. The published cells stay
 * pooled at 25 so no figure here can describe one student.
 */
export interface CensusLiveCounters {
  id: number;
  observations: number;
  visited: number;
  not_found: number;
  ranges: number;
  active: boolean;
  last_batch_at: string | null;
  updated_at: string;
}

export interface CensusPayload {
  meta: {
    schema: "census1";
    generatedAt: string;
    observations: number;
    batchYears: number;
    semesters: number;
    branches: number;
    colleges: number;
    minBatchYear: number | null;
    maxBatchYear: number | null;
    kAnonymity: number;
  };
  progress: CensusProgress;
  byYear: Array<{
    batchYear: number;
    observations: number;
    published: number;
    subjectsP50: number | null;
  }>;
  bySemester: Array<{
    semester: number;
    observations: number;
    published: number;
    subjectsP50: number | null;
    pointsP50: number | null;
  }>;
  byBranch: Array<{
    branch: string;
    observations: number;
    published: number;
    subjectsP50: number | null;
  }>;
  byCollege: Array<{ college: string | null; observations: number; published: number }>;
  outcomes: Array<{ outcome: string; n: number }>;
  grades: Array<{ grade: string; n: number }>;
  branchYear: Array<{ batchYear: number; branch: string; observations: number }>;
}

/**
 * The outstanding-work ledger, as the database derives it.
 *
 * `census_plan()` is the answer to "what is left", and it is derived from the
 * block ledger plus the portal's last-known session window rather than from a
 * constant compiled into this bundle. That distinction is the whole point: a new
 * batch year, a college that admitted more students, or a semester BPUT has only
 * now started serving all appear here as work, without anybody editing a number.
 *
 * Counts per batch year only, the ledger names blocks, and the public read
 * deliberately does not.
 */
export interface CensusPlanYear {
  year: number;
  blocks: number;
  firstPassDone: number;
  /** Serials this batch year still has to read for the first time. */
  serialsLeft: number;
  /** Block-and-semester units the portal now serves that were not captured. */
  pendingPasses: number;
  /** Serial span those passes cover, the maintenance walk's cost basis. */
  passSerialsPending: number;
  passesDone: number;
}

export interface CensusPlan {
  blocks: number;
  blocksMeasured: number;
  blocksDone: number;
  serialsRemaining: number;
  passesDone: number;
  passesPending: number;
  passSerialsPending: number;
  /** When the portal's session window was last checked. */
  watchCheckedAt: string | null;
  updatedAt: string | null;
  years: CensusPlanYear[];
}

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 12_000;

/** Public aggregate read. Throws a classified TelemetryError on failure. */
export async function fetchCensus(): Promise<CensusPayload> {
  try {
    const res = await withTimeout(
      (signal) => supabase.rpc("get_bput_census").abortSignal(signal),
      READ_TIMEOUT_MS,
    );
    if (res.error) {
      throw classifyTelemetryError({ message: res.error.message, code: res.error.code });
    }
    if (!res.data) throw new TelemetryError("unknown", "Census aggregate returned no payload.");
    return res.data as unknown as CensusPayload;
  } catch (e) {
    throw classifyTelemetryError(e);
  }
}

/**
 * The live work ledger.
 *
 * Returns null rather than throwing when the function is absent, because a
 * deployment can be a migration behind and the dashboard must still render: the
 * panels then say, in words, that they are reading the baseline measurement
 * instead of the ledger. "Missing" is a state to display here, not an error to
 * hide behind an empty panel.
 */
export async function fetchCensusPlan(): Promise<CensusPlan | null> {
  try {
    const res = await withTimeout(
      (signal) => supabase.rpc("census_plan").abortSignal(signal),
      READ_TIMEOUT_MS,
    );
    if (res.error || !res.data) return null;
    const plan = res.data as unknown as CensusPlan;
    return typeof plan?.blocks === "number" ? plan : null;
  } catch {
    return null;
  }
}

/**
 * Append one batch of observations. Returns how many rows the database actually
 * stored, which can be fewer than sent if any row failed validation.
 */
export async function logCensusEvents(rows: CensusObservation[]): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await withTimeout(
    (signal) =>
      supabase.rpc("log_census_events", { _rows: rows as unknown as never }).abortSignal(signal),
    WRITE_TIMEOUT_MS,
  );
  if (res.error) {
    throw classifyTelemetryError({ message: res.error.message, code: res.error.code });
  }
  return typeof res.data === "number" ? res.data : 0;
}

export interface CensusCursorState {
  exists: boolean;
  nextIndex: number;
  status: "idle" | "running" | "paused" | "done";
  visited?: number;
  notFound?: number;
  facts?: number;
}

/** Where a declared range got to, so a run resumes instead of restarting. */
export async function censusCursorState(
  rangeStart: string,
  rangeEnd: string,
): Promise<CensusCursorState> {
  const res = await withTimeout(
    (signal) =>
      supabase
        .rpc("census_cursor_state", { _range_start: rangeStart, _range_end: rangeEnd })
        .abortSignal(signal),
    WRITE_TIMEOUT_MS,
  );
  if (res.error) {
    throw classifyTelemetryError({ message: res.error.message, code: res.error.code });
  }
  if (!res.data) return { exists: false, nextIndex: 0, status: "idle" };
  return res.data as unknown as CensusCursorState;
}

/** Persist crawl progress so a closed tab resumes where it stopped. */
export async function saveCursor(input: {
  rangeStart: string;
  rangeEnd: string;
  nextIndex: number;
  visitedAdd: number;
  notFoundAdd: number;
  factsAdd: number;
  status: "idle" | "running" | "paused" | "done";
}): Promise<void> {
  const res = await withTimeout(
    (signal) =>
      supabase
        .rpc("census_cursor_upsert", {
          _range_start: input.rangeStart,
          _range_end: input.rangeEnd,
          _next_index: input.nextIndex,
          _visited_add: input.visitedAdd,
          _not_found_add: input.notFoundAdd,
          _facts_add: input.factsAdd,
          _status: input.status,
        })
        .abortSignal(signal),
    WRITE_TIMEOUT_MS,
  );
  if (res.error) {
    throw classifyTelemetryError({ message: res.error.message, code: res.error.code });
  }
}

/* ─────────────────────────────────────────────── ledger (write side) ─── */
// Written by whichever crawl is running, page-driven or scheduled. A page-driven
// block that did not report itself would be re-read by the next scheduled slice,
// and re-reading means duplicating observations, so the ledger is written by
// both runners rather than by the scheduler alone.

/** Record what the measurement says each block holds. Idempotent. */
export async function noteCensusBlocks(
  rows: Array<{ year: number; code: number; max: number }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await withTimeout(
    (signal) =>
      supabase.rpc("census_note_blocks", { _rows: rows as unknown as never }).abortSignal(signal),
    WRITE_TIMEOUT_MS,
  );
  if (res.error) {
    throw classifyTelemetryError({ message: res.error.message, code: res.error.code });
  }
  return typeof res.data === "number" ? res.data : 0;
}

/** Record which sessions the portal last said it serves, per batch year. */
export async function noteCensusWatch(
  rows: Array<{ year: number; semesters: number[] }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await withTimeout(
    (signal) =>
      supabase.rpc("census_note_watch", { _rows: rows as unknown as never }).abortSignal(signal),
    WRITE_TIMEOUT_MS,
  );
  if (res.error) {
    throw classifyTelemetryError({ message: res.error.message, code: res.error.code });
  }
  return typeof res.data === "number" ? res.data : 0;
}

/**
 * Where a block's walk got to, and which semesters its first pass captured.
 * `frontier` is the highest serial that resolved, which is what a later
 * maintenance pass re-reads; `completed` is true only when the walk reached its
 * measured bound rather than parking on upstream trouble.
 */
export async function noteCensusWalk(input: {
  year: number;
  code: number;
  offset: number;
  frontier: number;
  captured?: number[];
  completed?: boolean;
}): Promise<void> {
  const res = await withTimeout(
    (signal) =>
      supabase
        .rpc("census_note_walk", {
          _year: input.year,
          _code: input.code,
          _offset: input.offset,
          _frontier: input.frontier,
          _captured: (input.captured ?? []) as unknown as never,
          _completed: input.completed ?? false,
        })
        .abortSignal(signal),
    WRITE_TIMEOUT_MS,
  );
  if (res.error) {
    throw classifyTelemetryError({ message: res.error.message, code: res.error.code });
  }
}

/*
 * Maintenance passes are deliberately absent from this client.
 *
 * Claiming, sweeping and applying a pass is the scheduled crawl's job, it runs
 * with the service key over plain PostgREST in `census-headless.ts`, the same way
 * it writes cursors and observations. A browser tab can start a first pass, and it
 * reports what it read here, but re-reading a published semester is a job for the
 * runner that can be trusted to finish it.
 */

/* ─────────────────────────────────────────────────────────────── live ─── */

/**
 * Push updates straight from the crawl. The database maintains one aggregate
 * counter row and broadcasts every change to it, so a batch landing in the
 * portal reaches every open dashboard in about a second, no polling delay and
 * no cached figure. Readers get that one row and never the observation stream.
 *
 * Several sections on the landing page want this same row, and one socket per
 * section would mean the database fanning every insert out N times. So the
 * channel is a module-level singleton: the first subscriber opens it, the last
 * one to leave closes it, and everyone in between is served by one subscription.
 * Subscribing is therefore safe to do from as many components as need it.
 */
type LinkStatus = "connecting" | "live" | "offline";

interface CensusSubscriber {
  onRow: (row: CensusLiveCounters) => void;
  onStatus?: (status: LinkStatus) => void;
}

const censusSubscribers = new Set<CensusSubscriber>();
let censusChannel: ReturnType<typeof supabase.channel> | null = null;
let censusLink: LinkStatus = "connecting";

function ensureCensusChannel(): void {
  if (censusChannel) return;
  censusChannel = supabase
    .channel("census-live-counters")
    .on("postgres_changes", { event: "*", schema: "public", table: "census_live" }, (payload) => {
      const row = (payload.new ?? null) as CensusLiveCounters | null;
      if (!row || typeof row.observations !== "number") return;
      for (const subscriber of censusSubscribers) subscriber.onRow(row);
    })
    .subscribe((status) => {
      censusLink =
        status === "SUBSCRIBED"
          ? "live"
          : status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED"
            ? "offline"
            : "connecting";
      for (const subscriber of censusSubscribers) subscriber.onStatus?.(censusLink);
    });
}

export function subscribeCensusLive(
  onRow: (row: CensusLiveCounters) => void,
  onStatus?: (status: LinkStatus) => void,
): LiveSubscription {
  const subscriber: CensusSubscriber = { onRow, onStatus };
  censusSubscribers.add(subscriber);
  ensureCensusChannel();
  // A late subscriber still learns the current state immediately instead of
  // waiting for the next broadcast.
  onStatus?.(censusLink);

  return {
    close: () => {
      censusSubscribers.delete(subscriber);
      if (censusSubscribers.size > 0 || !censusChannel) return;
      const channel = censusChannel;
      censusChannel = null;
      censusLink = "connecting";
      void supabase.removeChannel(channel);
    },
  };
}
