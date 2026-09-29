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
// Measurements accumulate in `docs/census-intake.json`. A block measured once is
// not re-probed unless `--force` is passed, so the sweep can be split across as
// many short commands as it needs. Nothing here writes to BPUT or to Supabase:
// the output is evidence, and the crawl remains the only thing allowed to
// publish a figure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { studentDetails } from "../src/lib/bput-upstream.ts";
import { RateGovernor } from "../src/lib/census-core.ts";
import { CENSUS_COLLEGES, CENSUS_YEARS, SERIAL_MAX } from "../src/lib/census-blocks.ts";

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

function save() {
  store.measuredAt = new Date().toISOString();
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
      return { state: "hit" };
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

/* ───────────────────────────────────────────────────────────── sweep ─── */

const deadline = Date.now() + SECONDS * 1_000;
const pending = [];
for (const year of YEARS) {
  for (const code of CENSUS_COLLEGES[year]) {
    const id = key(year, code);
    if (!FORCE && typeof store.blocks[id]?.serial === "number") continue;
    pending.push({
      id,
      year,
      code,
      prefix: `${String(year).padStart(2, "0")}01${String(code).padStart(3, "0")}`,
    });
  }
}

if (pending.length === 0) {
  console.log(`[intake] nothing to measure for ${YEARS.join(", ")} — already in ${FILE}.`);
}

let cursor = 0;
let done = 0;
let failed = 0;

async function worker() {
  while (cursor < pending.length && Date.now() < deadline) {
    const job = pending[cursor++];
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
    done += 1;
    if (done % 25 === 0) {
      save();
      console.log(
        `[intake] ${done}/${pending.length} blocks · ${job.id} → ${store.blocks[job.id].serial ?? "unreadable"}`,
      );
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
save();

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
console.log(`[intake] wrote ${FILE}`);
process.exitCode = failed > 0 ? 3 : 0;
