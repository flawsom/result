#!/usr/bin/env bun
// Does the ledger's sentinel actually fire?
//
// `scripts/census-ledger.mjs --verify` fails when the portal serves a semester
// that no block of that year has captured and nothing is queued to read it. That
// is the failure the dashboard cannot show you: coverage would look complete,
// every block finished, no work pending, while a semester of results sat unread
// and the counts stopped moving.
//
// A check that can never fail is decoration, and this one is unreachable through
// the live database without breaking it on purpose. So the sentinel is extracted
// from the shipped script, verbatim, and run against crafted ledgers instead:
// the healthy case, the exact gap it exists for, the two ways that gap is
// legitimately covered, the thirty-day rule that makes an old pass work again,
// and a year the first pass still owns.
//
//   bun scripts/census-sentinel-test.mjs
//
// Exit codes: 0 the sentinel behaves in every case, 1 it does not (or the script
// it extracts from changed shape, which is itself worth knowing).
import { readFileSync } from "node:fs";

const SOURCE = "scripts/census-ledger.mjs";
const START = "const settled = (pass) =>";
const END = "/*\n * A finished block with no recorded frontier";

const src = readFileSync(SOURCE, "utf8");
const from = src.indexOf(START);
const to = src.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
  console.error(
    `[sentinel] cannot find the sentinel in ${SOURCE} (markers moved?). The test extracts the ` +
      `shipped code rather than a copy, so it has to be told where it is.`,
  );
  process.exit(1);
}

// The sentinel closes over the watch, the walk rows, the pass rows, the plan and
// the failure list. Everything else it needs is standard.
const run = new Function(
  "SESSION_WATCH",
  "walkRows",
  "passRows",
  "plan",
  "failures",
  src.slice(from, to),
);

const DAY = 86_400_000;
const days = (n) => new Date(Date.now() - n * DAY).toISOString();
const block = (year, captured, finished = true) => ({
  year,
  code: 104,
  max_serial: 200,
  frontier: 200,
  first_pass_at: finished ? days(1) : null,
  first_pass_sessions: captured,
});
const pass = (year, semester, status, ageInDays) => ({
  year,
  semester,
  status,
  updated_at: days(ageInDays),
});
const planFor = (year, pendingPasses) => ({ years: [{ year, pendingPasses }] });

const cases = [
  {
    name: "healthy, the finished blocks captured every served semester",
    input: {
      watch: { 2012: [7, 8] },
      walk: [block(2012, [1, 2, 3, 4, 5, 6, 7, 8])],
      passes: [],
      plan: planFor(2012, 0),
    },
    expect: 0,
  },
  {
    name: "the gap, S7 is served, no block has it, nothing is queued",
    input: {
      watch: { 2012: [7, 8] },
      walk: [block(2012, [1, 2, 3, 4, 5, 6])],
      passes: [],
      plan: planFor(2012, 0),
    },
    expect: 1,
  },
  {
    name: "queued, the same gap, but the plan reports the pass",
    input: {
      watch: { 2012: [7, 8] },
      walk: [block(2012, [1, 2, 3, 4, 5, 6])],
      passes: [],
      plan: planFor(2012, 1),
    },
    expect: 0,
  },
  {
    name: "claimed, a pass closed yesterday covers it",
    input: {
      watch: { 2012: [7, 8] },
      walk: [block(2012, [1, 2, 3, 4, 5, 6])],
      passes: [pass(2012, 7, "done", 1), pass(2012, 8, "done", 1)],
      plan: planFor(2012, 0),
    },
    expect: 0,
  },
  {
    name: "stale claim, a pass closed 35 days ago is work again, so the gap must fire",
    input: {
      watch: { 2012: [7, 8] },
      walk: [block(2012, [1, 2, 3, 4, 5, 6])],
      passes: [pass(2012, 7, "done", 35), pass(2012, 8, "done", 35)],
      plan: planFor(2012, 0),
    },
    expect: 1,
  },
  {
    name: "not yet, the year has no finished block, so the first pass still owns it",
    input: {
      watch: { 2025: [1, 2] },
      walk: [block(2025, [], false)],
      passes: [],
      plan: planFor(2025, 0),
    },
    expect: 0,
  },
];

let failed = 0;
for (const test of cases) {
  const failures = [];
  run(test.input.watch, test.input.walk, test.input.passes, test.input.plan, failures);
  const ok = failures.length === test.expect;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${test.name} → ${failures.length} failure(s), expected ${test.expect}`,
  );
  if (!ok && failures.length > 0) console.log(`        ${failures[0].slice(0, 140)}…`);
}

console.log(
  failed === 0
    ? "\n[sentinel] ✓ fires on a stranded semester, and stays quiet on every legitimate state"
    : `\n[sentinel] ✗ ${failed} case(s) failed, the ledger would not catch a semester left unread`,
);
process.exit(failed === 0 ? 0 : 1);
