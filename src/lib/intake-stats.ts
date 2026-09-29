// ─────────────────────────────────────────────────────────────────────────────
// Intake intelligence — the measured university, turned into figures.
//
// `census-blocks.ts` holds the measurement: which registration-number blocks
// exist and how many students each holds, probed block by block on 2026-09-29.
// This module is the analysis layer over it, written in the same spirit as
// `analytics-stats.ts` — pure functions, one implementation of each estimator,
// every figure traceable to either the measurement or the live census counters,
// and every estimate labelled as an estimate.
//
// Two questions it answers:
//   • the intake series — how many students each batch year holds, how that has
//     moved across 14 measured years, and how unevenly it sits across colleges;
//   • the acquisition series — how much of that measured universe the running
//     crawl has actually read, and what is left of it.
//
// What it deliberately does not do: describe a person. The finest grain here is
// one college in one batch year, which is a block of registration numbers, and
// the applied numbers are the portal's own numbering, not enrolment.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CENSUS_YEARS,
  MEASURED_BLOCKS,
  MEASURED_HOLE_RATE,
  MEASURED_INTAKE,
  MEASURED_SERIALS,
  MEASURED_STUDENTS,
  REQUESTS_PER_STUDENT,
  SKIP_AFTER_MISSES,
  estimatedRequests,
  measuredBlocks,
  measuredStudents,
} from "@/lib/census-blocks";
import type { CensusLiveCounters, CensusPayload, CensusPlan } from "@/lib/census-client";
import {
  cagr,
  gini,
  linearRegression,
  lorenz,
  quantileSorted,
  sum,
  theilSen,
  type Regression,
} from "@/lib/analytics-stats";

/* ──────────────────────────────────────────────────────── the intake series ─ */

export interface IntakeRow {
  /** Admission year, e.g. 2012. */
  year: number;
  /** Colleges with a batch in this year. */
  blocks: number;
  /** Registration numbers the year's blocks declare — an upper bound. */
  serials: number;
  /** Students after the measured hole rate for the year's era is removed. */
  students: number;
  /** Serial numbers that answer for nobody. */
  holes: number;
  /** Hole rate applied to this year. */
  holeRate: number;
  /** Mean students per college. */
  meanCollege: number;
  /** The median college's highest live serial. */
  medianCollege: number;
  /** The largest single college's highest live serial. */
  maxCollege: number;
  /** Share of the measured grid this batch year holds. */
  share: number;
  /** Change in students against the previous batch year; null for the first. */
  yoy: number | null;
  /** Three-year centred mean of students — the raw value at the two edges. */
  trend3: number;
}

export interface IntakeSeries {
  rows: IntakeRow[];
  first: IntakeRow;
  last: IntakeRow;
  /** Students the whole grid holds, holes removed. */
  totalStudents: number;
  /** Registration numbers the grid declares. */
  totalSerials: number;
  /** Serials that answer for nobody. */
  totalHoles: number;
  meanStudents: number;
  medianStudents: number;
  /** Biggest and smallest batch year on record. */
  peak: IntakeRow;
  trough: IntakeRow;
  /** Least squares line through the 14 measured years. */
  fit: Regression;
  /** Median pairwise slope — the same line, protected from the 2020 trough. */
  robustSlope: number;
  /** Compound annual change from the first measured year to the last. */
  growth: number | null;
  /** Change from the trough year through the last measured year. */
  recovery: number | null;
  /** Change from the first measured year through the last. */
  netChange: number;
  /** Upstream reads a completed grid costs, from this same measurement. */
  requestBudget: number;
  meanBlocks: number;
}

/**
 * The intake series, from the measurement.
 *
 * Holes are removed per era rather than at one flat rate because the measurement
 * found them unevenly distributed: 3.4% of serials below the maximum are missing
 * in the 2012–2014 batches, 0.4% from 2015 on. Both rates come from 22 blocks
 * walked serial by serial, and both are stated on the panel that draws them.
 */
