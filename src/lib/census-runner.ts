// Paced BPUT census runner.
//
// Walks a declared registration-number range one request at a time, reduces each
// student to anonymous observations, and persists the observations and the crawl
// offset together at the end of every batch. A registration number exists only
// for the duration of the request that reads it — the offset is the only thing
// written down, so a run that dies mid-range resumes without knowing who it met.
//
// Deliberately framework-free (like lib/bulk/runner.ts) so the same code can be
// driven from the admin page today and from a scheduled job later.
import { fetchStudentDetails, fetchSubjects, ERR } from "@/lib/bput.functions";
import { getSemesterAttempts, parseBatchYear } from "@/lib/bulk/sessions";
import {
  censusCursorState,
  logCensusEvents,
  saveCursor,
  type CensusObservation,
} from "@/lib/census-client";
import { GRADE_POINTS, type Grade } from "@/lib/sgpa";

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

const MAX_RANGE = 200_000;
const BATCH_SIZE = 25;
const FLUSH_EVERY = 40;
const DEFAULT_RATE_MS = 1_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const SEMESTER_MAX = 12;

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitWhilePaused(): Promise<void> {
  while (state.paused && !state.cancelled) await sleep(250);
}

function classify(msg: string): "missing" | "rate_limited" | "fatal" | "transient" {
  if (msg.startsWith(ERR.NOT_PUBLISHED)) return "missing";
  if (msg.startsWith(ERR.RATE_LIMITED)) return "rate_limited";
  if (msg.startsWith(ERR.BAD_INPUT)) return "fatal";
  return "transient";
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/** Roll number at `index` inside a fixed-width numeric range, zero-padded. */
export function rollAt(rangeStart: string, index: number, width: number): string {
  return (BigInt(rangeStart) + BigInt(index)).toString().padStart(width, "0");
}

export interface ParsedRange {
  start: string;
  end: string;
  width: number;
  total: number;
}

export function parseCensusRange(rangeStart: string, rangeEnd: string): ParsedRange {
  const start = rangeStart.trim();
  const end = rangeEnd.trim();
  if (!/^\d{6,12}$/.test(start) || !/^\d{6,12}$/.test(end)) {
    throw new Error("Both bounds must be 6–12 digit numbers.");
  }
  if (start.length !== end.length) {
    throw new Error("Both bounds must have the same number of digits.");
  }
  const a = BigInt(start);
  const b = BigInt(end);
  if (b < a) throw new Error("End must be greater than or equal to start.");
  const total = Number(b - a) + 1;
  if (total > MAX_RANGE) {
    throw new Error(
      `Range covers ${total.toLocaleString()} numbers. Max is ${MAX_RANGE.toLocaleString()}.`,
    );
  }
  return { start, end, width: start.length, total };
}

/**
 * Upstream requests a range will cost: one for the student record plus one per
 * semester, and up to five per semester when back-paper probes are enabled.
 * A 5,000-number range is already ~45,000 requests at the default pace.
 */
export function estimateRequests(total: number, probeBackPapers = false): number {
  const perStudent = 1 + 8 * (probeBackPapers ? 5 : 1);
  return total * perStudent;
}

/** Student record, or null when the number is unused, or undefined on failure. */
async function loadStudent(rollNo: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchStudentDetails({ data: { rollNo } });
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      const kind = classify(msg);
      if (kind === "missing" || kind === "fatal") return null;
      if (kind === "rate_limited") {
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      await sleep(600 * (attempt + 1));
    }
  }
  return undefined;
}

interface SemesterFact {
  outcome: CensusObservation["outcome"];
  subjects: number;
  credits: number;
  points: number;
  grades: Partial<Record<string, number>>;
}

/** First session that has grades wins; otherwise the semester is unpublished. */
async function readSemester(
  rollNo: string,
  semester: number,
  sessions: string[],
): Promise<SemesterFact> {
  let sawTransientFailure = false;

  for (const session of sessions) {
    try {
      const res = await fetchSubjects({ data: { rollNo, semId: String(semester), session } });
      const grades = res?.grades ?? [];
      if (grades.length === 0) continue;

      const histogram: Partial<Record<string, number>> = {};
      let credits = 0;
      let points = 0;
      for (const g of grades) {
        const grade = g.grade as Grade;
        if (grade in GRADE_POINTS) histogram[grade] = (histogram[grade] ?? 0) + 1;
        credits += Number(g.subjectCredits) || 0;
        points += Number(g.creditPoints) || 0;
      }

      return {
        outcome: "published",
        subjects: clampInt(grades.length, 0, 40),
        // BPUT's own totals are authoritative when present.
        credits: clampInt(res?.sgpadetails?.cretits ?? credits, 0, 200),
        points: clampInt(res?.sgpadetails?.totalGradePoints ?? points, 0, 400),
        grades: histogram,
      };
    } catch (e) {
      const kind = classify((e as Error)?.message ?? "");
      if (kind === "rate_limited") {
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      if (kind === "missing") continue;
      sawTransientFailure = true;
      break;
    }
  }

  return sawTransientFailure
    ? { outcome: "unreachable", subjects: 0, credits: 0, points: 0, grades: {} }
    : { outcome: "not_published", subjects: 0, credits: 0, points: 0, grades: {} };
}

async function observeStudent(
  student: {
    batch?: string | null;
    branchName?: string | null;
    branchId?: string | null;
    collegeName?: string | null;
  },
  rollNo: string,
  rateMs: number,
  probeBackPapers: boolean,
): Promise<CensusObservation[]> {
  const batchYear = parseBatchYear(student.batch ?? "");
  if (batchYear === null) return [];

  const branch = normalize(student.branchName ?? student.branchId);
  const college = normalize(student.collegeName);
  if (!branch) return [];

  const out: CensusObservation[] = [];
  for (const plan of getSemesterAttempts(batchYear)) {
    const semester = Number(plan.semId);
    if (!Number.isFinite(semester) || semester < 1 || semester > SEMESTER_MAX) continue;

    const sessions = probeBackPapers ? [plan.primary, ...plan.backAttempts] : [plan.primary];
    await sleep(rateMs);
    const fact = await readSemester(rollNo, semester, sessions);

    out.push({
      batchYear,
      semester,
      branch,
      college,
      outcome: fact.outcome,
      subjects: fact.subjects,
      credits: fact.credits,
      points: fact.points,
      grades: fact.grades,
    });
  }
  return out;
}

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
  const probe = input.probeBackPapers ?? false;

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

      const student = await loadStudent(rollNo);
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
        const observations = await observeStudent(student, rollNo, rateMs, probe);
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
