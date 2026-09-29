#!/usr/bin/env bun
// How many students does the census grid actually contain?
//
// `census-blocks.ts` declares 1,103 college-year blocks, each spanning serials
// 001–999. Declared is not measured: the grid is a promise that those numbers
// exist, and the honest way to know how many of them do is to probe them. A 15
// block sample said a block averages 145 students; that number is now retired.
//
// This walks every block and finds its last live serial, by binary search with
// gap arbitration:
//
//   1. Binary search the first miss boundary, assuming hits are dense from 001.
//   2. That assumption is wrong sometimes — serials do go missing mid-run
//      (college 329, batch 2023: 012, 018 and 032). So after converging, probe a
//      small window *above* the boundary. A hit there means the boundary was a
//      gap, not the end, and the search resumes above it. Repeat until a window
//      comes back empty, which is the measured end of the block.
//
// Cost is ~17 requests per block, against ~200 for walking every serial, so all
// 1,103 blocks is about 20 minutes of upstream reading rather than four hours.
// `--audit K` pays the full price on K sampled blocks and reports how far the
// cheap method drifts from an exact count there, including the gaps the window
// cannot see.
//
//   bun scripts/census-intake.mjs --years 12,13 --seconds 150
//   bun scripts/census-intake.mjs --audit 8
//
// `--discover` answers the other half of staying true: what does the portal have
// that the grid does not? A batch year that opens and a college that starts a
// batch are not in any list anybody edits, so the grid cannot depend on a human
// noticing. Discovery
//
//   1. scans code space at serial 001 for every batch year above the newest one in
//      the grid, up to this calendar year — the year the portal has just started
//      numbering, which is where a whole cohort appears at once;
//   2. re-sweeps two declared years a day, in rotation, so a college that opens a
//      batch in a year it never had one is found within a week;
//   3. measures every block it found, and appends it to `census-discovered.ts`,
//      which the grid imports — so the walk, the measurement and the dashboard all
//      grow without an edit.
//
//   bun scripts/census-intake.mjs --discover
//   bun scripts/census-intake.mjs --discover --code-max 119 --seconds 120
//
// Measurements accumulate in `docs/census-intake.json`. A block measured once is
// not re-probed unless `--force` is passed, so the sweep can be split across as
// many short commands as it needs. Nothing here writes to BPUT or to Supabase:
// the output is evidence, and the crawl remains the only thing allowed to
// publish a figure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { studentDetails } from "../src/lib/bput-upstream.ts";
import { RateGovernor } from "../src/lib/census-core.ts";
import {
  CENSUS_COLLEGES,
  CENSUS_YEARS,
  MEASURED_HOLE_RATE,
  SERIAL_MAX,
} from "../src/lib/census-blocks.ts";
import { CENSUS_DISCOVERED } from "../src/lib/census-discovered.ts";

