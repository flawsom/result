// The census grid, which registration numbers exist, measured rather than guessed.
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
//     hit and 079+ miss, across five branches (16, 48, 18, 17, 7) interleaved,
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
//     years 08–11. Years 26–27 carry no numbers yet, which the daily discovery
//     sweep re-checks rather than assumes.
//
// The college lists below are a measured snapshot: for each batch year, every
// code in 000–599 was probed at serial 001 (the first student a college admits,
// so a code that hits is a college with a batch in that year). Colleges do open
// and close, 2012 has codes 105, 202, 227, 313, 325, 367 that no recent year
// has, and 2025 adds 440–450, which is exactly why each year carries its own
// list rather than one shared union.
//
// Total: 1103 college-year blocks holding 160,609 registration numbers and about
// 158,571 students, both measured rather than extrapolated, both in
// `MEASURED_INTAKE` below, which the daily job regenerates.
//
// The lists in this file are the *declared* grid: a reviewed baseline. They are
// not the whole grid, because a batch year that opens and a college that starts a
// batch do not announce themselves, `scripts/census-intake.mjs --discover` sweeps
// code space for the year the portal has just begun numbering, re-sweeps two
// declared years a day on rotation, and appends the codes whose first student
// answers to `census-discovered.ts`. `CENSUS_YEARS` and `CENSUS_COLLEGES` below
// are that union, so the walk, the measurement and the dashboard all grow on their
// own. Reviewed removal is still `bun scripts/census-manifest.mjs`, and the
// population is still `bun scripts/census-intake.mjs`; the evidence is
// `docs/census-intake.json`.
//
// What this file does NOT contain: any registration number. A block is a range
// and a count, and a range plus the serial rule is the whole population.

import { CENSUS_DISCOVERED } from "./census-discovered";

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

/**
 * The declared grid: what the API served when the lists below were last reviewed
 * by hand. 12 = 2012 is the first; 25 = 2025 the last *declared* year,
 * `CENSUS_YEARS` further down is this list plus whatever discovery has found.
 */
const DECLARED_YEARS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] as const;

/** College codes with a B.Tech batch in each declared year, measured 2026-09-29. */
const DECLARED_COLLEGES: Record<number, readonly number[]> = {
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

/**
 * The grid the app and the crawl both walk: the declared lists above, plus every
 * block discovery has appended since (`census-discovered.ts`).
 *
 * This union is the only definition of "what exists", the walk, the measurement
 * and the dashboard all read it, so a batch year that opens becomes work without
 * anyone editing a constant.
 */
export const CENSUS_YEARS: readonly number[] = [
  ...new Set([...DECLARED_YEARS, ...Object.keys(CENSUS_DISCOVERED).map(Number)]),
].sort((a, b) => a - b);

/** College codes per batch year, declared plus discovered, ascending. */
export const CENSUS_COLLEGES: Record<number, readonly number[]> = (() => {
  const merged: Record<number, readonly number[]> = {};
  for (const year of CENSUS_YEARS) {
    merged[year] = [
      ...new Set([...(DECLARED_COLLEGES[year] ?? []), ...(CENSUS_DISCOVERED[year] ?? [])]),
    ].sort((a, b) => a - b);
  }
  return merged;
})();

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
  /** Sum of the highest live serial in each block, an upper bound on students. */
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
 * Every block in the grid was probed for its highest live serial on 2026-09-29,
 * a binary search for the first miss boundary with gap arbitration above it,
 * about 17 requests per block. That retires the 15-block sample this
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
  2025: { blocks: 80, serials: 12_645, mean: 158.1, median: 90, max: 714 },
};

/** The day the block-by-block measurement was taken. */
export const MEASURED_AT = "2026-09-29";

/**
 * The last day every reading above was re-checked against the portal.
 *
 * `scripts/census-intake.mjs --refresh` re-probes each block's recorded bound
 * (two requests) and re-measures only the blocks where the portal has moved, then
 * `--write-constants` stamps this date. A daily scheduled job runs both, so this
 * date is a fact about the published numbers rather than a claim about them, and
 * a reading that quietly went stale would show up here as a stale date.
 */
export const MEASURED_CHECKED_AT = "2026-10-10";

/**
 * The highest live serial in every block, the raw measurement behind
 * `MEASURED_INTAKE`, one value per block in `censusBlocks()` order (batch year
 * ascending, then college code ascending).
 *
 * 1,103 values summing to `MEASURED_SERIALS`. It was zipped out of
 * `docs/census-intake.json` in this exact order; `measuredBlocks()` re-checks
 * the length at runtime, and `bun scripts/census-status.mjs` re-zips the whole
 * evidence file against this array and exits non-zero if the two ever drift.
 * It is embedded rather than fetched so the distribution of college intake is a
 * computation over the measurement instead of a 140 KB download.
 */
