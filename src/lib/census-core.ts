// Census reduction — the part that turns a student record into anonymous
// observations. Pure, framework-free, and identical whether the crawl is driven
// from a browser tab or from the scheduled headless tick, so a figure on the
// landing page cannot depend on which runner happened to collect it.
import { getSemesterAttempts, parseBatchYear } from "./bulk/sessions";
import { GRADE_POINTS, type Grade, type StudentDetails, type SubjectsResponse } from "./sgpa";
import { ERR } from "./bput-upstream";

/** One anonymous student-semester observation. No identity field exists. */
export interface CensusObservation {
  batchYear: number;
  semester: number;
  branch: string;
  college: string;
  outcome: "published" | "not_published" | "failed" | "unreachable";
  subjects: number;
  credits: number;
  points: number;
  /** Grade histogram, e.g. { O: 2, A: 3 }. Only the nine known grades. */
  grades: Partial<Record<string, number>>;
}

/** The two upstream reads a census walk needs, injected so both runtimes share it. */
export interface CensusFetchers {
  studentDetails(rollNo: string): Promise<StudentDetails>;
  subjects(input: { rollNo: string; semId: string; session: string }): Promise<SubjectsResponse>;
}

export interface CensusRuntime {
  /** Politeness delay before every upstream request. */
  rateMs: number;
  /** Whether to re-probe cleared semesters through supplementary sessions. */
  probeBackPapers: boolean;
  /** Called before every request; the browser runner parks here while paused. */
  gate?: () => Promise<void>;
  /** Milliseconds to stand down when upstream says it is rate limiting. */
  rateLimitBackoffMs?: number;
}

export const MAX_RANGE = 200_000;
export const SEMESTER_MAX = 12;
export const DEFAULT_RATE_MS = 1_000;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function classifyUpstream(msg: string): "missing" | "rate_limited" | "fatal" | "transient" {
  if (msg.startsWith(ERR.NOT_PUBLISHED)) return "missing";
  if (msg.startsWith(ERR.RATE_LIMITED)) return "rate_limited";
  if (msg.startsWith(ERR.BAD_INPUT)) return "fatal";
  return "transient";
}

export function normalizeCell(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function clampInt(value: unknown, min: number, max: number): number {
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
  const semesters = 8;
  const perStudent = 1 + semesters * (probeBackPapers ? 5 : 1);
  return total * perStudent;
}

/** Student record, or null when the number is unused, or undefined on failure. */
export async function loadStudent(
  fetchers: CensusFetchers,
  rollNo: string,
): Promise<StudentDetails | null | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchers.studentDetails(rollNo);
    } catch (e) {
      const kind = classifyUpstream((e as Error)?.message ?? "");
      if (kind === "missing" || kind === "fatal") return null;
      if (kind === "rate_limited") {
        await sleep(DEFAULT_RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      await sleep(600 * (attempt + 1));
    }
  }
  return undefined;
}

export interface SemesterFact {
  outcome: CensusObservation["outcome"];
  subjects: number;
  credits: number;
  points: number;
  grades: Partial<Record<string, number>>;
}

/** First session that has grades wins; otherwise the semester is unpublished. */
export async function readSemester(
  fetchers: CensusFetchers,
  input: { rollNo: string; semester: number; sessions: string[] },
  runtime: CensusRuntime,
): Promise<SemesterFact> {
  let sawTransientFailure = false;

  for (const session of input.sessions) {
    await runtime.gate?.();
    await sleep(runtime.rateMs);
    try {
      const res = await fetchers.subjects({
        rollNo: input.rollNo,
        semId: String(input.semester),
        session,
      });
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
      const kind = classifyUpstream((e as Error)?.message ?? "");
      if (kind === "rate_limited") {
        await sleep(runtime.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS);
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

export interface StudentSnapshot {
  batch?: string | null;
  branchName?: string | null;
  branchId?: string | null;
  collegeName?: string | null;
}

/**
 * Reduce one student to observations, then forget the student. Returns an empty
 * list when the record carries no usable batch/branch, which is a genuine skip
 * rather than a zero.
 */
export async function observeStudent(
  fetchers: CensusFetchers,
  student: StudentSnapshot,
  rollNo: string,
  runtime: CensusRuntime,
): Promise<CensusObservation[]> {
  const batchYear = parseBatchYear(student.batch ?? "");
  if (batchYear === null) return [];

  const branch = normalizeCell(student.branchName ?? student.branchId);
  if (!branch) return [];
  const college = normalizeCell(student.collegeName);

  const out: CensusObservation[] = [];
  for (const plan of getSemesterAttempts(batchYear)) {
    const semester = Number(plan.semId);
    if (!Number.isFinite(semester) || semester < 1 || semester > SEMESTER_MAX) continue;

    const sessions = runtime.probeBackPapers
      ? [plan.primary, ...plan.backAttempts]
      : [plan.primary];
    const fact = await readSemester(fetchers, { rollNo, semester, sessions }, runtime);

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
