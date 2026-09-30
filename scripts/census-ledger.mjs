#!/usr/bin/env bun
// Publish the measured universe into the census ledger, and check it is coherent.
//
// The crawl walks the compiled grid in `src/lib/census-blocks.ts` and the
// dashboard reads the database, so the two have to agree about what exists. This
// is what makes them agree: it writes the per-block measured bounds and the
// sessions the portal last answered for, and then reads the plan back so the log
// shows exactly what the page will say.
//
// The daily refresh runs it after re-measuring, which is why a bound that moved
// during the night is visible to the dashboard the same morning, and why a new
// batch year, a college that opened, or a semester BPUT has just started serving
// becomes work without anybody editing a number.
//
//   bun scripts/census-ledger.mjs            # publish and report
//   bun scripts/census-ledger.mjs --verify   # publish, then check the invariants
//
// Exit codes: 0 published (or nothing to publish because no credentials are set),
// 1 the ledger refused the write or failed an invariant.
//
// No registration number is ever involved: a block is a college, a batch year and
// a measured count.
import { measuredBlocks } from "../src/lib/census-blocks.ts";
import { SESSION_WATCH, SESSION_WATCH_CHECKED_AT } from "../src/lib/census-session-watch.ts";

const args = new Set(process.argv.slice(2));
const verify = args.has("--verify");

const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();

if (!url || !key) {
  console.log(
    "[census] ledger not published, no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in this environment.",
  );
  console.log(
    "         The crawl still publishes the universe on every slice, so this is a convenience, not a requirement.",
  );
  process.exit(0);
}

const headers = { "Content-Type": "application/json", apikey: key };
// New-format Supabase keys are opaque strings, not bearer JWTs; sending them as
// a bearer token makes the gateway reject the request.
if (!key.startsWith("sb_publishable_") && !key.startsWith("sb_secret_")) {
  headers.Authorization = `Bearer ${key}`;
}