// prettier-ignore
// One line per 16 blocks: reflowing this to the print width would bury the data.
export const MEASURED_BLOCK_SERIALS: readonly number[] = [
  183, 273, 344, 112, 224, 229, 273, 734, 116, 208, 282, 8, 162, 492, 998, 648,
  488, 307, 258, 45, 530, 70, 540, 209, 252, 811, 7, 475, 27, 207, 606, 391,
  548, 89, 583, 98, 401, 481, 580, 337, 200, 344, 106, 224, 178, 116, 73, 52,
  30, 104, 178, 48, 150, 60, 94, 50, 179, 67, 69, 8, 119, 14, 56, 98,
  86, 114, 34, 123, 19, 42, 124, 276, 128, 6, 149, 394, 51, 42, 27, 72,
  74, 204, 175, 448, 602, 86, 206, 201, 163, 818, 73, 138, 221, 4, 69, 959,
  570, 216, 139, 193, 39, 36, 445, 39, 28, 268, 137, 221, 869, 53, 320, 317,
  17, 48, 684, 184, 534, 42, 757, 104, 293, 352, 560, 132, 59, 249, 117, 136,
  62, 57, 27, 19, 81, 16, 133, 36, 57, 36, 32, 136, 31, 5, 503, 40,
  118, 84, 52, 137, 7, 114, 30, 17, 130, 15, 140, 56, 148, 237, 21, 13,
  10, 19, 163, 35, 124, 169, 624, 623, 93, 534, 198, 147, 679, 94, 149, 185,
  9, 43, 460, 581, 274, 138, 60, 85, 25, 21, 34, 13, 105, 72, 268, 64,
  259, 179, 13, 37, 398, 116, 260, 22, 417, 110, 325, 368, 368, 71, 88, 177,
  41, 13, 146, 23, 216, 81, 142, 24, 14, 95, 8, 214, 54, 61, 32, 176,
  23, 227, 15, 319, 95, 95, 94, 104, 46, 7, 91, 7, 15, 14, 50, 37,
  20, 20, 136, 12, 153, 50, 26, 35, 24, 126, 32, 106, 334, 572, 604, 85,
  573, 265, 215, 796, 84, 76, 163, 10, 48, 514, 782, 346, 236, 137, 115, 29,
  6, 228, 31, 4, 203, 56, 243, 45, 197, 195, 19, 34, 543, 144, 525, 8,
  416, 251, 330, 383, 282, 26, 221, 124, 119, 7, 101, 210, 199, 55, 247, 30,
  2, 5, 234, 65, 57, 70, 231, 20, 280, 167, 295, 117, 2, 199, 65, 103,
  167, 74, 6, 121, 14, 61, 34, 14, 76, 79, 44, 69, 151, 19, 201, 131,
  23, 28, 31, 129, 24, 92, 354, 571, 672, 72, 564, 237, 141, 929, 80, 51,
  92, 3, 49, 544, 797, 355, 183, 84, 111, 19, 174, 38, 65, 96, 267, 55,
  203, 195, 8, 156, 517, 104, 538, 5, 446, 320, 310, 297, 553, 66, 45, 76,
  207, 6, 140, 202, 135, 25, 152, 37, 1, 71, 57, 39, 54, 170, 12, 284,
  131, 298, 114, 229, 116, 160, 108, 86, 18, 95, 60, 22, 28, 77, 98, 62,
  27, 163, 12, 213, 99, 36, 29, 51, 85, 82, 57, 291, 58, 456, 203, 119,
  543, 82, 33, 198, 3, 33, 525, 196, 218, 50, 47, 34, 1, 207, 16, 23,
  137, 193, 20, 180, 102, 3, 136, 399, 65, 501, 3, 193, 343, 245, 235, 371,
  79, 43, 110, 154, 1, 169, 197, 146, 29, 152, 2, 64, 91, 36, 50, 202,
  13, 231, 78, 184, 137, 256, 64, 181, 71, 33, 17, 74, 21, 28, 15, 43,
  100, 56, 9, 107, 15, 233, 103, 5, 32, 76, 45, 34, 292, 49, 136, 144,
  73, 34, 218, 9, 99, 96, 80, 64, 39, 175, 25, 11, 35, 81, 186, 42,
  96, 5, 126, 317, 43, 368, 43, 194, 250, 280, 358, 431, 100, 67, 100, 142,
  1, 116, 232, 111, 22, 105, 14, 4, 63, 127, 40, 242, 47, 229, 54, 155,
  58, 15, 156, 190, 94, 25, 122, 27, 40, 33, 19, 29, 69, 31, 20, 82,
  14, 167, 156, 78, 47, 68, 106, 98, 94, 304, 444, 158, 116, 65, 51, 259,
  62, 3, 18, 181, 10, 35, 155, 66, 187, 77, 178, 28, 125, 243, 502, 34,
  405, 1, 203, 215, 238, 281, 373, 120, 92, 127, 43, 100, 238, 24, 93, 12,
  7, 36, 132, 241, 41, 21, 240, 35, 260, 66, 182, 33, 19, 107, 8, 130,
  37, 57, 24, 46, 23, 22, 17, 44, 45, 13, 10, 108, 7, 128, 135, 105,
  4, 51, 143, 63, 187, 335, 532, 149, 66, 147, 73, 31, 182, 50, 193, 34,
  89, 63, 2, 22, 43, 115, 18, 82, 2, 89, 83, 347, 21, 337, 142, 207,
  313, 356, 59, 89, 102, 102, 35, 88, 31, 75, 9, 3, 80, 251, 27, 9,
  160, 50, 177, 85, 196, 5, 78, 2, 104, 49, 38, 42, 54, 13, 18, 23,
  37, 74, 25, 24, 72, 20, 109, 76, 183, 30, 102, 71, 40, 191, 294, 458,
  124, 70, 216, 92, 61, 234, 260, 34, 22, 133, 92, 3, 108, 53, 152, 34,
  121, 12, 118, 139, 522, 379, 201, 261, 300, 418, 41, 93, 165, 68, 79, 204,
  29, 72, 19, 53, 238, 22, 37, 228, 59, 247, 118, 271, 4, 60, 28, 142,
  47, 20, 22, 84, 37, 34, 43, 46, 49, 12, 20, 86, 17, 143, 61, 237,
  5, 162, 55, 93, 131, 25, 266, 432, 113, 27, 109, 176, 169, 89, 212, 319,
  7, 48, 140, 119, 3, 65, 106, 227, 43, 191, 10, 26, 191, 623, 53, 474,
  236, 296, 412, 38, 158, 236, 86, 113, 225, 33, 92, 28, 27, 71, 159, 44,
  28, 297, 41, 351, 149, 464, 4, 139, 31, 157, 57, 72, 13, 137, 43, 38,
  36, 61, 110, 2, 13, 123, 13, 288, 72, 153, 7, 105, 108, 93, 122, 387,
  518, 134, 63, 150, 154, 234, 89, 276, 274, 26, 79, 60, 54, 122, 229, 29,
  189, 8, 80, 129, 590, 44, 264, 355, 364, 59, 102, 223, 32, 103, 217, 42,
  76, 31, 77, 154, 53, 20, 35, 330, 39, 327, 179, 398, 1, 132, 160, 43,
  40, 94, 57, 37, 11, 82, 55, 6, 9, 77, 23, 281, 38, 44, 3, 105,
  37, 41, 53, 34, 35, 78, 407, 631, 212, 62, 182, 142, 330, 96, 308, 261,
  35, 69, 84, 82, 40, 114, 314, 49, 231, 9, 47, 131, 450, 37, 370, 330,
  686, 39, 38, 324, 52, 135, 352, 34, 139, 20, 56, 143, 77, 32, 26, 391,
  19, 544, 221, 409, 5, 126, 154, 67, 74, 118, 44, 39, 57, 75, 75, 7,
  21, 120, 10, 346, 53, 76, 8, 122, 83, 64, 86, 132, 101, 44, 7, 433,
  709, 247, 71, 188, 201, 375, 66, 290, 87, 66, 108, 89, 55, 191, 298, 82,
  272, 7, 43, 80, 392, 25, 410, 451, 714, 123, 90, 260, 159, 213, 405, 46,
  167, 75, 3, 190, 117, 37, 25, 307, 36, 618, 442, 332, 21, 243, 203, 47,
  58, 123, 65, 52, 75, 64, 110, 15, 8, 147, 21, 344, 35, 128, 15, 84,
  91, 44, 84, 65, 231, 134, 108, 41, 5, 36, 24, 171, 53, 30, 75,
];