/* ───────────────────────────────────────────────────────────── args ─── */

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const FILE = String(flag("file", "docs/census-intake.json"));
const SECONDS = Number(flag("seconds", 150));
const RPS = Number(flag("rps", 16));
const CONCURRENCY = Number(flag("concurrency", 20));
const WINDOW = Number(flag("window", 6));
/** Probes in flight inside one audited block. */
const AUDIT_CONCURRENCY = Number(flag("audit-concurrency", 24));
const AUDIT = Number(flag("audit", 0));
// Named blocks to full-walk, for the cases worth checking by hand — e.g. a block
// known to carry mid-run gaps, which is precisely where a binary search lies.
const AUDIT_BLOCKS = String(flag("audit-blocks", ""))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FORCE = flag("force", false) === true;
// `--refresh` re-checks every recorded reading instead of skipping it: two
// requests per block to confirm the bound still holds, and a full search only
// where the portal has moved. This is what the daily scheduled check runs.
const REFRESH = flag("refresh", false) === true;
// Rewrite the measurement constants in the module the dashboard imports. A
// measurement nobody re-runs is a dashboard that slowly stops being true.
const WRITE_CONSTANTS = flag("write-constants", false) === true;
// Ask the portal what the grid is missing and append it to the overlay the grid
// imports. Additive only: a code that stops answering is left alone, because one
// probe cannot tell a closed college from a portal hiccup.
const DISCOVER = flag("discover", false) === true;
/** Declared years re-swept per discovery run, in rotation. 0 disables rotation. */
const SWEEP_YEARS = Number(flag("sweep-years", 2));
// Codes are only ever found in 000–599 (full sweeps for batches 2023 and 2025);
// the bounds are flags so a targeted check fits inside a short budget.
const CODE_MIN = Number(flag("code-min", 0));
const CODE_MAX = Number(flag("code-max", 599));
/** Blocks measured at once once discovery has found them. */
const MEASURE_CONCURRENCY = Number(flag("measure-concurrency", 4));
const TS_FILE = "src/lib/census-blocks.ts";
const DISCOVERED_FILE = "src/lib/census-discovered.ts";
// Machine-readable outcome of this run, for the scheduled job that records it.
const REPORT = flag("report", null);
const YEAR_ARG = flag("years", null);
const ONLY = YEAR_ARG
  ? String(YEAR_ARG)
      .split(",")
      // Accepts either `20` or `2020`; only a four-digit year is stripped, so
      // `--years 20` cannot silently become year zero.
      .map((y) => {
        const n = Number(y.trim());
        return Number.isFinite(n) && n >= 2000 ? n - 2000 : n;
      })
      .filter((y) => Number.isFinite(y) && y > 0)
  : null;

const YEARS = (ONLY ?? [...CENSUS_YEARS]).filter((y) => CENSUS_COLLEGES[y]);

/* ─────────────────────────────────────────────────────────── storage ─── */

function load() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { measuredAt: null, method: "binary-search-window", window: WINDOW, blocks: {} };
  }
}

const store = load();
store.method = "binary-search-window";
store.window = WINDOW;
store.blocks ??= {};

/**
 * Persist the evidence file.
 *
 * `measuredAt` is stamped only when a reading was established or changed, so a
 * verification pass that finds nothing new leaves the file byte-identical — and
 * leaves the date the numbers were measured telling the truth. `checkedAt`
 * records the verification itself, which is what makes "verified daily" a fact
 * rather than a claim.
 */