export function intakeSeries(): IntakeSeries {
  // A batch year discovery has just added has no measurement until the same day's
  // `--write-constants` run writes one, and a row of zeroes would be a worse lie
  // than an absent row: it is drawn once its blocks have been measured.
  const measured = CENSUS_YEARS.filter((short) => MEASURED_INTAKE[2000 + short]);
  const rows: IntakeRow[] = measured.map((short) => {
    const year = 2000 + short;
    const intake = MEASURED_INTAKE[year];
    const holeRate = year <= 2014 ? MEASURED_HOLE_RATE.before2015 : MEASURED_HOLE_RATE.from2015;
    const students = measuredStudents(year);
    return {
      year,
      blocks: intake.blocks,
      serials: intake.serials,
      students,
      holes: intake.serials - students,
      holeRate,
      meanCollege: intake.mean * (1 - holeRate),
      medianCollege: intake.median,
      maxCollege: intake.max,
      share: 0,
      yoy: null,
      trend3: students,
    };
  });

  const totalStudents = MEASURED_STUDENTS;
  const meanStudents = totalStudents / rows.length;
  for (const row of rows) row.share = row.students / totalStudents;
  rows.forEach((row, i) => {
    const previous = rows[i - 1];
    row.yoy = previous ? (row.students - previous.students) / previous.students : null;
    const window = rows.slice(Math.max(0, i - 1), Math.min(rows.length, i + 2));
    row.trend3 = window.reduce((a, r) => a + r.students, 0) / window.length;
  });

  const bySize = [...rows].sort((a, b) => a.students - b.students);
  const index = rows.map((_, i) => i);
  const students = rows.map((r) => r.students);
  const fit = linearRegression(index, students);
  const robustSlope = theilSen(index, students);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const trough = bySize[0];

  return {
    rows,
    first,
    last,
    totalStudents,
    totalSerials: MEASURED_SERIALS,
    totalHoles: MEASURED_SERIALS - totalStudents,
    meanStudents,
    medianStudents: quantileSorted(
      [...students].sort((a, b) => a - b),
      0.5,
    ),
    peak: bySize[bySize.length - 1],
    trough,
    fit,
    robustSlope,
    growth: cagr(first.students, last.students, rows.length - 1),
    recovery: trough.students > 0 ? (last.students - trough.students) / trough.students : null,
    netChange: first.students > 0 ? (last.students - first.students) / first.students : 0,
    requestBudget: estimatedRequests(),
    meanBlocks: MEASURED_BLOCKS / rows.length,
  };
}

/* ─────────────────────────────────────── how one college's intake is shaped ─ */

export interface IntakeBin {
  label: string;
  /** Inclusive lower edge. */
  lo: number;
  /** Inclusive upper edge; 600+ is open and carries Infinity. */
  hi: number;
  blocks: number;
  /** Registration numbers held by the blocks in this bin. */
  numbers: number;
}

export interface BlockDistribution {
  n: number;
  numbers: number;
  mean: number;
  min: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  p99: number;
  max: number;
  /** Concentration of intake across the 1,103 measured colleges. */
  gini: number;
  /** Lorenz curve of college size against a perfectly even system. */
  lorenz: Array<{ x: number; y: number }>;
  bins: IntakeBin[];
  /** The largest colleges by highest live serial. */
  top: Array<{ label: string; serial: number }>;
  /** Share of the intake held by the largest tenth of colleges. */
  topDecileShare: number;
  /** Colleges that never got past ten serials — a new or a dormant intake. */
  tiny: number;
}

const INTAKE_BINS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "1–25", lo: 0, hi: 25 },
  { label: "26–50", lo: 25, hi: 50 },
  { label: "51–100", lo: 50, hi: 100 },
  { label: "101–200", lo: 100, hi: 200 },
  { label: "201–400", lo: 200, hi: 400 },
  { label: "401–600", lo: 400, hi: 600 },
  { label: "601+", lo: 600, hi: Number.POSITIVE_INFINITY },
];

/**
 * The distribution of college size across the whole measured grid.
 *
 * Every figure is computed from the 1,103 per-block readings rather than from a
 * pre-aggregated summary, so the quantiles, the Lorenz curve and the histogram
 * cannot disagree with the intake series above. Values are the highest live
 * serial: an upper bound on a college's intake, exact for the population the
 * portal still answers for.
 */
