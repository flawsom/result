#!/usr/bin/env bun
// One bounded slice of the BPUT census, for a scheduler.
//
// This file is a thin shell on purpose. The tick itself lives in
// src/lib/census-headless.ts, where it is typechecked alongside the rest of the
// app and shares its reduction with the in-page runner, so a scheduled crawl and
// a hand-driven one cannot drift apart. A cron needs an entry point and nothing
// else, so it gets one that needs no build step:
//
//   bun scripts/census-tick.mjs
//
// All configuration comes from the environment. With no arguments and no
// scheduler it will exit non-zero naming the key it is missing, which is the
// intended behaviour in a job log nobody is watching.
import { runCensusTickFromEnv } from "../src/lib/census-headless.ts";

try {
  const summary = await runCensusTickFromEnv();
  process.exitCode = summary.status === "failed" ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[census] tick failed: ${message}`);
  process.exitCode = 1;
}
