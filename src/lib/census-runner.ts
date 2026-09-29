// Paced BPUT census runner, driven from a page.
//
// Two modes, one reduction. `runCensus` walks a single declared range;
// `runCensusGrid` walks the measured grid in `census-blocks.ts` — every batch
// year × every college code that has one — which is the same population the
// scheduled tick covers. Both reduce each student through `census-core.ts`, so a
// figure collected in a tab and a figure collected by CI mean exactly the same
// thing.
//
// A registration number exists only for the duration of the requests that read
// it — the offset is the only thing written down, so a run that dies mid-block
// resumes without knowing who it met.
//
// Pacing is the shared `RateGovernor`: an aggregate requests-per-second ceiling
// that ramps up while the portal says yes and halves on any 429. Measured
// 2026-09-29: 35.6 req/s sustained for 45 s with zero 429s, p50 291 ms. The
// governor exists so that number is a decision rather than an accident of latency,
// and so a slow portal slows the crawl instead of being hammered.
//
// Deliberately framework-free (like lib/bulk/runner.ts) so it stays usable
// outside React.
import { fetchStudentDetails, fetchSubjects } from "@/lib/bput.functions";
import { censusCursorState, logCensusEvents, saveCursor } from "@/lib/census-client";
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
} from "@/lib/census-core";
import { SKIP_AFTER_MISSES, censusBlocks, type CensusBlock } from "@/lib/census-blocks";

export { estimateRequests, parseCensusRange, rollAt } from "@/lib/census-core";
export { SKIP_AFTER_MISSES, censusBlocks } from "@/lib/census-blocks";

export interface CensusRunnerState {
  running: boolean;
  paused: boolean;
  cancelled: boolean;
  /** Which engine is running: one declared range, or the whole measured grid. */
  mode: "range" | "grid";
  rangeStart: string | null;
  rangeEnd: string | null;
  /** Offset into the range — a position, never a student. */
  index: number;
  total: number;
  /** Registration numbers probed. */
  visited: number;
  /** Probes that returned a student record. */
  students: number;
  /** Probes that returned nothing, i.e. an unused number. */
  notFound: number;
  observations: number;
  stored: number;
  /** Grid mode: blocks finished, and how many the run intends to walk. */
  blocksDone: number;
  blocksSkipped: number;
  gridTotal: number;
  /** Grid mode: the block currently in flight and its serial offset. */
  blockLabel: string | null;
  blockSerial: number;
  blockTotal: number;
  /** Effective settings for this run, for display. */
  concurrency: number;
  maxRps: number;
  rateLimits: number;
  lastError: string | null;
}

const BATCH_SIZE = 25;
const FLUSH_EVERY = 40;
const MAX_CONCURRENCY = 8;

const state: CensusRunnerState = {
  running: false,
  paused: false,
  cancelled: false,
  mode: "range",
  rangeStart: null,
  rangeEnd: null,
  index: 0,
  total: 0,
  visited: 0,
  students: 0,
  notFound: 0,
  observations: 0,
  stored: 0,
  blocksDone: 0,
  blocksSkipped: 0,
  gridTotal: 0,
  blockLabel: null,
  blockSerial: 0,
  blockTotal: 0,
  concurrency: 1,
  maxRps: 0,
  rateLimits: 0,
  lastError: null,
};

type Listener = (s: Readonly<CensusRunnerState>) => void;
const listeners = new Set<Listener>();

export function subscribeCensus(fn: Listener): () => void {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
}

export function getCensusState(): Readonly<CensusRunnerState> {
  return { ...state };
}

export function pauseCensus(): void {
  if (state.running) state.paused = true;
  emit();
}

export function resumeCensus(): void {
  if (state.running) state.paused = false;
  emit();
}

export function cancelCensus(): void {
  state.cancelled = true;
  state.paused = false;
  emit();
}

function emit() {
  const snap = { ...state };
  listeners.forEach((l) => l(snap));
}

async function waitWhilePaused(): Promise<void> {
  while (state.paused && !state.cancelled) await sleep(250);
}

/** The portal, reached through the worker so the browser never sees its CORS. */
const fetchers: CensusFetchers = {
  studentDetails: (rollNo) => fetchStudentDetails({ data: { rollNo } }),
  subjects: (input) => fetchSubjects({ data: input }),
};

