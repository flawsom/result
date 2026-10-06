// Which semester sessions the portal answered for, per batch year.
//
// GENERATED FILE: written by `bun scripts/census-sessions.mjs`, which the daily
// refresh workflow runs. Do not edit by hand; edit the script.
//
// One registration number per batch year is asked for each of the eight sessions
// the app derives from that batch, and the semester numbers the portal served are
// listed below. The number itself is never stored, here or in the evidence file.
//
// This exists because a crawl that reads each serial once cannot see a semester
// declared after it was read. A semester missing from a year's list is one the
// portal did not serve on the date below, which for the early batches is the
// portal's retention window rather than a missing result.
export const SESSION_WATCH_CHECKED_AT = "2026-10-06";

export const SESSION_WATCH: Record<number, readonly number[]> = {
  2012: [7, 8],
  2013: [5, 6, 7, 8],
  2014: [3, 4, 5, 6, 7, 8],
  2015: [1, 2, 3, 4, 5, 6, 7, 8],
  2016: [1, 2, 3, 4, 5, 6, 7, 8],
  2017: [1, 2, 3, 4, 5, 6, 7, 8],
  2018: [1, 2, 3, 4, 5, 6, 7, 8],
  2019: [1, 2, 3, 4, 5, 6, 7, 8],
  2020: [1, 2, 3, 4, 5, 6, 7, 8],
  2021: [1, 2, 3, 4, 5, 6, 7, 8],
  2022: [1, 2, 3, 4, 5, 6, 7, 8],
  2023: [1, 2, 3, 4, 5, 6],
  2024: [1, 2, 3, 4],
  2025: [1, 2],
};