/** One block joined back to its measurement. */
export interface MeasuredBlock {
  /** Admission year, e.g. 2012. */
  year: number;
  /** College code. */
  code: number;
  /** Log label, e.g. `2012 · college 210`. */
  label: string;
  /** Highest serial the portal answered for on `MEASURED_AT`. */
  serial: number;
}

/**
 * The measurement, block by block, in grid order.
 *
 * `MEASURED_BLOCK_SERIALS` is positional, so this is the only place the two
 * arrays are stitched together, every distribution, quantile and concentration
 * figure in the dashboard is computed from this join rather than from a
 * pre-aggregated copy, which keeps one definition of "the measurement".
 */
export function measuredBlocks(): MeasuredBlock[] {
  const blocks = censusBlocks();
  if (MEASURED_BLOCK_SERIALS.length !== blocks.length) {
    console.warn(
      `[census] ${MEASURED_BLOCK_SERIALS.length} measured blocks against ${blocks.length} in the grid, run scripts/census-intake.mjs`,
    );
  }
  return blocks.map((block, i) => ({
    year: block.year,
    code: block.code,
    label: block.label,
    serial: MEASURED_BLOCK_SERIALS[i] ?? 0,
  }));
}

/**
 * Holes: serials below a block's maximum that answer for nobody, a dropout, a
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

/** Blocks the measurement covers, the denominator of crawl progress. */
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