async function rpc(fn, body) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} failed (${res.status}): ${text.slice(0, 300)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/*
 * PostgREST answers at most `db-max-rows` rows (1,000 on this project) however
 * large a `limit` asks for, which is small enough to truncate the ledger, and a
 * truncated read here would look like blocks missing from the database rather
 * than like a query that stopped early. So the read pages explicitly.
 */
async function readTable(query) {
  const page = 1_000;
  const rows = [];
  for (let from = 0; ; from += page) {
    const res = await fetch(`${url}/rest/v1/${query}`, {
      headers: { ...headers, Range: `${from}-${from + page - 1}`, "Range-Unit": "items" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${query} failed (${res.status}): ${text.slice(0, 300)}`);
    const chunk = JSON.parse(text);
    rows.push(...chunk);
    if (chunk.length < page) return rows;
  }
}

/* ── publish ──────────────────────────────────────────────────────────────── */

const blocks = measuredBlocks().map((b) => ({ year: b.year, code: b.code, max: b.serial }));
const watch = Object.entries(SESSION_WATCH).map(([year, semesters]) => ({
  year: Number(year),
  semesters: [...semesters],
}));

try {
  const noted = await rpc("census_note_blocks", { _rows: blocks });
  const watched = await rpc("census_note_watch", { _rows: watch });
  console.log(
    `[census] ledger published, ${noted ?? blocks.length} measured bound(s) across ${
      new Set(blocks.map((b) => b.year)).size
    } batch year(s), ${watched ?? watch.length} session-watch row(s) (portal checked ${SESSION_WATCH_CHECKED_AT})`,
  );
} catch (error) {
  console.error(`[census] ledger write failed: ${error.message}`);
  console.log(
    "[census] If this is a missing function, apply supabase/migrations/20260929193000_census_maintenance.sql.",
  );
  process.exit(1);
}

/* ── report ───────────────────────────────────────────────────────────────── */

let plan = null;
try {
  plan = await rpc("census_plan");
} catch (error) {
  console.error(`[census] census_plan unavailable: ${error.message}`);
  process.exit(1);
}

const num = (v) => Number(v ?? 0).toLocaleString();
console.log(
  `[census] plan, ${plan.blocksDone}/${plan.blocks} block(s) read through, ` +
    `${num(plan.serialsRemaining)} serial(s) left to read first, ` +
    `${plan.passesPending} maintenance pass(es) pending (${num(plan.passSerialsPending)} serials to sweep)`,
);
console.log(
  `[census] watch last checked ${plan.watchCheckedAt ?? "never"} · ledger written ${plan.updatedAt ?? "never"}`,
);

const outstanding = (plan.years ?? []).filter((y) => y.serialsLeft > 0 || y.pendingPasses > 0);
for (const year of outstanding) {
  console.log(
    `    ${year.year}  blocks ${year.firstPassDone}/${year.blocks} read · ` +
      `${num(year.serialsLeft)} serial(s) left · ` +
      `${year.pendingPasses} pass(es) pending (${num(year.passSerialsPending)} serials) · ` +
      `${year.passesDone} pass(es) done`,
  );
}

if (!verify) process.exit(0);

/* ── verify ───────────────────────────────────────────────────────────────── */

// The invariants worth checking are the ones the design rests on. If any of them
// fails, the published totals are wrong rather than merely stale, which is the
// difference worth failing a job over.
const failures = [];

const walkRows = await readTable(
  "census_block_walk?select=year,code,max_serial,serial_offset,frontier,first_pass_at,first_pass_sessions&order=year,code",
).catch((error) => {
  failures.push(`could not read the block ledger: ${error.message}`);
  return [];
});
const passRows = await readTable(
  "census_pass?select=year,code,semester,status,serial_offset,updated_at&order=year,code,semester",
).catch((error) => {
  failures.push(`could not read the pass ledger: ${error.message}`);
  return [];
});

if (walkRows.length !== plan.blocks) {
  failures.push(`plan says ${plan.blocks} block(s), the ledger holds ${walkRows.length}`);
}
const measured = walkRows.filter((r) => (r.max_serial ?? 0) > 0).length;
if (measured > 0 && measured !== plan.blocksMeasured) {
  failures.push(`plan says ${plan.blocksMeasured} measured block(s), the ledger holds ${measured}`);
}

// A pass may not exist for a semester the first pass already captured: that would
// mean a semester was read twice, and every observation in it counted twice.
const byBlock = new Map(walkRows.map((r) => [`${r.year}:${r.code}`, r]));
const duplicated = [];
for (const pass of passRows) {
  if (pass.status !== "done" && pass.status !== "empty") continue;
  const block = byBlock.get(`${pass.year}:${pass.code}`);
  const captured = block?.first_pass_sessions ?? [];
  if (captured.map(Number).includes(Number(pass.semester))) {
    duplicated.push(`${pass.year}·${pass.code}·S${pass.semester}`);
  }
}
if (duplicated.length > 0) {
  failures.push(
    `${duplicated.length} semester pass(es) re-read what the first pass had already captured: ${duplicated
      .slice(0, 8)
      .join(", ")}`,
  );
}

/*
 * The sentinel this whole design turns on: a semester the portal serves, that no
 * block of that year has captured, and that nothing is queued to read.
 *
 * That is the failure mode the page cannot show you. Coverage would look healthy
 *, every block finished, no work pending, while a semester of results sat
 * unread, and the counts would never change again. It can only be asked of a year
 * that has finished blocks, because until then the first pass still owns it and
 * will capture the semester as part of reading the block.
 *
 * "Nothing is queued" has to mirror the view exactly, including its thirty-day
 * window: a pass closed more than a month ago is queued again on purpose, because
 * results are published in batches and a semester can answer for nobody today and
 * for everybody next month.
 */
const settled = (pass) =>
  (pass.status === "done" || pass.status === "empty") &&
  Date.now() - Date.parse(pass.updated_at) < 30 * 24 * 60 * 60 * 1_000;

const stranded = [];
for (const [yearKey, semesters] of Object.entries(SESSION_WATCH)) {
  const year = Number(yearKey);
  const finished = walkRows.filter((r) => r.year === year && r.first_pass_at);
  if (finished.length === 0) continue;
  const pendingPasses = (plan.years ?? []).find((y) => y.year === year)?.pendingPasses ?? 0;
  for (const semester of semesters) {
    const captured = finished.some((r) =>
      (r.first_pass_sessions ?? []).map(Number).includes(Number(semester)),
    );
    if (captured) continue;
    const claimed = passRows.some(
      (p) =>
        p.year === year &&
        Number(p.semester) === Number(semester) &&
        (settled(p) || p.status === "running"),
    );
    if (!claimed && pendingPasses < 1) stranded.push(`${year}·S${semester}`);
  }
}
if (stranded.length > 0) {
  failures.push(
    `the portal serves ${stranded.slice(0, 8).join(", ")}` +
      `${stranded.length > 8 ? ` (+${stranded.length - 8})` : ""} and no block of that year has ` +
      `it, but the plan queues no pass, the semester would sit unread while coverage still looked complete`,
  );
}

/*
 * A finished block with no recorded frontier is a block whose read position is
 * unknown, and both ways of treating it are wrong: the walk resumes at serial 001
 * and appends a second copy of observations nothing can deduplicate, or it is left
 * alone and the college stops being watched for growth. This is the defect the
 * seeded ledger shipped with, so it is a failure rather than a note, the fix is
 * one migration and the check is the only thing that would have said so.
 */
const unknownFrontier = walkRows.filter(
  (r) => r.first_pass_at && (r.frontier ?? 0) === 0 && (r.max_serial ?? 0) > 0,
);
if (unknownFrontier.length > 0) {
  failures.push(
    `${unknownFrontier.length} finished block(s) have no recorded frontier (e.g. ` +
      `${unknownFrontier[0].year}·${unknownFrontier[0].code}), apply ` +
      `supabase/migrations/20260929223000_census_frontier_repair.sql`,
  );
}

/*
 * A frontier past the measured bound is a finding, not a fault: it means a college
 * answered for a serial the measurement said did not exist, which is exactly the
 * growth the daily re-measure exists to catch. Reported so the number is visible,
 * never failed, the walk is right and the measurement is the thing that is behind.
 */
const beyond = walkRows.filter((r) => (r.frontier ?? 0) > (r.max_serial ?? 0) && r.max_serial > 0);
if (beyond.length > 0) {
  console.log(
    `[census] note, ${beyond.length} block(s) answered past their measured bound, so the ` +
      `measurement is behind the portal there (e.g. ${beyond[0].year}·${beyond[0].code}: ` +
      `frontier ${beyond[0].frontier} > measured ${beyond[0].max_serial}); the next refresh re-measures them`,
  );
}

const donePasses = passRows.filter((p) => p.status === "done" || p.status === "empty").length;
console.log(
  `[census] verify, ${walkRows.length} block(s), ${passRows.length} pass row(s) (${donePasses} closed), ` +
    `${measured} measured, ${unknownFrontier.length} without a frontier, ` +
    `${duplicated.length} duplicate read(s), ${stranded.length} stranded semester(s)`,
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`[census] ✗ ${failure}`);
  process.exit(1);
}
console.log(
  "[census] ✓ ledger invariants hold: no semester read twice, no walk past a measured bound",
);