function save(stamp = false) {
  if (stamp) store.measuredAt = new Date().toISOString();
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(store, null, 2)}\n`);
}

const key = (year, code) => `${year}-${String(code).padStart(3, "0")}`;

/* ──────────────────────────────────────────────────────────── pacing ─── */

// The crawl's own governor, held at a fixed ceiling: this is a burst of reads
// against somebody else's server and it should be paced by the number that
// governs every other burst, not by a second opinion invented here.
const governor = new RateGovernor(RPS, RPS);

/** A single upstream read, reduced to "is there a student at this serial". */
async function probe(roll) {
  await governor.acquire();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const record = await studentDetails(roll);
      const branch = String(record?.branchName ?? record?.courseName ?? "");
      if (!branch) return { state: "unreadable", reason: "empty record" };
      governor.onSuccess();
      // The record rides along so discovery can check the answer is the number it
      // asked for; every other caller only looks at `state`.
      return { state: "hit", record };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("BPUT_NOT_PUBLISHED")) {
        // A miss: this serial has no student in it. The whole point.
        return { state: "miss" };
      }
      if (message.startsWith("BPUT_RATE_LIMITED")) {
        governor.onRateLimited();
        await new Promise((r) => setTimeout(r, governor.backoffMs || 5_000));
        continue;
      }
      if (attempt === 1) return { state: "unreadable", reason: message.slice(0, 80) };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { state: "unreadable", reason: "retries exhausted" };
}

/**
 * Highest live serial in one block. Returns `serial: null` when the block could
 * not be read at all, so an unreachable portal can never be recorded as an empty
 * college — the one error this measurement must not make.
 */
async function highestLive(prefix) {
  let unreadable = 0;
  let answered = 0;

  const at = async (serial) => {
    const result = await probe(`${prefix}${String(serial).padStart(3, "0")}`);
    if (result.state === "unreadable") {
      unreadable += 1;
      return null;
    }
    answered += 1;
    return result.state === "hit";
  };

  const empty = { serial: null, unreadable, answered };
  const top = await at(SERIAL_MAX);
  if (top === true) return { serial: SERIAL_MAX, unreadable, answered };
  if (top === null && answered === 0) return empty;

  let cursor = 0; // last known hit (0 = not even the first serial answered yet)
  let miss = SERIAL_MAX; // known miss above the cursor
  while (miss - cursor > 1) {
    const mid = (cursor + miss) >> 1;
    const hit = await at(mid);
    if (hit === true) cursor = mid;
    else miss = mid;
  }
  if (answered === 0) return empty;

  // Gap arbitration: a miss at `miss` may be a hole rather than the end.
  for (let round = 0; round < 8; round += 1) {
    let advanced = 0;
    for (let step = 1; step <= WINDOW && cursor + step < SERIAL_MAX; step += 1) {
      const hit = await at(cursor + step);
      if (hit === true) {
        advanced = cursor + step;
        break;
      }
    }
    if (!advanced) break;
    let lo = advanced;
    let hi = SERIAL_MAX;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const hit = await at(mid);
      if (hit === true) lo = mid;
      else hi = mid;
    }
    if (lo === cursor) break;
    cursor = lo;
  }

  return { serial: cursor, unreadable, answered };
}

/**
 * Exact count for one block: every serial from 001 to `upper`, counted.
 *
 * This is the slow, honest answer the cheap method is checked against, and it is
 * what makes the cheap method falsifiable in both directions. Holes below the
 * measured maximum show up as `measured - exact > 0`; a live serial *above* it
 * (a tail longer than the arbitration window) shows up as negative drift, which
 * would mean the measurement truncated a college.
 *
 * The walk is bounded by the measurement plus a generous tail, and the probes
 * inside a block go out in parallel — a 998-serial college read one at a time
 * costs five minutes of somebody else's server, and the whole point of auditing
 * a sample is that a sample should be affordable.
 */
async function exactCount(prefix, upper) {
  const limit = Math.min(SERIAL_MAX, upper);
  let live = 0;
  let unreadable = 0;
  let index = 1;

  const worker = async () => {
    while (index <= limit) {
      const serial = index++;
      const result = await probe(`${prefix}${String(serial).padStart(3, "0")}`);
      if (result.state === "hit") live += 1;
      else if (result.state === "unreadable") unreadable += 1;
    }
  };
  await Promise.all(Array.from({ length: AUDIT_CONCURRENCY }, worker));
  return { live, unreadable, probed: limit };
}

/**
 * Does the recorded bound still describe the portal?
 *
 * Two requests: the recorded serial must still answer for a student, and the
 * serial above it must still answer for nobody. Anything else — including an
 * unreadable answer — falls through to a full re-measure, because re-measuring a
 * block costs minutes while publishing a bound the portal has moved past costs a
 * wrong number about the university.
 */
async function stillHolds(prefix, bound) {
  if (bound === 0) {
    const first = await probe(`${prefix}001`);
    return first.state === "miss";
  }
  const top = await probe(`${prefix}${String(bound).padStart(3, "0")}`);
  if (top.state !== "hit") return false;
  if (bound >= SERIAL_MAX) return true;
  const above = await probe(`${prefix}${String(bound + 1).padStart(3, "0")}`);
  return above.state === "miss";
}

/* ──────────────────────── sweep ─── */

const deadline = Date.now() + SECONDS * 1_000;
const pending = [];
for (const year of YEARS) {
  for (const code of CENSUS_COLLEGES[year]) {
    const id = key(year, code);
    const recorded = store.blocks[id]?.serial;
    const known = typeof recorded === "number";
    if (known && !FORCE && !REFRESH) continue;
    pending.push({
      id,
      year,
      code,
      prefix: `${String(year).padStart(2, "0")}01${String(code).padStart(3, "0")}`,
      // null means "search for it": either nothing is recorded, or the reading
      // is not being trusted this pass.
      verify: known && !FORCE ? recorded : null,
    });
  }
}

if (pending.length === 0) {
  console.log(`[intake] nothing to measure for ${YEARS.join(", ")} — already in ${FILE}.`);
}

let cursor = 0;
let done = 0;
let failed = 0;
let verified = 0;
/** Readings that were established or actually moved. */
let readings = 0;

async function worker() {
  while (cursor < pending.length && Date.now() < deadline) {
    const job = pending[cursor++];
    if (typeof job.verify === "number" && (await stillHolds(job.prefix, job.verify))) {
      verified += 1;
      done += 1;
      continue;
    }
    const previous = store.blocks[job.id]?.serial;
    const measured = await highestLive(job.prefix);
    if (measured.serial === null) {
      failed += 1;
      store.blocks[job.id] = {
        serial: null,
        unreadable: measured.unreadable,
        at: new Date().toISOString(),
      };
    } else {
      store.blocks[job.id] = {
        serial: measured.serial,
        unreadable: measured.unreadable,
        probes: measured.answered,
        at: new Date().toISOString(),
      };
    }
    // A fresh reading only counts as a change when it disagrees with what was
    // recorded, so a verification pass that finds nothing new stamps no date and
    // produces no evidence-file diff.
    if (previous !== store.blocks[job.id].serial) readings += 1;
    done += 1;
    if (done % 25 === 0) {
      save(readings > 0);
      console.log(
        `[intake] ${done}/${pending.length} blocks · ${job.id} → ${store.blocks[job.id].serial ?? "unreadable"}`,
      );
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (REFRESH) store.checkedAt = new Date().toISOString();
save(readings > 0);

/* ──────────────────────────────────────────────────────────── audit ─── */

if (AUDIT > 0 || AUDIT_BLOCKS.length > 0) {
  // Sample across the whole grid rather than one year, so the drift figure is
  // not a statement about whichever batch happened to be picked.
  const candidates = [];
  for (const year of YEARS) {
    for (const code of CENSUS_COLLEGES[year]) {
      const entry = store.blocks[key(year, code)];
      if (entry && typeof entry.serial === "number") candidates.push({ year, code, entry });
    }
  }
  const stride = AUDIT > 0 ? Math.max(1, Math.floor(candidates.length / AUDIT)) : 1;
  const sample = [
    ...candidates.filter((_, index) => index % stride === 0).slice(0, AUDIT),
    ...AUDIT_BLOCKS.map((id) => candidates.find((c) => key(c.year, c.code) === id)).filter(Boolean),
  ];
  console.log(`[intake] auditing ${sample.length} blocks with full walks…`);
  const audits = (store.audits ?? []).filter(
    (a) => !sample.some((s) => key(s.year, s.code) === a.block),
  );
  for (const job of sample) {
    const prefix = `${String(job.year).padStart(2, "0")}01${String(job.code).padStart(3, "0")}`;
    // Three arbitration windows past the measured end, so a tail the window
    // missed would be reported as negative drift rather than hidden.
    const exact = await exactCount(prefix, job.entry.serial + WINDOW * 3 + 1);
    audits.push({
      block: key(job.year, job.code),
      measured: job.entry.serial,
      exact: exact.live,
      unreadable: exact.unreadable,
    });
    console.log(
      `[intake] audit ${key(job.year, job.code)}: max serial ${job.entry.serial} · exact live ${exact.live}` +
        ` · drift ${job.entry.serial - exact.live} · probed ${exact.probed}`,
    );
    // Persist per block: a full walk of a large college is not free, and an
    // audit that is lost to a timeout has to be paid for twice.
    store.audits = audits;
    save();
  }
  store.audits = audits;
  save();
}

/* ─────────────────────────────────────────────── discovery ─── */

/**
 * Batch years the portal could plausibly be numbering that the grid does not
 * carry: everything above its newest year, up to this calendar year.
 *
 * BPUT begins a batch year's numbering during its admission season, so this
 * window is empty on most days and cheap to re-check every day — and it is the
 * reason a whole new cohort cannot arrive unnoticed.
 */
function frontierYears(now = new Date()) {
  const out = [];
  for (let year = Math.max(...CENSUS_YEARS) + 1; year <= now.getUTCFullYear() % 100; year += 1) {
    out.push(year);
  }
  return out;
}

/**
 * Declared years to re-sweep, taken in rotation by day rather than from a stored
 * cursor: nothing to get out of step, and a year a truncated run skipped comes
 * round again a week later, which is the same guarantee with less bookkeeping.
 */
function sweepRotation(now = new Date()) {
  const perRun = Math.max(0, Math.min(SWEEP_YEARS, CENSUS_YEARS.length));
  if (perRun === 0) return [];
  const day = Math.floor(now.getTime() / 86_400_000);
  return Array.from({ length: perRun }, (_, i) => CENSUS_YEARS[(day + i) % CENSUS_YEARS.length]);
}

/**
 * Which of these codes the portal answers for in this batch year.
 *
 * One probe each, `YY01CCC001` — the first student a college admits, because
 * serials run densely from 001, so a code that answers is a college with a batch
 * that year. The inverse is not proven: a college whose very first student never
 * registered stays invisible here. That inequality is why a hit is measured
 * properly before it is written, and why an unreadable probe is reported as one
 * rather than counted as an absence — a miss may only ever cost a college, never
 * invent one.
 *
 * A hit is also checked against the number that was asked for. The portal echoes
 * `rollNo`, so an answer about somebody else cannot add a block; a mismatch is
 * reported rather than dropped, because it would mean the portal is misrouting.
 */
async function scanCodes(year, codes, until) {
  const found = [];
  const mismatched = [];
  let unreadable = 0;
  let scanned = 0;
  let index = 0;
  const prefix = String(year).padStart(2, "0");

  const worker = async () => {
    while (index < codes.length && Date.now() < until) {
      const code = codes[index++];
      const roll = `${prefix}01${String(code).padStart(3, "0")}001`;
      const result = await probe(roll);
      scanned += 1;
      if (result.state === "hit") {
        if (String(result.record?.rollNo ?? "") === roll) found.push(code);
        else mismatched.push(code);
      } else if (result.state === "unreadable") {
        unreadable += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  found.sort((a, b) => a - b);
  return { found, mismatched, unreadable, scanned, complete: scanned === codes.length };
}

/**
 * Persist one block's reading into the evidence file, the way the sweep does, and
 * count it as a change only when it disagrees with what was already recorded.
 */
function recordReading(year, code, measured) {
  const id = key(year, code);
  const previous = store.blocks[id]?.serial;
  store.blocks[id] =
    measured.serial === null
      ? { serial: null, unreadable: measured.unreadable, at: new Date().toISOString() }
      : {
          serial: measured.serial,
          unreadable: measured.unreadable,
          probes: measured.answered,
          at: new Date().toISOString(),
        };
  if (previous !== store.blocks[id].serial) readings += 1;
}

/**
 * Append the discovered blocks to `census-discovered.ts`.
 *
 * The overlay is rewritten between two anchors, the way the constants are, so its
 * prose stays hand-written and only the generated map moves. `// prettier-ignore`
 * above that map is deliberate: a batch year with eighty college codes on one line
 * is not something a formatter should reflow, and the daily job checks formatting
 * before it commits.
 */
