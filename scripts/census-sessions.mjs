#!/usr/bin/env bun
// Which semester sessions does the portal actually answer for, today?
//
// The census walks registration numbers and reads whatever the portal serves at
// the moment it reads them, which is the right way to measure a population and
// the wrong way to notice a declaration: once a block has been read, the crawl
// moves on, and a semester declared afterwards is invisible to it. This is the
// other half of the census — a small, daily, explicit question.
//
//   For every batch year: take one registration number from a college with a
//   batch that year, and ask the portal for each of the eight sessions the app
//   derives from that batch, by the same `getSemesterSessions` the app uses.
//
// That is about 120 requests. What it produces is a dated statement of fact: on
// 2026-09-29, the portal served 2012's semesters 7 and 8, and everything from
// 2015 on. A session that flips from "not served" to "served" is a declaration,
// and the record keeps the date it was first seen — which is the one thing a
// crawl that reads each serial once can never tell you.
//
// The registration number is never written anywhere. The evidence file records
// the college code the probe used, never the number itself, so this stays a
// statement about the university rather than about a person.
//
//   bun scripts/census-sessions.mjs
//   bun scripts/census-sessions.mjs --years 24,25
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { studentDetails, subjects, setUpstreamLogger } from "../src/lib/bput-upstream.ts";
import { getSemesterSessions } from "../src/lib/bulk/sessions.ts";
import { CENSUS_COLLEGES, CENSUS_YEARS } from "../src/lib/census-blocks.ts";
import { RateGovernor } from "../src/lib/census-core.ts";

const FILE = "docs/census-sessions.json";
/** The module the page imports, so the watch is visible without a fetch. */
const TS_FILE = "src/lib/census-session-watch.ts";
/** This is a handful of requests against a public endpoint; keep it unhurried. */
const RPS = 5;

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const YEARS_ARG = flag("years", null);
const YEARS = (
  YEARS_ARG
    ? String(YEARS_ARG)
        .split(",")
        .map((y) => {
          const n = Number(y.trim());
          return Number.isFinite(n) && n >= 2000 ? n - 2000 : n;
        })
    : [...CENSUS_YEARS]
).filter((y) => Number.isFinite(y) && CENSUS_COLLEGES[y]);

const pad = (value, width) => String(value).padStart(width, "0");
const governor = new RateGovernor(RPS, RPS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { firstCheckedAt: null, checkedAt: null, years: {} };
  }
}

const store = load();
store.years ??= {};

/**
 * One upstream read with a floor under it. A transient failure returns
 * `unreadable` rather than `not_published`: "the portal said no" and "we could not
 * ask" are different answers, and silently merging them would let an outage look
 * like a retention window.
 */
async function ask(roll, semId, session) {
  await governor.acquire();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await subjects({ rollNo: roll, semId, session });
      const rows = Array.isArray(data?.grades) ? data.grades.length : 0;
      governor.onSuccess();
      return rows > 0 ? "published" : "not_published";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("BPUT_NOT_PUBLISHED")) return "not_published";
      if (message.startsWith("BPUT_RATE_LIMITED")) {
        governor.onRateLimited();
        await sleep(governor.backoffMs || 5_000);
        continue;
      }
      if (attempt === 1) return "unreadable";
      await sleep(500);
    }
  }
  return "unreadable";
}

/** A registration number that exists in this batch year, and its college code. */
async function findLiveNumber(year) {
  // Serial 001 is the first student a college admits, so it is the number most
  // likely to exist; trying the next college is cheaper than searching.
  for (const code of (CENSUS_COLLEGES[year] ?? []).slice(0, 10)) {
    const roll = `${pad(year, 2)}01${pad(code, 3)}001`;
    await governor.acquire();
    try {
      const record = await studentDetails(roll);
      if (record?.branchName || record?.courseName) {
        governor.onSuccess();
        return { roll, code };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("BPUT_RATE_LIMITED")) {
        governor.onRateLimited();
        await sleep(governor.backoffMs || 5_000);
      }
    }
  }
  return null;
}

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
// Breadcrumbs would be one line per request in a log nobody reads for them.
setUpstreamLogger(() => {});

const served = {};
for (const year of YEARS) {
  const batchYear = 2000 + year;
  const found = await findLiveNumber(year);
  if (!found) {
    console.log(`[sessions] 20${pad(year, 2)}: no live number found, skipped`);
    continue;
  }
  const plan = getSemesterSessions(batchYear);
  const entry = (store.years[batchYear] ??= { code: found.code, probes: [], firstSeen: {} });
  entry.code = found.code;
  entry.probes = [];

  const live = [];
  for (const step of plan) {
    const state = await ask(found.roll, step.semId, step.session);
    entry.probes.push({ session: step.session, semester: Number(step.semId), state });
    // First sighting only. A session that stops answering keeps the date it was
    // first seen, because that date is the declaration and this is a record of
    // it, not of today's availability.
    if (state === "published") {
      entry.firstSeen[step.semId] ??= today;
      live.push(Number(step.semId));
    }
  }
  served[batchYear] = live;
  entry.served = live;
  entry.checkedAt = now;
  console.log(
    `[sessions] 20${pad(year, 2)} → ${
      live.length === 0 ? "nothing served" : `S${live.join(", S")}`
    }${live.length > 0 && live.length < 8 ? ` (of 8)` : ""}`,
  );
}

store.checkedAt = now;
store.firstCheckedAt ??= now;
mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(FILE, `${JSON.stringify(store, null, 2)}\n`);

/* ───────────────────────────────────── the module the page imports ─── */

const lines = Object.keys(served)
  .map(Number)
  .sort((a, b) => a - b)
  .map((year) => `  ${year}: [${served[year].join(", ")}],`);

const generated = `// Which semester sessions the portal answered for, per batch year.
//
// GENERATED FILE: written by \`bun scripts/census-sessions.mjs\`, which the daily
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
export const SESSION_WATCH_CHECKED_AT = "${today}";

export const SESSION_WATCH: Record<number, readonly number[]> = {
${lines.join("\n")}
};
`;

const previous = (() => {
  try {
    return readFileSync(TS_FILE, "utf8");
  } catch {
    return "";
  }
})();
if (previous === generated) {
  console.log(`[sessions] ${TS_FILE} already matches`);
} else {
  writeFileSync(TS_FILE, generated);
  console.log(`[sessions] rewrote ${TS_FILE}`);
}
console.log(`[sessions] wrote ${FILE}`);