function resetState(patch: Partial<CensusRunnerState>): void {
  Object.assign(state, {
    running: true,
    paused: false,
    cancelled: false,
    visited: 0,
    students: 0,
    notFound: 0,
    observations: 0,
    stored: 0,
    blocksDone: 0,
    blocksSkipped: 0,
    gridTotal: 0,
    blockLabel: null,
    blockSerial: 0,
    blockTotal: 0,
    rateLimits: 0,
    lastError: null,
    ...patch,
  });
  emit();
}

/* ─────────────────────────────────────────── one declared range (manual) ── */

export interface RunCensusInput {
  rangeStart: string;
  rangeEnd: string;
  rateLimitMs?: number;
  probeBackPapers?: boolean;
  /** Skip the server-side resume lookup (used by a fresh run). */
  startIndex?: number;
}

/**
 * Run (or resume) a census range. Resolves when the range completes, is
 * cancelled, or a persistence failure stops the run — never throws for
 * upstream problems, which are recorded as observations instead.
 */
export async function runCensus(input: RunCensusInput): Promise<void> {
  if (state.running) return;

  const { start, end, width, total } = parseCensusRange(input.rangeStart, input.rangeEnd);
  const rateMs = Math.max(250, input.rateLimitMs ?? DEFAULT_RATE_MS);
  const runtime: CensusRuntime = {
    rateMs,
    probeBackPapers: input.probeBackPapers ?? false,
    gate: waitWhilePaused,
  };

  let index = input.startIndex ?? 0;
  if (input.startIndex === undefined) {
    try {
      const cursor = await censusCursorState(start, end);
      index = cursor.exists ? cursor.nextIndex : 0;
    } catch {
      index = 0;
    }
  }

  resetState({
    mode: "range",
    rangeStart: start,
    rangeEnd: end,
    index,
    total,
    concurrency: 1,
    maxRps: +(1000 / rateMs).toFixed(2),
  });

  let pending: CensusObservation[] = [];
  let winVisited = 0;
  let winNotFound = 0;
  let winFacts = 0;
  let sinceFlush = 0;

  const flush = async (status: "running" | "paused" | "done") => {
    if (pending.length > 0) {
      const stored = await logCensusEvents(pending);
      winFacts += stored;
      state.stored += stored;
      pending = [];
    }
    if (winVisited > 0 || winNotFound > 0 || winFacts > 0 || status !== "running") {
      await saveCursor({
        rangeStart: start,
        rangeEnd: end,
        nextIndex: state.index,
        visitedAdd: winVisited,
        notFoundAdd: winNotFound,
        factsAdd: winFacts,
        status,
      });
      winVisited = 0;
      winNotFound = 0;
      winFacts = 0;
    }
    sinceFlush = 0;
    emit();
  };

  try {
    while (state.index < total) {
      if (state.cancelled) break;
      await waitWhilePaused();
      if (state.cancelled) break;

      const rollNo = rollAt(start, state.index, width);
      await sleep(rateMs);

      const student = await loadStudent(fetchers, rollNo);
      state.visited += 1;
      winVisited += 1;
      sinceFlush += 1;

      if (student === null) {
        state.notFound += 1;
        winNotFound += 1;
      } else if (student === undefined) {
        state.lastError = "Upstream unavailable — this number was skipped, not counted as missing.";
      } else {
        state.students += 1;
        const observations = await observeStudent(fetchers, student, rollNo, runtime);
        if (observations.length > 0) {
          pending.push(...observations);
          state.observations += observations.length;
        }
      }

      if (pending.length >= BATCH_SIZE || sinceFlush >= FLUSH_EVERY) {
        await flush(state.paused ? "paused" : "running");
      }

      state.index += 1;
      emit();
    }
  } finally {
    const finished = state.index >= total;
    try {
      await flush(finished ? "done" : "paused");
    } catch (e) {
      state.lastError = `Could not persist progress: ${(e as Error)?.message ?? "unknown"}`;
    }
    state.running = false;
    state.paused = false;
    emit();
  }
}

/* ────────────────────────────────────────────────── the measured grid ─── */

export interface RunCensusGridInput {
  /** Batch years as two-digit values (23) or full years (2023). Empty means all. */
  years?: number[];
  /** Walk at most this many blocks this session. 0 or undefined means no cap. */
  maxBlocks?: number;
  /** Workers, each owning one college-year block at a time. */
  concurrency?: number;
  /** Aggregate request ceiling in requests per second. */
  maxRps?: number;
  probeBackPapers?: boolean;
}

function selectBlocks(years: number[] | undefined, maxBlocks: number): CensusBlock[] {
  const all = censusBlocks();
  const selected =
    years && years.length > 0
      ? all.filter((b) => years.includes(b.year) || years.includes(b.year - 2000))
      : all;
  return maxBlocks > 0 ? selected.slice(0, maxBlocks) : selected;
}