function writeDiscovered(map) {
  const years = Object.keys(map)
    .map(Number)
    .sort((a, b) => a - b);
  const rows = years.map((year) => `  ${year}: [${map[year].join(", ")}],`).join("\n");
  const before = readFileSync(DISCOVERED_FILE, "utf8");
  let after = before.replace(
    /export const CENSUS_DISCOVERED: Record<number, readonly number\[\]> = \{[\s\S]*?\};/,
    `export const CENSUS_DISCOVERED: Record<number, readonly number[]> = {\n${rows}\n};`,
  );
  after = after.replace(
    /export const CENSUS_DISCOVERED_AT = "[^"]*";/,
    `export const CENSUS_DISCOVERED_AT = "${new Date().toISOString().slice(0, 10)}";`,
  );
  if (after === before) return false;
  writeFileSync(DISCOVERED_FILE, after);
  const blocks = years.reduce((n, year) => n + (map[year]?.length ?? 0), 0);
  console.log(`[intake] appended ${blocks} block(s) to ${DISCOVERED_FILE}`);
  return true;
}

/**
 * Ask the portal what the grid is missing, and append what it finds.
 *
 * Two things can be missing and both of them are invisible to every other part of
 * the census: a batch year the portal has just started numbering, and a college
 * that opened a batch in a year it never had one. The first is scanned every run
 * (the window above), the second by re-sweeping the declared years in rotation.
 *
 * Nothing is written unless every block it found has been measured, because a
 * half-measured grid is one the constants writer refuses and the dashboard would
 * draw a block with no reading. A run cut short therefore writes nothing and is
 * retried tomorrow, which costs the scan twice and never publishes a guess.
 */
