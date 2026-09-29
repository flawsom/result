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

/* ─────────────────────────────────────────────────────────────── live ─── */

/**
 * Push updates straight from the crawl. The database maintains one aggregate
 * counter row and broadcasts every change to it, so a batch landing in the
 * portal reaches every open dashboard in about a second — no polling delay and
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