export function blockDistribution(): BlockDistribution {
  const measured = measuredBlocks();
  const values = measured.map((b) => b.serial).filter((v) => Number.isFinite(v) && v >= 0);
  const sorted = [...values].sort((a, b) => a - b);
  const numbers = sum(values);
  const q = (p: number) => quantileSorted(sorted, p);
  const cut = q(0.9);

  return {
    n: values.length,
    numbers,
    mean: values.length > 0 ? numbers / values.length : 0,
    min: sorted[0] ?? 0,
    p10: q(0.1),
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p99: q(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    gini: gini(values),
    lorenz: lorenz(values),
    bins: INTAKE_BINS.map((bin) => {
      const hits = values.filter((v) => v > bin.lo && v <= bin.hi);
      return { ...bin, blocks: hits.length, numbers: sum(hits) };
    }),
    top: [...measured]
      .sort((a, b) => b.serial - a.serial)
      .slice(0, 5)
      .map((b) => ({ label: b.label, serial: b.serial })),
    topDecileShare: numbers > 0 ? sum(values.filter((v) => v >= cut)) / numbers : 0,
    tiny: values.filter((v) => v <= 10).length,
  };
}

/* ─────────────────────────────────────────── is the crawl reading any of it ─ */

export interface CensusAcquisition {
  /** Semester rows stored so far. */
  observations: number;
  /** Registration numbers probed so far. */
  visited: number;
  /** Probed numbers that answer for nobody. */
  notFound: number;
  /** Probed numbers that belong to a student. */
  found: number;
  /** Declared ranges the crawl has opened. */
  ranges: number;
  /** Ranges read end to end. */
  doneRanges: number;
  /** Semester rows stored per number probed. */
  yieldPerProbe: number;
  /** Rows stored ÷ (students found × 8): how much of a record the portal still serves. */
  historyDepth: number;
  /** Numbers probed ÷ the 160,609 the grid declares. */
  probeCoverage: number;
  /** Ranges completed ÷ the 1,103 the grid declares. */
  rangeCoverage: number;
  remainingNumbers: number;
  /** Reads paid so far: one probe per number plus one row per observation. Counted. */
  readsSpent: number;
  /**
   * Reads the first pass still has to spend, from the live ledger: the serials no
   * block has read yet, at nine reads a student and one a hole, plus the miss tail
   * every unfinished block pays.
   */
  firstPassReadsLeft: number;
  /**
   * Reads keeping the record current costs. A semester the portal has only now
   * started serving is read at two requests per student — the record and the term
   * — and never touches the semesters already captured.
   */
  maintenanceReads: number;
  /** Serials no block has read yet. */
  serialsLeft: number;
  /** Blocks whose first pass is finished. */
  blocksDone: number;
  /** Block-and-semester units the portal now serves that were not captured. */
  passesPending: number;
  /** When the portal's session window was last checked, from the ledger. */
  watchCheckedAt: string | null;
  /** True when the figures above came from the ledger rather than the baseline. */
  ledger: boolean;
  /** Reads left in total: the first pass plus the maintenance it will need. */
  readsLeft: number;
  /**
   * The denominator, derived rather than frozen: everything already spent plus
   * everything still outstanding. It grows when the portal publishes something
   * new, which is the difference between a budget and a countdown.
   */
  budget: number;
  /** The measurement-only basis, shown beside `budget` when the two disagree. */
  measuredBasis: number;
  active: boolean;
  lastBatchAt: string | null;
  /** False until the database has reported anything at all. */
  reported: boolean;
}

/** Reads one student's semester update costs: the record, and that one term. */
export const REQUESTS_PER_SEMESTER_READ = 2;

function holeRateFor(year: number): number {
  return year <= 2014 ? MEASURED_HOLE_RATE.before2015 : MEASURED_HOLE_RATE.from2015;
}

/**
 * Reads a serial costs on a first pass: nine for a student, one for a hole.
 *
 * A student's first pass reads the record and all eight semesters; a serial that
 * answers for nobody costs the record probe and nothing else. Both are derived
 * from the measured hole rate for the batch year rather than assumed.
 */
function firstPassReads(year: number, serials: number): number {
  const hole = holeRateFor(year);
  return serials * ((1 - hole) * REQUESTS_PER_STUDENT + hole);
}

/**
 * Reads re-reading one semester costs across a block's students: two each.
 *
 * This is the number that makes maintenance affordable, and it is the reason a
 * completed block is worth revisiting at all: keeping 8,974 students of one batch
 * year current costs about 18,000 reads, where re-running that year would cost
 * 80,000 and duplicate every row it touched.
 */
function semesterReads(year: number, serials: number): number {
  const hole = holeRateFor(year);
  return serials * ((1 - hole) * REQUESTS_PER_SEMESTER_READ + hole);
}

/**
 * Read the census's own counters, live row first.
 *
 * The broadcast row is written in the same transaction that stores a batch, so
 * it is fresher than the last aggregate read and is preferred wherever the two
 * overlap. `doneRanges` only exists on the aggregate, so it cannot come from the
 * broadcast.
 *
 * `readsSpent` reproduces the runner's own accounting — one details probe per
 * number plus one read per stored semester row — and matches the request count
 * the last recorded GitHub Actions slice reported (1,184 requests: 136 probes
 * and 1,048 semester rows), which is why it is presented as arithmetic rather
 * than as a model.
 *
 * What is left comes from the ledger when the database has one. That matters more
 * than it sounds: the census is not a job with an end date. BPUT publishes on a
 * rolling window, so a batch year that answered for six semesters will answer for
 * seven, and the block that reads it will need reading again for that one term.
 * A figure of "1.4M of 1.5M" computed from a frozen total cannot express that —
 * it can only count down to zero and then be wrong forever. So the left side is
 * derived from the serials no block has read yet plus the semesters the portal
 * now serves that no block has captured, and the denominator is spent plus
 * outstanding, which is why it can go up on the day BPUT publishes something.
 */
export function censusAcquisition(
  census: CensusPayload | undefined,
  live: CensusLiveCounters | null,
  plan?: CensusPlan | null,
): CensusAcquisition {
  const progress = census?.progress;
  const observations = live?.observations ?? progress?.observations ?? 0;
  const visited = live?.visited ?? progress?.visited ?? 0;
  const notFound = live?.not_found ?? progress?.notFound ?? 0;
  const ranges = live?.ranges ?? progress?.ranges ?? 0;
  const doneRanges = progress?.doneRanges ?? 0;
  const found = Math.max(0, visited - notFound);
  const readsSpent = visited + observations;
  const potential = found * 8;
  const measuredBasis = estimatedRequests();

  /*
   * With the ledger, "how much is left" is a measurement of the work rather than
   * a frozen total minus a live spend: the first pass is charged at nine reads a
   * student and one a hole over the serials no block has read, and maintenance at
   * two reads a student over the serials each outstanding semester covers. The
   * miss tail is charged per unfinished block because a walk always pays it.
   *
   * Without the ledger — a deployment a migration behind — the panel falls back to
   * the measurement basis and says so, rather than silently showing a number that
   * cannot notice a new publication.
   */
  let firstPassReadsLeft = 0;
  let maintenanceReads = 0;
  let blocksRemaining = 0;
  if (plan) {
    for (const row of plan.years) {
      blocksRemaining += Math.max(row.blocks - row.firstPassDone, 0);
      firstPassReadsLeft += firstPassReads(row.year, Math.max(row.serialsLeft, 0));
      maintenanceReads += semesterReads(row.year, Math.max(row.passSerialsPending, 0));
    }
    firstPassReadsLeft += blocksRemaining * SKIP_AFTER_MISSES;
  }

  const ledger = Boolean(plan);
  const readsLeft = ledger
    ? firstPassReadsLeft + maintenanceReads
    : Math.max(0, measuredBasis - readsSpent);

  return {
    observations,
    visited,
    notFound,
    found,
    ranges,
    doneRanges,
    yieldPerProbe: visited > 0 ? observations / visited : 0,
    historyDepth: potential > 0 ? Math.min(1, observations / potential) : 0,
    probeCoverage: MEASURED_SERIALS > 0 ? visited / MEASURED_SERIALS : 0,
    rangeCoverage: MEASURED_BLOCKS > 0 ? doneRanges / MEASURED_BLOCKS : 0,
    remainingNumbers: Math.max(0, MEASURED_SERIALS - visited),
    readsSpent,
    firstPassReadsLeft: ledger ? firstPassReadsLeft : readsLeft,
    maintenanceReads: ledger ? maintenanceReads : 0,
    serialsLeft: plan?.serialsRemaining ?? 0,
    blocksDone: plan?.blocksDone ?? 0,
    passesPending: plan?.passesPending ?? 0,
    watchCheckedAt: plan?.watchCheckedAt ?? null,
    ledger,
    readsLeft: Math.max(0, Math.round(readsLeft)),
    budget: Math.max(0, Math.round(readsSpent + readsLeft)),
    measuredBasis,
    active: progress?.active ?? live?.active ?? false,
    lastBatchAt: live?.last_batch_at ?? progress?.lastBatchAt ?? null,
    reported: observations > 0 || visited > 0,
  };
}