async function discover() {
  const until = Date.now() + SECONDS * 1_000;
  const added = {};
  const report = [];

  for (const year of [...frontierYears(), ...sweepRotation()]) {
    const declared = CENSUS_COLLEGES[year] ?? [];
    const codes = [];
    for (let code = CODE_MIN; code <= CODE_MAX; code += 1) {
      if (!declared.includes(code)) codes.push(code);
    }
    const label = `20${String(year).padStart(2, "0")}`;
    if (codes.length === 0) continue;
    if (Date.now() >= until) {
      report.push({ year: 2000 + year, scanned: 0, found: 0, complete: false });
      continue;
    }

    const scan = await scanCodes(year, codes, until);
    if (scan.mismatched.length > 0) {
      console.warn(
        `[intake] discover ${label}: ${scan.mismatched.length} answer(s) named a different registration number — ignored`,
      );
    }
    if (scan.found.length === 0) {
      report.push({ year: 2000 + year, scanned: scan.scanned, found: 0, complete: scan.complete });
      console.log(
        `[intake] discover ${label}: ${scan.scanned} code(s) probed, nothing the grid does not already carry` +
          (scan.complete ? "" : " (budget ran out mid-scan)"),
      );
      continue;
    }

    // Measure before writing: the constants writer refuses a grid with a reading
    // missing, so a block added unmeasured would freeze the measurement instead of
    // publishing it.
    const measured = new Map();
    let next = 0;
    const worker = async () => {
      while (next < scan.found.length && Date.now() < until) {
        const code = scan.found[next++];
        const block = await highestLive(
          `${String(year).padStart(2, "0")}01${String(code).padStart(3, "0")}`,
        );
        measured.set(code, block);
      }
    };
    await Promise.all(Array.from({ length: MEASURE_CONCURRENCY }, worker));

    const unmeasured = scan.found.filter((code) => !measured.has(code));
    report.push({
      year: 2000 + year,
      scanned: scan.scanned,
      found: scan.found.length,
      measured: measured.size,
      complete: unmeasured.length === 0,
    });
    if (unmeasured.length > 0) {
      console.warn(
        `[intake] discover ${label}: found ${scan.found.length} new block(s) but the budget ran out before all of them were measured — nothing written, retried next run`,
      );
      continue;
    }

    for (const code of scan.found) recordReading(year, code, measured.get(code));
    added[year] = scan.found;
    console.log(
      `[intake] discover ${label}: ${scan.found.length} new block(s) — ` +
        `${scan.found
          .slice(0, 12)
          .map((code) => String(code).padStart(3, "0"))
          .join(", ")}${scan.found.length > 12 ? `, +${scan.found.length - 12} more` : ""}`,
    );
  }

  if (Object.keys(added).length === 0) {
    console.log("[intake] discover: nothing to add — the grid covers what the portal serves");
    return { added, report, written: false };
  }

  // New readings, so the date the measurement was taken moves with them.
  save(true);
  const written = writeDiscovered({ ...CENSUS_DISCOVERED, ...added });
  return { added, report, written };
}