/**
 * Walk the measured grid. Each worker owns one block, reads its own persisted
 * offset, walks its serials in order, and gives up on the block after
 * `SKIP_AFTER_MISSES` consecutive misses — so a block costs its intake rather
 * than its declared bound.
 *
 * A transient upstream failure never counts as a miss: the block is parked at the
 * same serial and retried next session, because a flaky portal must not be
 * recorded as an empty college.
 */
export async function runCensusGrid(input: RunCensusGridInput = {}): Promise<void> {
  if (state.running) return;

  const maxBlocks = Math.max(0, input.maxBlocks ?? 0);
  const blocks = selectBlocks(input.years, maxBlocks);
  if (blocks.length === 0) {
    state.lastError = "No census blocks selected.";
    emit();
    return;
  }

  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, input.concurrency ?? 4));
  const maxRps = Math.max(1, input.maxRps ?? 8);
  // Ramp up from a quarter of the ceiling; halve on any 429. Same governor the
  // scheduled tick uses, so both engines discover the same safe speed.
  const governor = new RateGovernor(maxRps);
  const runtime: CensusRuntime = {
    rateMs: DEFAULT_RATE_MS,
    probeBackPapers: input.probeBackPapers ?? false,
    governor,
    gate: waitWhilePaused,
  };

  resetState({
    mode: "grid",
    rangeStart: null,
    rangeEnd: null,
    index: 0,
    total: blocks.length,
    gridTotal: blocks.length,
    concurrency,
    maxRps,
  });

  let next = 0;

  const worker = async () => {
    while (!state.cancelled && next < blocks.length) {
      const block = blocks[next++];
      const { start, end, width, total } = parseCensusRange(block.start, block.end);

      let index = 0;
      try {
        const cursor = await censusCursorState(start, end);
        index = cursor.exists ? Math.min(cursor.nextIndex, total) : 0;
      } catch {
        index = 0;
      }

      state.rangeStart = start;
      state.rangeEnd = end;
      state.blockLabel = block.label;
      state.blockSerial = index;
      state.blockTotal = total;
      emit();

      let pending: CensusObservation[] = [];
      let winVisited = 0;
      let winNotFound = 0;
      let winFacts = 0;
      let misses = 0;

      const flush = async (status: "running" | "paused" | "done") => {
        if (pending.length > 0) {
          const stored = await logCensusEvents(pending);
          winFacts += stored;
          state.stored += stored;
          pending = [];
        }
        if (winVisited > 0 || winNotFound > 0 || winFacts > 0 || status !== "running") {
          await saveCursor({
            rangeStart: start,
            rangeEnd: end,
            nextIndex: index,
            visitedAdd: winVisited,
            notFoundAdd: winNotFound,
            factsAdd: winFacts,
            status,
          });
          winVisited = 0;
          winNotFound = 0;
          winFacts = 0;
        }
        emit();
      };

      try {
        while (index < total) {
          if (state.cancelled) break;
          await waitWhilePaused();
          if (state.cancelled) break;

          const rollNo = rollAt(start, index, width);
          await governor.acquire();

          const student = await loadStudent(fetchers, rollNo, governor);
          state.visited += 1;
          winVisited += 1;

          if (student === undefined) {
            // Upstream trouble, not an empty serial: park the block here.
            state.lastError = `Upstream unavailable — ${block.label} parked at serial ${rollNo.slice(-3)}.`;
            break;
          }

          if (student === null) {
            state.notFound += 1;
            winNotFound += 1;
            misses += 1;
          } else {
            misses = 0;
            state.students += 1;
            const observations = await observeStudent(fetchers, student, rollNo, runtime);
            if (observations.length > 0) {
              pending.push(...observations);
              state.observations += observations.length;
              winFacts += observations.length;
            }
          }

          index += 1;
          state.blockSerial = index;

          if (misses >= SKIP_AFTER_MISSES) {
            index = total;
            state.blocksSkipped += 1;
            break;
          }

          if (pending.length >= BATCH_SIZE) await flush("running");
          emit();
        }
      } finally {
        try {
          await flush(index >= total ? "done" : "paused");
        } catch (e) {
          state.lastError = `Could not persist progress: ${(e as Error)?.message ?? "unknown"}`;
        }
      }

      state.blocksDone += 1;
      state.rateLimits = governor.rateLimits;
      emit();
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    state.running = false;
    state.paused = false;
    state.blockLabel = null;
    emit();
  }
}
