#!/usr/bin/env bun
// The census rollup's refresh, called from outside the database.
//
// Migration 20261015120000_census_read_path_rollup.sql moves the panels'
// aggregates into a materialized view and gives the fact table's writers a
// statement-level trigger that only *marks* it stale. Ten seconds of aggregation
// inside a crawler's batch would put the crawl behind the same statement timeout
// the migration exists to get off the read path, so the refresh runs as its own
// top-level statement — from pg_cron where that extension is available, and from
// a scheduler running this otherwise.
//
//   bun scripts/census-rollup.mjs            refresh, if a write made it stale
//   bun scripts/census-rollup.mjs --force    recompute now, marker or throttle
//   bun scripts/census-rollup.mjs --status   report freshness, change nothing
//
// The refresh function skips a rollup that nothing has been written to since it
// was measured, so --force marks it stale first and then refreshes: an operator
// asking for a recompute wants one whether or not the marker agrees, which is the
// only way to find out that the marker is wrong.
//
// Exits 0 when the rollup is current (or was made current), 1 if the refresh
// failed or the migration is not applied, 2 if this environment has no
// credentials. Credentials: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. The refresh
// is service_role-only by design: it is seconds of work on a 1.3M-row table, so a
// signed-in user must not be able to ask for it, let alone loop on it.

const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";

if (!url || !key) {
  console.error(
    "Missing configuration: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "The rollup refresh is service_role-only, so a publishable key cannot drive it.",
  );
  process.exit(2);
}

const headers = { "Content-Type": "application/json", apikey: key };
// New-format Supabase keys are opaque, not bearer JWTs; sending one as a bearer
// token makes the gateway reject the request.
if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;

const MIGRATION = "20261015120000_census_read_path_rollup.sql";

async function call(path, init) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers, ...init });
  const body = await res.text();
  if (!res.ok) {
    const error = new Error(`${path} (${res.status}): ${body.slice(0, 300)}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body ? JSON.parse(body) : null;
}

const rpc = (fn, body = {}) => call(`rpc/${fn}`, { method: "POST", body: JSON.stringify(body) });

const num = (n) => Number(n ?? 0).toLocaleString("en-US");

/** A schedule that fires before the migration is applied is not a failure to
 * report as a broken rollup: it is the rollout not being finished. */
function notApplied(err) {
  return (
    err.status === 404 ||
    /PGRST202|does not exist|could not find the function/i.test(err.body ?? "")
  );
}

const status = process.argv.includes("--status");
const force = process.argv.includes("--force");

try {
  if (status) {
    const [state] = await call("census_rollup_state?id=eq.1&select=dirty_at,refreshed_at");
    const payload = await rpc("get_bput_census");
    const meta = payload?.meta ?? {};
    const lag = state?.dirty_at && state?.refreshed_at && state.dirty_at > state.refreshed_at;
    console.log("Census rollup, status");
    console.log(`  observations   ${num(meta.observations)}`);
    console.log(`  measured at    ${meta.generatedAt ?? "never"}`);
    console.log(`  stale          ${lag ? "yes, a write arrived after the last refresh" : "no"}`);
    console.log(`  last refresh   ${state?.refreshed_at ?? "never"}`);
    process.exit(0);
  }

  if (force) {
    // Mark it stale, which is what the fact table's own triggers do on a write.
    await call("census_rollup_state?id=eq.1", {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ dirty_at: new Date().toISOString() }),
    });
  }

  const started = performance.now();
  const refreshed = await rpc("census_rollup_refresh", force ? { _max_age: "0 minutes" } : {});
  const ms = performance.now() - started;

  if (refreshed !== true) {
    console.log(
      `[rollup] current, nothing to do (checked in ${ms.toFixed(0)} ms): nothing has been ` +
        `written since the last refresh, or the throttle window has not elapsed. ` +
        `Pass --force to recompute anyway.`,
    );
    process.exit(0);
  }

  // Read it back through the reader the panel itself uses, so a refresh that
  // succeeded but published nothing usable is still caught here.
  const payload = await rpc("get_bput_census");
  const meta = payload?.meta ?? {};
  console.log(
    `[rollup] refreshed in ${(ms / 1000).toFixed(1)} s; the panel now reports ` +
      `${num(meta.observations)} observations measured at ${meta.generatedAt}.`,
  );
  process.exit(0);
} catch (err) {
  if (notApplied(err)) {
    console.error(
      `[rollup] the census rollup is not on this database yet: apply\n` +
        `         supabase/migrations/${MIGRATION}\n` +
        `         then re-run this. Upstream said: ${err.message}`,
    );
    process.exit(1);
  }
  console.error(`[rollup] refresh failed: ${err.message}`);
  process.exit(1);
}