/* ─────────────────────────── rewrite the grid's own constants ─── */

/** `160609` → `160_609`, matching the underscores the module already uses. */
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");

/**
 * Re-derive the constants in `census-blocks.ts` from the evidence file.
 *
 * The dashboard reads those constants, so a measurement nobody re-runs is a
 * dashboard that quietly stops being true. This is what lets the daily scheduled
 * check keep the published figures honest without a human deciding to.
 *
 * The definitions are stated here so the regenerated file cannot drift from its
 * own rules: `mean` is serials ÷ blocks at one decimal, `median` is the upper
 * middle reading of the sorted block, `max` is the largest reading, and the
 * student count removes the measured hole rate for the year's era.
 */
function renderConstants(extra = {}) {
  const years = [];
  const flat = [];
  let missing = 0;
  // Blocks discovery added in this very process are not in the imported grid yet
  // — the overlay file was written a moment ago — so they are handed in.
  const grid = [...new Set([...CENSUS_YEARS, ...Object.keys(extra).map(Number)])].sort(
    (a, b) => a - b,
  );
  for (const year of grid) {
    const values = [];
    const codes = [...new Set([...(CENSUS_COLLEGES[year] ?? []), ...(extra[year] ?? [])])].sort(
      (a, b) => a - b,
    );
    for (const code of codes) {
      const serial = store.blocks[key(year, code)]?.serial;
      if (typeof serial !== "number") {
        missing += 1;
        continue;
      }
      values.push(serial);
      flat.push(serial);
    }
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const serials = values.reduce((a, v) => a + v, 0);
    years.push({
      year: 2000 + year,
      blocks: n,
      serials,
      mean: n > 0 ? Number((serials / n).toFixed(1)) : 0,
      median: n > 0 ? sorted[Math.round((n - 1) * 0.5)] : 0,
      max: n > 0 ? sorted[n - 1] : 0,
      students:
        serials * (1 - (year <= 14 ? MEASURED_HOLE_RATE.before2015 : MEASURED_HOLE_RATE.from2015)),
    });
  }
  return {
    years,
    flat,
    serials: flat.reduce((a, v) => a + v, 0),
    students: Math.round(years.reduce((a, r) => a + r.students, 0)),
    missing,
  };
}

