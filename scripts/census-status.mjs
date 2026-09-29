#!/usr/bin/env bun
// Where is the census, and how much of it is left?
//
// Answers that from the database alone, so it works from the hosted terminal, a
// laptop, or a CI step, and it needs no service key: `census_progress` and
// `get_bput_census` are anon-readable on purpose (they expose counts, never the
// ranges). The service key is used only if it happens to be present.
//
//   bun scripts/census-status.mjs
//   CENSUS_MAX_RPS=16 bun scripts/census-status.mjs   # adds an ETA at that pace
//
// Nothing here is authoritative about progress: the fact table is. This just
// reads it and does the arithmetic out loud.
import { readFileSync } from "node:fs";
import {
  MEASURED_BLOCK_SERIALS,
  MEASURED_INTAKE,
  MEASURED_SERIALS,
  MEASURED_STUDENTS,
  censusBlocks,
  estimatedRequests,
  measuredBlocks,
} from "../src/lib/census-blocks.ts";

/**
 * The dashboard draws the intake distribution from the embedded per-block
 * measurement, so that array has to be the evidence file rather than a copy of
 * it. Re-zip `docs/census-intake.json` in grid order and fail loudly on any
 * disagreement, a drifted constant here would quietly misstate the university.
 */
function checkMeasurement() {
  const raw = readFileSync(new URL("../docs/census-intake.json", import.meta.url), "utf8");
  const evidence = JSON.parse(raw).blocks ?? {};
  const pad = (value, width) => String(value).padStart(width, "0");
  const zip = censusBlocks().map((block) => {
    const key = `${pad(block.year % 100, 2)}-${pad(block.code, 3)}`;
    const rec = evidence[key];
    if (!rec) throw new Error(`docs/census-intake.json has no measurement for ${key}`);
    return Number(rec.serial) || 0;
  });

  if (zip.length !== MEASURED_BLOCK_SERIALS.length) {
    throw new Error(
      `evidence holds ${zip.length} blocks against ${MEASURED_BLOCK_SERIALS.length} embedded`,
    );
  }
  for (let i = 0; i < zip.length; i++) {
    if (zip[i] !== MEASURED_BLOCK_SERIALS[i]) {
      const block = measuredBlocks()[i];
      throw new Error(
        `block ${block?.label ?? i} measured ${zip[i]} in the evidence but ${MEASURED_BLOCK_SERIALS[i]} is embedded`,
      );
    }
  }
  // The per-year summary has to be the same measurement: a year whose declared
  // serial total disagrees with its blocks is a transcription slip.
  for (const [year, intake] of Object.entries(MEASURED_INTAKE)) {
    const rows = measuredBlocks().filter((row) => row.year === Number(year));
    if (rows.length !== intake.blocks) {
      throw new Error(
        `20${year}: ${rows.length} blocks in the grid against ${intake.blocks} declared`,
      );
    }
    const serials = rows.reduce((a, row) => a + row.serial, 0);
    if (serials !== intake.serials) {
      throw new Error(
        `20${year}: ${serials} serials in the grid against ${intake.serials} declared`,
      );
    }
  }
  const sum = MEASURED_BLOCK_SERIALS.reduce((a, b) => a + b, 0);
  if (sum !== MEASURED_SERIALS) {
    throw new Error(`per-block serials sum to ${sum} against MEASURED_SERIALS ${MEASURED_SERIALS}`);
  }
  return { blocks: zip.length, serials: sum };
}

const measured = checkMeasurement();

const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  "";

if (!url || !key) {
  console.error(
    "Missing configuration: set SUPABASE_URL and one of SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(2);
}

const headers = { "Content-Type": "application/json", apikey: key };
// New-format Supabase keys are opaque, not bearer JWTs; sending one as a bearer
// token makes the gateway reject the request.
if (!key.startsWith("sb_publishable_") && !key.startsWith("sb_secret_")) {
  headers.Authorization = `Bearer ${key}`;
}

async function rpc(fn, body = {}) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn} (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const blocks = censusBlocks();
const totalBlocks = blocks.length;
const requests = estimatedRequests();

const progress = await rpc("census_progress");
const census = await rpc("get_bput_census");
const meta = census?.meta ?? {};

const done = progress.doneRanges ?? 0;
const remaining = Math.max(totalBlocks - done, 0);
const pct = totalBlocks > 0 ? (done / totalBlocks) * 100 : 0;

const num = (n) => Number(n ?? 0).toLocaleString();

console.log("BPUT census, status");
console.log(`  blocks finished   ${done}/${totalBlocks}  (${pct.toFixed(1)}%)`);
console.log(`  ranges declared   ${num(progress.ranges)}`);
console.log(
  `  grid measured     ${num(MEASURED_SERIALS)} registration numbers across ` +
    `${num(totalBlocks)} blocks ≈ ${num(MEASURED_STUDENTS)} students (probed, not sampled)`,
);
console.log(
  `  measurement       ${num(measured.blocks)} per-block readings match docs/census-intake.json`,
);
console.log(`  numbers probed    ${num(progress.visited)}`);
console.log(`  genuinely absent  ${num(progress.notFound)}`);
console.log(`  observations      ${num(progress.observations)}`);
console.log(
  `  coverage          ${num(meta.batchYears)} batch years · ${num(meta.semesters)} semesters · ` +
    `${num(meta.branches)} branches · ${num(meta.colleges)} colleges`,
);
console.log(`  last batch        ${progress.lastBatchAt ?? "never"}`);
console.log(`  active now        ${progress.active ? "yes" : "no"}`);

if (done === 0) {
  console.log("\nNo block has finished yet. Until the first batch lands this is expected.");
}

const rps = Number(process.env.CENSUS_MAX_RPS ?? 0);
if (rps > 0) {
  const remainingRequests = Math.round(requests * (remaining / totalBlocks));
  const hours = remainingRequests / rps / 3600;
  console.log(
    `\nETA: ${num(remainingRequests)} requests left at ${rps} req/s → ` +
      (hours < 48 ? `${hours.toFixed(1)} hours` : `${(hours / 24).toFixed(1)} days`),
  );
  console.log(
    `Estimate basis: the grid was measured, not sampled, ${num(MEASURED_SERIALS)} registration numbers ` +
      `in ${num(totalBlocks)} blocks hold ≈ ${num(MEASURED_STUDENTS)} students, at 9 reads each plus a ` +
      `25-probe block tail = ${num(requests)} requests.`,
  );
}
