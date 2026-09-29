// The census grid — which registration numbers exist, measured rather than guessed.
//
// How BPUT numbers are laid out (derived from the portal, not from documentation,
// because BPUT publishes none):
//
//     YY  01  CCC  SSS
//     │   │   │    └── serial within the college's intake, dense from 001
//     │   │   └─────── college code, returned verbatim as `collegeCode`
//     │   └─────────── always 01 for every B.Tech record observed
//     └─────────────── admission year (12 = 2012 … 25 = 2025)
//
// Evidence for each claim, all from `student-detsils-results`:
//
//   • The three digits in the middle are the college code. `2301429052` returns
//     `collegeCode: "429"` (NIIS, Bhubaneswar); `2301329052` returns `"329"`
//     (KMBB, Khurda). Digits 5–7 of the number are that field exactly.
//   • The serial is dense from 001. College 429, batch 2023: serials 001–078 all
//     hit and 079+ miss, across five branches (16, 48, 18, 17, 7) interleaved —
//     so the serial indexes the college's intake, not a branch block. College 329,
//     same batch: 001–070 with three single-number gaps (12, 18, 32).
//   • The serial does not reach 999, but it gets much closer than a small sample
//     suggested: every block was measured on 2026-09-29 and the maxima run 0 to
//     998 (2012 · college 210), median 97, mean 146. Ranges here therefore end
//     at 999 and the walk skips ahead after `SKIP_AFTER_MISSES` consecutive
//     misses, which costs the same as a measured bound and cannot truncate a
//     college that grew.
//   • `01` is not a course code we could vary: every other value in that slot
//     (02…20) misses at a college that definitely has students, and every record
//     we have ever seen reports `courseName: "B.Tech"`.
//   • Codes 600–999 are empty (full sweeps for batches 2023 and 2025), as are
//     years 08–11 and 26–27.
//
// The college lists below are a measured snapshot: for each batch year, every
// code in 000–599 was probed at serial 001 (the first student a college admits,
// so a code that hits is a college with a batch in that year). Colleges do open
// and close — 2012 has codes 105, 202, 227, 313, 325, 367 that no recent year
// has, and 2025 adds 440–450 — which is exactly why each year carries its own
// list rather than one shared union.
//
// Total: 1103 college-year blocks holding 160,609 registration numbers and about
// 158,571 students — both measured rather than extrapolated, both in
// `MEASURED_INTAKE` below. Refresh the college lists with
// `bun scripts/census-manifest.mjs` and the population with
// `bun scripts/census-intake.mjs`; the full evidence is `docs/census-intake.json`.
//
// What this file does NOT contain: any registration number. A block is a range
// and a count, and a range plus the serial rule is the whole population.

/** One crawlable block: a contiguous run of registration numbers. */
export interface CensusBlock {
  /** Range start, inclusive. */
  start: string;
  /** Range end, inclusive. */
  end: string;
  /** Human label for logs, e.g. `2023 · college 429`. */
  label: string;
  /** Admission year, as the two leading digits carry it. */
  year: number;
  /** College code, as the three middle digits carry it. */
  code: number;
  /** Serial span: `1` to `999`. Declared, not the measured intake. */
  serials: number;
}

/** Highest serial the portal allocates. Measured maximum is 998 (2012 · college 210). */
export const SERIAL_MAX = 999;

/**
 * Consecutive missed serials before a block is treated as finished. Costs one
 * extra probe per miss per block; guards against single-number gaps, which are
 * real (college 329, batch 2023, is missing serials 12, 18 and 32 mid-run).
 */
export const SKIP_AFTER_MISSES = 25;

/** Batch years the API serves. 12 = 2012 is the first; 25 = 2025 the last. */
export const CENSUS_YEARS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] as const;