/** Replace everything between two anchors, keeping the anchors themselves. */
function swap(src, start, end, body) {
  const from = src.indexOf(start);
  if (from === -1) throw new Error(`${TS_FILE}: cannot find ${start.slice(0, 48)}…`);
  const to = src.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`${TS_FILE}: cannot find the end of ${start.slice(0, 48)}…`);
  return `${src.slice(0, from + start.length)}${body}${src.slice(to)}`;
}

function writeConstants(extra = {}) {
  const { years, flat, serials, students, missing } = renderConstants(extra);
  if (missing > 0) {
    // Half a measurement would rewrite the block array out of alignment with the
    // grid, which is the one way this could publish a wrong number.
    console.error(`[intake] refusing to rewrite ${TS_FILE}: ${missing} block(s) have no reading.`);
    process.exitCode = 4;
    return;
  }

  const before = readFileSync(TS_FILE, "utf8");
  const measuredAt = (store.measuredAt ?? new Date().toISOString()).slice(0, 10);
  const checkedAt = (store.checkedAt ?? store.measuredAt ?? new Date().toISOString()).slice(0, 10);
  let after = before;

  after = swap(
    after,
    "export const MEASURED_INTAKE: Record<number, MeasuredIntake> = {\n",
    "\n};",
    years
      .map(
        (r) =>
          `  ${r.year}: { blocks: ${r.blocks}, serials: ${grouped(r.serials)}, mean: ${r.mean}, median: ${r.median}, max: ${r.max} },`,
      )
      .join("\n"),
  );
  after = after.replace(
    /export const MEASURED_AT = "[^"]*";/,
    `export const MEASURED_AT = "${measuredAt}";`,
  );
  after = after.replace(
    /export const MEASURED_CHECKED_AT = "[^"]*";/,
    `export const MEASURED_CHECKED_AT = "${checkedAt}";`,
  );
  after = after.replace(
    /export const MEASURED_SERIALS = [\d_]+;/,
    `export const MEASURED_SERIALS = ${grouped(serials)};`,
  );
  after = swap(
    after,
    "export const MEASURED_BLOCK_SERIALS: readonly number[] = [\n",
    "\n];",
    Array.from(
      { length: Math.ceil(flat.length / 16) },
      (_, i) => `  ${flat.slice(i * 16, i * 16 + 16).join(", ")},`,
    ).join("\n"),
  );
  // The header states the totals in prose. Left alone it would contradict the
  // numbers underneath it the first time a college opens or closes.
  after = after.replace(
    /Total: [\d,]+ college-year blocks holding [\d,]+ registration numbers and about\n\/\/ [\d,]+ students/,
    `Total: ${flat.length} college-year blocks holding ${serials.toLocaleString("en-US")} registration numbers and about\n// ${students.toLocaleString("en-US")} students`,
  );

  if (after === before) {
    console.log(`[intake] ${TS_FILE} already matches the measurement`);
    return;
  }
  writeFileSync(TS_FILE, after);
  console.log(
    `[intake] rewrote ${TS_FILE}: ${flat.length} blocks, ${serials.toLocaleString("en-US")} numbers, ` +
      `${students.toLocaleString("en-US")} students, measured ${measuredAt}, checked ${checkedAt}`,
  );
}

