// Paced BPUT census runner, driven from a page.
//
// Walks a declared registration-number range one request at a time, reduces each
// student to anonymous observations, and persists both the observations and the
// crawl offset at the end of every batch. A registration number exists only for
// the duration of the request that reads it — the offset is the only thing
// written down, so a run that dies mid-range resumes without knowing who it met.
//
// The reduction itself lives in `census-core.ts` and is shared with the headless
// scheduled tick, so a figure collected by either runner means exactly the same
// thing. What is specific to this file is only the part a browser adds: pause,
// resume, cancel, and a live in-memory view of the current run.
//
// Deliberately framework-free (like lib/bulk/runner.ts) so it stays usable
// outside React.
import { fetchStudentDetails, fetchSubjects } from "@/lib/bput.functions";
import { censusCursorState, logCensusEvents, saveCursor } from "@/lib/census-client";
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
} from "@/lib/census-core";

export { estimateRequests, parseCensusRange, rollAt } from "@/lib/census-core";

export interface CensusRunnerState {
  running: boolean;
  paused: boolean;
  cancelled: boolean;
  rangeStart: string | null;
  rangeEnd: string | null;
  /** Offset into the range — a position, never a student. */
  index: number;
  total: number;
  /** Registration numbers probed. */
  visited: number;
  /** Probes that returned a student record. */
  students: number;
  /** Probes that returned nothing, i.e. an unused number in the range. */
  notFound: number;
  observations: number;
  stored: number;
  lastError: string | null;
}

const BATCH_SIZE = 25;
const FLUSH_EVERY = 40;

const state: CensusRunnerState = {
  running: false,
  paused: false,
  cancelled: false,
  rangeStart: null,
  rangeEnd: null,
  index: 0,
  total: 0,
  visited: 0,
  students: 0,
  notFound: 0,
  observations: 0,
  stored: 0,
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

  Object.assign(state, {
    running: true,
    paused: false,
    cancelled: false,
    rangeStart: start,
    rangeEnd: end,
    index,
    total,
    visited: 0,
    students: 0,
    notFound: 0,
    observations: 0,
    stored: 0,
    lastError: null,
  });
  emit();

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