/** College codes with a B.Tech batch in each year, measured 2026-09-29. */
export const CENSUS_COLLEGES: Record<number, readonly number[]> = {
  12: [
    104, 105, 106, 108, 109, 110, 201, 202, 204, 205, 206, 207, 208, 209, 210, 211, 214, 215, 216,
    217, 219, 220, 223, 224, 225, 227, 228, 230, 231, 259, 287, 288, 289, 291, 292, 293, 294, 297,
    298, 299, 300, 301, 302, 304, 305, 306, 309, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320,
    321, 324, 325, 327, 328, 329, 331, 332, 333, 334, 335, 336, 337, 338, 341, 342, 344, 346, 348,
    360, 362, 364, 367, 370, 374,
  ],
  13: [
    104, 105, 106, 108, 109, 110, 201, 202, 204, 205, 206, 207, 208, 210, 211, 214, 215, 216, 217,
    218, 219, 220, 221, 223, 224, 225, 227, 228, 229, 230, 231, 259, 287, 288, 289, 291, 292, 293,
    294, 297, 298, 299, 300, 301, 304, 305, 306, 309, 311, 312, 314, 315, 316, 317, 318, 319, 321,
    322, 324, 325, 326, 327, 329, 331, 332, 333, 334, 335, 336, 337, 338, 339, 341, 342, 346, 348,
    360, 362, 364, 365, 367, 370, 374,
  ],
  14: [
    104, 105, 106, 108, 109, 110, 201, 202, 204, 205, 206, 207, 208, 209, 210, 211, 214, 215, 216,
    217, 218, 220, 221, 223, 224, 225, 228, 229, 230, 231, 259, 287, 288, 289, 291, 292, 293, 294,
    297, 298, 299, 300, 301, 302, 303, 305, 306, 308, 309, 310, 311, 312, 314, 315, 316, 317, 318,
    319, 320, 321, 322, 324, 326, 327, 329, 330, 331, 332, 334, 335, 336, 337, 339, 341, 342, 343,
    344, 346, 347, 348, 360, 362, 364, 365, 367, 370, 374,
  ],
  15: [
    104, 105, 106, 108, 109, 110, 201, 202, 204, 205, 206, 207, 208, 209, 210, 211, 214, 215, 216,
    217, 218, 219, 220, 221, 223, 224, 225, 228, 229, 230, 231, 259, 287, 288, 289, 291, 292, 293,
    294, 297, 298, 299, 300, 301, 302, 303, 304, 305, 308, 309, 310, 311, 312, 315, 316, 317, 318,
    319, 320, 321, 322, 324, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 338, 339,
    341, 342, 343, 344, 346, 347, 348, 360, 362, 364, 365, 367, 370, 374,
  ],
  16: [
    104, 105, 106, 108, 109, 110, 201, 202, 204, 205, 206, 207, 208, 209, 210, 211, 214, 215, 216,
    217, 219, 220, 223, 224, 225, 228, 229, 230, 231, 259, 287, 288, 289, 291, 292, 293, 294, 297,
    298, 299, 300, 301, 302, 303, 304, 305, 308, 309, 310, 311, 312, 316, 317, 318, 319, 320, 321,
    322, 324, 326, 327, 329, 330, 331, 332, 333, 334, 335, 336, 337, 339, 341, 342, 343, 344, 346,
    347, 348, 360, 362, 364, 365, 367, 370, 374,
  ],
  17: [
    104, 108, 109, 110, 201, 202, 204, 205, 206, 207, 208, 209, 211, 214, 215, 216, 217, 218, 219,
    220, 221, 224, 225, 228, 229, 230, 231, 259, 287, 288, 289, 291, 292, 293, 294, 297, 298, 299,
    300, 301, 302, 303, 304, 305, 308, 309, 310, 312, 316, 317, 318, 319, 320, 321, 322, 324, 326,
    327, 329, 330, 331, 332, 333, 334, 335, 336, 337, 339, 341, 342, 343, 344, 346, 347, 348, 360,
    364, 365, 367, 370, 374,
  ],
  18: [
    104, 108, 110, 201, 204, 205, 206, 208, 211, 214, 215, 216, 217, 219, 220, 221, 223, 224, 225,
    228, 230, 231, 259, 287, 288, 289, 291, 292, 293, 294, 297, 298, 299, 300, 301, 302, 303, 304,
    305, 308, 309, 310, 311, 315, 316, 317, 318, 320, 321, 322, 324, 326, 327, 328, 329, 331, 332,
    333, 334, 335, 336, 337, 339, 341, 342, 343, 344, 346, 347, 348, 360, 362, 364, 365, 367, 370,
    374,
  ],
  19: [
    104, 109, 110, 201, 204, 205, 206, 207, 208, 211, 214, 215, 217, 219, 220, 223, 224, 225, 228,
    230, 259, 287, 288, 289, 291, 292, 293, 294, 297, 298, 299, 300, 301, 302, 304, 305, 309, 310,
    311, 312, 315, 316, 317, 318, 319, 320, 321, 322, 324, 326, 327, 328, 329, 330, 331, 332, 333,
    334, 335, 336, 337, 339, 341, 342, 343, 344, 346, 347, 348, 360, 362, 364, 365, 367, 370, 374,
  ],
  20: [
    104, 109, 110, 112, 201, 204, 205, 206, 207, 214, 217, 219, 220, 221, 223, 224, 225, 228, 230,
    231, 259, 288, 289, 291, 292, 293, 294, 297, 298, 299, 300, 301, 302, 304, 305, 309, 310, 311,
    312, 316, 317, 318, 319, 320, 321, 322, 324, 326, 328, 329, 330, 331, 332, 333, 334, 335, 336,
    337, 339, 341, 342, 343, 344, 346, 347, 348, 360, 362, 364, 365, 367, 370, 374,
  ],
  21: [
    104, 109, 110, 112, 201, 204, 205, 206, 214, 215, 217, 219, 220, 221, 223, 224, 225, 228, 230,
    231, 259, 288, 289, 292, 293, 294, 297, 298, 299, 300, 301, 302, 304, 305, 309, 310, 311, 316,
    317, 318, 319, 320, 321, 322, 324, 326, 328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 339,
    341, 342, 343, 344, 346, 347, 348, 360, 362, 364, 365, 367, 370, 374, 413,
  ],
  22: [
    104, 109, 110, 112, 114, 201, 204, 205, 206, 214, 215, 217, 219, 220, 221, 223, 224, 225, 228,
    230, 231, 259, 288, 289, 291, 292, 293, 294, 297, 299, 300, 301, 302, 304, 305, 309, 310, 311,
    315, 316, 317, 318, 319, 320, 321, 322, 324, 326, 328, 329, 330, 331, 332, 333, 334, 335, 336,
    337, 339, 341, 342, 343, 344, 346, 347, 348, 360, 362, 364, 365, 367, 370, 374,
  ],
  23: [
    104, 109, 110, 112, 114, 201, 204, 205, 206, 214, 217, 219, 220, 223, 224, 225, 228, 230, 231,
    259, 288, 289, 291, 293, 294, 297, 299, 300, 301, 302, 304, 305, 309, 310, 311, 315, 316, 317,
    318, 319, 320, 321, 322, 324, 326, 328, 329, 331, 332, 333, 335, 336, 337, 339, 341, 342, 343,
    344, 346, 347, 348, 360, 362, 364, 365, 370, 374, 424, 427, 428, 429,
  ],
  24: [
    104, 109, 110, 112, 114, 201, 204, 205, 206, 214, 215, 217, 219, 220, 223, 224, 225, 228, 230,
    231, 259, 288, 289, 291, 293, 294, 297, 299, 300, 301, 302, 304, 305, 309, 310, 311, 315, 316,
    317, 318, 319, 320, 321, 322, 324, 326, 328, 329, 331, 332, 333, 335, 336, 337, 339, 341, 342,
    343, 344, 346, 347, 348, 360, 362, 364, 365, 370, 374, 424, 429, 431, 435, 437,
  ],
  25: [
    104, 109, 110, 112, 114, 201, 204, 205, 214, 215, 217, 219, 220, 223, 224, 225, 228, 230, 231,
    259, 288, 289, 291, 293, 294, 297, 299, 300, 301, 302, 304, 305, 309, 310, 311, 315, 316, 317,
    318, 319, 320, 321, 322, 324, 326, 328, 329, 331, 332, 333, 335, 336, 337, 339, 341, 342, 343,
    344, 346, 347, 348, 360, 362, 364, 365, 370, 374, 424, 427, 429, 431, 435, 440, 442, 443, 446,
    447, 448, 449, 450,
  ],
};

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The full crawl grid, in a stable order (oldest batch first, then by college
 * code). Every block is `YY01CCC001`–`YY01CCC999`; the walk skips to the next
 * block after `SKIP_AFTER_MISSES` consecutive misses, so an oversized bound
 * costs a few probes rather than a truncation.
 */
