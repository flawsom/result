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
//   • The serial does not reach 999. Measured maxima run 034 (21/337) to 433
//     (25/104), median ~132. Ranges here therefore end at 999 and the walk skips
//     ahead after `SKIP_AFTER_MISSES` consecutive misses, which costs the same as
//     a measured bound and cannot truncate a college that grew.
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
// Total: 1103 college-year blocks. Refresh with `bun scripts/census-manifest.mjs`.
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

/** Highest serial the portal allocates. Measured maximum is 433. */
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
