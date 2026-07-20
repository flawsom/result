// Client-side analytics over cached bulk results in IndexedDB.
// All computation is pure — no server aggregation, no network.
import { GRADE_POINTS, type Grade } from "@/lib/sgpa";
import type { BulkJob } from "./db";

export interface JobStats {
  total: number;
  withResults: number;
  avgCgpa: number | null;
  avgSgpa: number | null;
  medianCgpa: number | null;
  passRate: number; // pct of subject attempts that are non-failing
}

export interface HistogramBin {
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface BranchStat {
  branch: string;
  students: number;
  avgCgpa: number;
  avgSgpa: number;
  passRate: number;
}

export interface SubjectStat {
  code: string;
  name: string;
  attempts: number;
  failures: number;
  failureRate: number;
  avgPoints: number;
}

export interface GradeCount {
  grade: Grade;
  count: number;
  points: number;
}

const FAILING: ReadonlySet<Grade> = new Set(["F", "M", "S"]);

function isFinishedJob(j: BulkJob) {
  return j.status === "done" && !!j.student;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function computeJobStats(jobs: BulkJob[]): JobStats {
  const finished = jobs.filter(isFinishedJob);
  const cgpas: number[] = [];
  const sgpas: number[] = [];
  let attempts = 0;
  let passing = 0;

  for (const j of finished) {
    const c = numOrNull(j.cgpa);
    if (c !== null) cgpas.push(c);
    for (const sem of j.semesters ?? []) {
      const s = numOrNull(sem.data?.sgpadetails?.sgpa);
      if (s !== null) sgpas.push(s);
      for (const g of sem.data?.grades ?? []) {
        attempts += 1;
        if (!FAILING.has(g.grade)) passing += 1;
      }
    }
  }

  const avg = (arr: number[]) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null);

  const median = (arr: number[]) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  return {
    total: jobs.length,
    withResults: finished.length,
    avgCgpa: avg(cgpas),
    avgSgpa: avg(sgpas),
    medianCgpa: median(cgpas),
    passRate: attempts ? passing / attempts : 0,
  };
}

export function histogram(values: number[], min = 0, max = 10, bins = 10): HistogramBin[] {
  const width = (max - min) / bins;
  const out: HistogramBin[] = Array.from({ length: bins }, (_, i) => ({
    min: +(min + i * width).toFixed(2),
    max: +(min + (i + 1) * width).toFixed(2),
    label: `${(min + i * width).toFixed(1)}–${(min + (i + 1) * width).toFixed(1)}`,
    count: 0,
  }));
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let idx = Math.floor((v - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    out[idx].count += 1;
  }
  return out;
}

export function cgpaValues(jobs: BulkJob[]): number[] {
  return jobs
    .filter(isFinishedJob)
    .map((j) => numOrNull(j.cgpa))
    .filter((v): v is number => v !== null);
}

export function sgpaValues(jobs: BulkJob[]): number[] {
  const out: number[] = [];
  for (const j of jobs.filter(isFinishedJob)) {
    for (const sem of j.semesters ?? []) {
      const s = numOrNull(sem.data?.sgpadetails?.sgpa);
      if (s !== null) out.push(s);
    }
  }
  return out;
}

export function gradeCounts(jobs: BulkJob[]): GradeCount[] {
  const counts = new Map<Grade, number>();
  for (const j of jobs.filter(isFinishedJob)) {
    for (const sem of j.semesters ?? []) {
      for (const g of sem.data?.grades ?? []) {
        counts.set(g.grade, (counts.get(g.grade) ?? 0) + 1);
      }
    }
  }
  const order: Grade[] = ["O", "E", "A", "B", "C", "D", "F", "M", "S"];
  return order
    .filter((g) => (counts.get(g) ?? 0) > 0)
    .map((g) => ({ grade: g, count: counts.get(g) ?? 0, points: GRADE_POINTS[g] }));
}

export function branchStats(jobs: BulkJob[]): BranchStat[] {
  const map = new Map<
    string,
    { cgpas: number[]; sgpas: number[]; attempts: number; passing: number }
  >();
  for (const j of jobs.filter(isFinishedJob)) {
    const b = (j.student?.branchName ?? "Unknown").trim() || "Unknown";
    let entry = map.get(b);
    if (!entry) {
      entry = { cgpas: [], sgpas: [], attempts: 0, passing: 0 };
      map.set(b, entry);
    }
    const c = numOrNull(j.cgpa);
    if (c !== null) entry.cgpas.push(c);
    for (const sem of j.semesters ?? []) {
      const s = numOrNull(sem.data?.sgpadetails?.sgpa);
      if (s !== null) entry.sgpas.push(s);
      for (const g of sem.data?.grades ?? []) {
        entry.attempts += 1;
        if (!FAILING.has(g.grade)) entry.passing += 1;
      }
    }
  }
  const avg = (arr: number[]) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0);
  return [...map.entries()]
    .map(([branch, e]) => ({
      branch,
      students: e.cgpas.length,
      avgCgpa: +avg(e.cgpas).toFixed(2),
      avgSgpa: +avg(e.sgpas).toFixed(2),
      passRate: e.attempts ? +(e.passing / e.attempts).toFixed(4) : 0,
    }))
    .sort((a, b) => b.avgCgpa - a.avgCgpa);
}

export function subjectStats(jobs: BulkJob[], limit = 20): SubjectStat[] {
  const map = new Map<
    string,
    { name: string; attempts: number; failures: number; totalPoints: number }
  >();
  for (const j of jobs.filter(isFinishedJob)) {
    for (const sem of j.semesters ?? []) {
      for (const g of sem.data?.grades ?? []) {
        const key = g.subjectCODE || g.subjectName;
        let e = map.get(key);
        if (!e) {
          e = { name: g.subjectName, attempts: 0, failures: 0, totalPoints: 0 };
          map.set(key, e);
        }
        e.attempts += 1;
        e.totalPoints += Number(g.points) || 0;
        if (FAILING.has(g.grade)) e.failures += 1;
      }
    }
  }
  const all: SubjectStat[] = [...map.entries()].map(([code, e]) => ({
    code,
    name: e.name,
    attempts: e.attempts,
    failures: e.failures,
    failureRate: e.attempts ? e.failures / e.attempts : 0,
    avgPoints: e.attempts ? +(e.totalPoints / e.attempts).toFixed(2) : 0,
  }));
  return all
    .filter((s) => s.attempts >= 3)
    .sort((a, b) => b.failureRate - a.failureRate || b.attempts - a.attempts)
    .slice(0, limit);
}

export function topStudents(jobs: BulkJob[], limit = 10) {
  return jobs
    .filter(isFinishedJob)
    .filter((j) => numOrNull(j.cgpa) !== null)
    .sort((a, b) => (b.cgpa ?? 0) - (a.cgpa ?? 0))
    .slice(0, limit);
}