export function censusBlocks(): CensusBlock[] {
  const out: CensusBlock[] = [];
  for (const year of CENSUS_YEARS) {
    const colleges = CENSUS_COLLEGES[year] ?? [];
    for (const code of colleges) {
      const prefix = `${pad(year, 2)}01${pad(code, 3)}`;
      out.push({
        start: `${prefix}001`,
        end: `${prefix}${pad(SERIAL_MAX, 3)}`,
        label: `20${pad(year, 2)} · college ${pad(code, 3)}`,
        year: 2000 + year,
        code,
        serials: SERIAL_MAX,
      });
    }
  }
  return out;
}

/** Blocks covering one batch year. */
export function blocksForYear(year: number): CensusBlock[] {
  return censusBlocks().filter((block) => block.year === year);
}

/** Total declared numbers across the grid: blocks × their serial span. */
export function gridSize(blocks: CensusBlock[] = censusBlocks()): number {
  return blocks.reduce((sum, block) => sum + (Number(block.end) - Number(block.start) + 1), 0);
}

/** What one batch year's blocks were measured to hold. */
export interface MeasuredIntake {
  /** Blocks measured for this year. */
  blocks: number;
  /** Sum of the highest live serial in each block — an upper bound on students. */
  serials: number;
  /** Mean serials per block. */
  mean: number;
  /** Median block. */
  median: number;
  /** Busiest single college that year. */
  max: number;
}

