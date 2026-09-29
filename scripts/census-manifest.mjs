#!/usr/bin/env bun
// Re-derive the census grid by asking the portal which registration numbers exist.
//
// The committed lists in `src/lib/census-blocks.ts` are a measurement, and a
// measurement you cannot repeat is a rumour. This is the repeat: for every batch
// year it probes one registration number per college code — `YY01CCC001`, the
// first student a college admits — and reports the codes that answered.
//
// Why serial 001 and not a random one: serials run densely from 001, so a code
// that answers at 001 is a college with a batch in that year. The inverse is not
// proven (a college missing its very first student would be missed), which is
// why the runner tolerates empty blocks for free.
//
// Cost: 600 probes × 14 years ≈ 8,400 requests, about 18 minutes at the default
// pace. That is a deliberate one-off, not something the crawl does nightly.
//
//   bun scripts/census-manifest.mjs            # report differences only
//   bun scripts/census-manifest.mjs --write    # print the replacement table
//
// Nothing is written to disk here: the output is meant to be reviewed, because a
// silent rewrite of the grid would let a portal hiccup redefine the population.
import { studentDetails } from "../src/lib/bput-upstream.ts";
import { CENSUS_COLLEGES, CENSUS_YEARS } from "../src/lib/census-blocks.ts";

const CONCURRENCY = 6;
const CODE_MIN = 0;
const CODE_MAX = 599;
const RATE_MS = 40;

const args = new Set(process.argv.slice(2));

function codes(year) {
  const yy = String(year).padStart(2, "0");
  const out = [];
  for (let c = CODE_MIN; c <= CODE_MAX; c++) out.push(`${yy}01${String(c).padStart(3, "0")}001`);
  return out;
}

/** College codes whose first student answers for this batch year. */
async function sweep(year) {
  const queue = codes(year);
  const found = [];
  let index = 0;

  const worker = async () => {
    while (index < queue.length) {
      const roll = queue[index++];
      try {
        await studentDetails(roll);
        found.push(Number(roll.slice(4, 7)));
      } catch {
        // A miss is the common case: 600 codes, ~80 colleges.
      }
      if (RATE_MS > 0) await new Promise((r) => setTimeout(r, RATE_MS));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  found.sort((a, b) => a - b);
  return found;
}

function wrap(list) {
  const lines = [];
  let line = "    ";
  for (const value of list) {
    const piece = `${value}, `;
    if (line.length + piece.length > 98) {
      lines.push(line.trimEnd());
      line = "    ";
    }
    line += piece;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join("\n");
}

let changed = 0;
for (const year of CENSUS_YEARS) {
  const measured = await sweep(year);
  const committed = [...(CENSUS_COLLEGES[year] ?? [])];
  const added = measured.filter((c) => !committed.includes(c));
  const removed = committed.filter((c) => !measured.includes(c));

  if (added.length === 0 && removed.length === 0) {
    console.log(`year ${year}: matches (${measured.length} colleges)`);
    continue;
  }
  changed += 1;
  console.log(
    `year ${year}: ${measured.length} colleges (was ${committed.length})` +
      `${added.length ? ` · added ${added.join(",")}` : ""}` +
      `${removed.length ? ` · removed ${removed.join(",")}` : ""}`,
  );
  if (args.has("--write")) console.log(`  ${year}: [\n${wrap(measured)}\n  ],`);
}

console.log(
  changed === 0
    ? "[census] grid is current."
    : `[census] ${changed} year(s) differ. Review before replacing src/lib/census-blocks.ts.`,
);