const discovery = DISCOVER ? await discover() : null;
if (WRITE_CONSTANTS) writeConstants(discovery?.written ? discovery.added : {});

/* ───────────────────────────────────────────────────────────── report ─── */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[index];
}

console.log("\n[intake] measured population by batch year");
console.log(
  ["year", "blocks", "measured", "empty", "pending", "min", "p50", "p90", "max"]
    .map((h) => h.padStart(9))
    .join(""),
);

let total = 0;
let totalBlocks = 0;
let emptyBlocks = 0;
let unreadableBlocks = 0;
let missing = 0;

for (const year of YEARS) {
  const values = [];
  for (const code of CENSUS_COLLEGES[year]) {
    const entry = store.blocks[key(year, code)];
    if (!entry) {
      missing += 1;
      continue;
    }
    if (typeof entry.serial !== "number") {
      unreadableBlocks += 1;
      continue;
    }
    if (entry.serial === 0) emptyBlocks += 1;
    values.push(entry.serial);
  }
  if (values.length === 0) continue;
  values.sort((a, b) => a - b);
  const sum = values.reduce((n, v) => n + v, 0);
  total += sum;
  totalBlocks += values.length;
  console.log(
    [
      `20${String(year).padStart(2, "0")}`,
      values.length,
      sum,
      values.filter((v) => v === 0).length,
      CENSUS_COLLEGES[year].length - values.length,
      values[0],
      percentile(values, 50),
      percentile(values, 90),
      values[values.length - 1],
    ]
      .map((v) => String(v).padStart(9))
      .join(""),
  );
}

console.log(
  `[intake] ${totalBlocks} blocks measured · ${total.toLocaleString()} registration numbers carry a student` +
    ` · ${emptyBlocks} empty · ${unreadableBlocks} unreadable · ${missing} still to measure`,
);
if (store.audits?.length) {
  const drift = store.audits.reduce((n, a) => n + (a.measured - a.exact), 0);
  console.log(
    `[intake] audit: ${store.audits.length} blocks full-walked, total drift ${drift} serial(s) over ${store.audits.reduce((n, a) => n + a.exact, 0)} exact students.`,
  );
}
if (REFRESH) {
  console.log(
    `[intake] refresh: ${verified} reading(s) confirmed still exact, ` +
      `${readings} block(s) re-measured to a different number`,
  );
}
if (discovery) {
  const found = Object.values(discovery.added).reduce((n, codes) => n + codes.length, 0);
  console.log(
    `[intake] discovery: ${discovery.report.reduce((n, r) => n + r.scanned, 0)} code(s) probed, ` +
      `${found} block(s) added${discovery.written ? ` to ${DISCOVERED_FILE}` : ""}`,
  );
}
if (typeof REPORT === "string") {
  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        refresh: REFRESH,
        blocksChecked: pending.length,
        verified,
        changed: readings,
        failed,
        blocks: totalBlocks,
        serials: total,
        discover: DISCOVER,
        discovery: discovery ? { written: discovery.written, years: discovery.report } : null,
        discovered: discovery
          ? Object.values(discovery.added).reduce((n, codes) => n + codes.length, 0)
          : 0,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[intake] wrote ${REPORT}`);
}
console.log(`[intake] wrote ${FILE}`);
process.exitCode = failed > 0 ? 3 : 0;