/**
 * Measured intake per batch year, not sampled.
 *
 * Every one of the 1,103 blocks was probed for its highest live serial on
 * 2026-09-29 — a binary search for the first miss boundary with gap arbitration
 * above it, about 17 requests per block. That retires the 15-block sample this
 * file used to carry, which said a block averages 145 students (the truth is
 * 146) and that the serial never passes 433 (2012 · college 210 passes 998).
 *
 * Method, per-block results and the audits are in `docs/census-intake.json`;
 * reproduce with `bun scripts/census-intake.mjs`.
 */
export const MEASURED_INTAKE: Record<number, MeasuredIntake> = {
  2012: { blocks: 82, serials: 18_208, mean: 222, median: 150, max: 998 },
  2013: { blocks: 83, serials: 15_262, mean: 183.9, median: 118, max: 959 },
  2014: { blocks: 87, serials: 12_274, mean: 141.1, median: 93, max: 679 },
  2015: { blocks: 90, serials: 14_966, mean: 166.3, median: 117, max: 796 },
  2016: { blocks: 85, serials: 14_590, mean: 171.6, median: 98, max: 929 },
  2017: { blocks: 81, serials: 10_248, mean: 126.5, median: 79, max: 543 },
  2018: { blocks: 77, serials: 8_208, mean: 106.6, median: 81, max: 431 },
  2019: { blocks: 76, serials: 8_693, mean: 114.4, median: 77, max: 502 },
  2020: { blocks: 73, serials: 7_231, mean: 99.1, median: 73, max: 532 },
  2021: { blocks: 72, serials: 8_617, mean: 119.7, median: 84, max: 522 },
  2022: { blocks: 73, serials: 9_819, mean: 134.5, median: 106, max: 623 },
  2023: { blocks: 71, serials: 8_974, mean: 126.4, median: 77, max: 590 },
  2024: { blocks: 73, serials: 10_874, mean: 149, median: 83, max: 686 },
  2025: { blocks: 80, serials: 12_645, mean: 158.1, median: 91, max: 714 },
};

/**
 * Holes: serials below a block's maximum that answer for nobody — a dropout, a
 * transfer, a withdrawn record. They are why the grid holds fewer students than
 * it declares serials.
 *
 * Measured by walking 22 audited blocks serial by serial (`audits` in
 * `docs/census-intake.json`): 3.4% of the serials below the maximum are missing
 * in the 2012–2014 batches, 0.4% in 2015–2025. The rate is split by era because
 * the holes are: nearly every one of them sat in a batch that has had a decade
 * to change. Applied to the measurement above, the grid holds about 158,571
 * students and not the 160,609 serials it declares.
 */
export const MEASURED_HOLE_RATE = { before2015: 0.034, from2015: 0.0042 } as const;

/** Serials the grid declares, summed over the measurement: an upper bound. */
export const MEASURED_SERIALS = 160_609;

/** Students per block in one batch year, holes removed. */
export function measuredMean(year: number): number {
  const intake = MEASURED_INTAKE[year];
  if (!intake) return 0;
  const rate = year <= 2014 ? MEASURED_HOLE_RATE.before2015 : MEASURED_HOLE_RATE.from2015;
  return intake.mean * (1 - rate);
}

/** Measured students in one batch year, holes removed. */
export function measuredStudents(year: number): number {
  const intake = MEASURED_INTAKE[year];
  if (!intake) return 0;
  const rate = year <= 2014 ? MEASURED_HOLE_RATE.before2015 : MEASURED_HOLE_RATE.from2015;
  return intake.serials * (1 - rate);
}

/** Students the whole grid holds, measured, holes removed. */
export const MEASURED_STUDENTS = Math.round(
  Object.keys(MEASURED_INTAKE).reduce((sum, year) => sum + measuredStudents(Number(year)), 0),
);

/** Blocks the measurement covers — the denominator of crawl progress. */
export const MEASURED_BLOCKS = Object.values(MEASURED_INTAKE).reduce(
  (sum, intake) => sum + intake.blocks,
  0,
);

/** Upstream reads a single student costs: one record plus eight semesters. */
export const REQUESTS_PER_STUDENT = 9;

/**
 * Estimated upstream requests to complete the grid, from the measurement rather
 * than a guess. Used only to report progress and an ETA; nothing about
 * correctness depends on it. The per-block `skipMisses` tail is included because
 * an empty or finished block still costs its probes.
 */
export function estimatedRequests(
  blocks: CensusBlock[] = censusBlocks(),
  skipMisses: number = SKIP_AFTER_MISSES,
): number {
  const fallback = MEASURED_STUDENTS / censusBlocks().length;
  let total = 0;
  for (const block of blocks) {
    const perBlock = measuredMean(block.year) || fallback;
    total += perBlock * REQUESTS_PER_STUDENT + skipMisses;
  }
  return Math.round(total);
}
