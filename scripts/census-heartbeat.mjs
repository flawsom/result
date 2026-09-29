#!/usr/bin/env bun
// The daily automation's own record book.
//
// Three things need to be true at once for this project to keep itself honest
// without anybody watching:
//
//   1. the published measurement is re-checked against the portal, daily;
//   2. the repository keeps receiving commits, because GitHub disables a
//      scheduled workflow after sixty days of repository inactivity, which is
//      exactly what had happened to the crawl's schedule before this existed;
//   3. there is somewhere to look that says the above actually happened, rather
//      than a workflow that claims it in a log nobody reads twice.
//
// This writes that record. It is deliberately *not* the evidence file: the
// measurement says what the university's numbering is, and this says what the
// automation did about it and when. Rewriting the evidence file on every check
// would destroy the distinction between "measured on the 29th" and "confirmed on
// the 3rd", and that distinction is the whole point of publishing a date.
//
//   bun scripts/census-heartbeat.mjs --verified 1103 --changed 0 --crawl dispatched
//
// Any missing flag is recorded as null rather than as zero: "we did not check" and
// "we checked and found nothing" are different facts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MEASURED_AT,
  MEASURED_BLOCKS,
  MEASURED_CHECKED_AT,
  MEASURED_SERIALS,
  MEASURED_STUDENTS,
} from "../src/lib/census-blocks.ts";

const FILE = "docs/census-automation.json";
/** How many daily checks the record keeps. A month is enough to spot a gap. */
const KEEP = 30;

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

function num(value) {
  if (value === null || value === true || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function load() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

const previous = load();
const now = new Date().toISOString();

const entry = {
  at: now,
  /** Readings whose recorded bound was re-confirmed against the portal. */
  verified: num(flag("verified")),
  /** Blocks re-measured because the portal no longer agreed with the reading. */
  changed: num(flag("changed")),
  /** What the record did about the crawl: dispatched, skipped, or failed. */
  crawl: flag("crawl", null),
};

const history = Array.isArray(previous?.history) ? previous.history : [];
history.push(entry);

const record = {
  // What the published page says right now, taken from the module the page
  // imports rather than from a copy, so the two cannot disagree.
  published: {
    blocks: MEASURED_BLOCKS,
    serials: MEASURED_SERIALS,
    students: MEASURED_STUDENTS,
    measuredAt: MEASURED_AT,
    checkedAt: MEASURED_CHECKED_AT,
  },
  lastCheckAt: now,
  /** Consecutive daily checks observed, counting this one. */
  checks: (previous?.checks ?? 0) + 1,
  history: history.slice(-KEEP),
};

mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(FILE, `${JSON.stringify(record, null, 2)}\n`);

console.log(
  `[heartbeat] check ${record.checks} recorded at ${now}, published ` +
    `${record.published.blocks.toLocaleString("en-US")} blocks, ` +
    `${record.published.serials.toLocaleString("en-US")} numbers, ` +
    `${record.published.students.toLocaleString("en-US")} students ` +
    `(measured ${record.published.measuredAt}, checked ${record.published.checkedAt})`,
);
if (entry.changed) {
  console.log(`[heartbeat] ${entry.changed} block(s) moved since the last reading.`);
}
console.log(`[heartbeat] wrote ${FILE}`);
