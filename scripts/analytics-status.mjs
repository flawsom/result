#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// Analytics store — is the live counter actually live?
//
// The live counter is one aggregate row that a database trigger maintains and
// realtime pushes to every open page. Three different things make it read as
// "stuck", and only one of them is a bug:
//
//   1. nobody has looked anything up. The number is real and simply unchanged —
//      the honest state for a quiet site, and the one most likely to be mistaken
//      for a failure.
//   2. the write is being rejected. Lookups happen, rows are dropped, and the
//      only trace is a console warning nobody is reading.
//   3. the row moves but the push never arrives, so pages never update.
//
// This tells those apart. Read-only by default. With `--probe` it performs ONE
// real lookup against the portal, logs it through the same RPC the browser uses,
// and watches the counter move. The probe deliberately makes a real upstream
// request and records its real outcome, latency and row count — a synthetic
// event would leave a number behind that describes nothing, which is the one
// thing this dashboard must never show.
//
//   bun scripts/analytics-status.mjs
//   bun scripts/analytics-status.mjs --probe
//
// Credentials: SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY (falling back to the
// VITE_ names). The publishable key is the browser's own credential — using the
// service-role key here would bypass the grants this exists to test. No key is
// ever printed.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { studentDetails, subjects } from "../src/lib/bput-upstream.ts";
import { getSemesterSessions } from "../src/lib/bulk/sessions.ts";

const PROBE = process.argv.includes("--probe");

const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";
if (!url || !key) {
  console.error("[analytics] SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.");
  process.exit(2);
}

/**
 * PostgREST with `apikey` alone. New-style publishable keys are opaque, not
 * JWTs, and the gateway rejects them when they are also sent as a bearer token —
 * which is exactly why the app's own Supabase client strips that header. Sending
 * it here would test a path the browser never takes.
 */
async function rest(path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

const liveRow = () =>
  rest(
    "analytics_live?id=eq.1&select=events,updated_at,last_year,last_semester,last_outcome,last_latency_ms",
  );

function ago(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ──────────────────────────────────────────────────────── 1 · what it holds ─ */

const before = await liveRow();
if (!before.ok) {
  console.error(`[analytics] analytics_live could not be read (HTTP ${before.status}).`);
  console.error(`            ${JSON.stringify(before.data).slice(0, 300)}`);
  process.exit(2);
}
const row = Array.isArray(before.data) ? before.data[0] : before.data;
const aggregate = await rest("rpc/get_results_analytics_v2", {});
if (!aggregate.ok) {
  console.error(`[analytics] get_results_analytics_v2 failed (HTTP ${aggregate.status}).`);
  console.error(`            ${JSON.stringify(aggregate.data).slice(0, 300)}`);
  process.exit(2);
}
const payload = aggregate.data;
const counts = payload.counts ?? {};
const outcomes = payload.observed?.byOutcome ?? [];
const total = counts.eventsTotal ?? 0;
const unclassified = outcomes.find((o) => o.outcome === "unclassified")?.count ?? 0;

console.log("BPUT analytics — telemetry store");
const lastEventAt = payload.meta?.lastEventAt ?? null;
// The v2 migration seeded the counter row from the event history, which stamps
// the row's own updated_at as the moment of the migration. Reporting that as
// "last event" would date a lookup that never happened.
const seeded =
  row.updated_at && lastEventAt && new Date(row.updated_at) - new Date(lastEventAt) > 60_000;
console.log(
  `  live counter      ${row.events} event(s) · counter row updated ${ago(row.updated_at)}` +
    (seeded ? " (written by the v2 migration, not by a lookup)" : ""),
);
console.log(
  `  last attempt      ${row.last_year ?? "—"} · semester ${row.last_semester ?? "—"} · ` +
    `${row.last_outcome ?? "no classified outcome"}`,
);
console.log(`  recorded events   ${total} over ${payload.meta?.activeDays ?? 0} active day(s)`);
console.log(`  first / last      ${payload.meta?.firstEventAt ?? "—"} → ${lastEventAt ?? "—"}`);
console.log(`  quiet for         ${ago(lastEventAt)}`);
console.log(`  classified        ${total - unclassified} of ${total} carried an outcome`);
console.log(`  last 7 / 24h      ${counts.pulse7d ?? 0} / ${counts.pulse24h ?? 0}`);
console.log(
  `  schema            ${total > 0 && unclassified === total ? "every recorded event predates v2 (no outcome or latency column was filled)" : "v2 events present"}`,
);

/* ────────────────────────────────────────── 2 · does a write still land ────── */

/** One real lookup's worth of observation, from the portal itself. */
async function realObservation() {
  const batchYear = 2012;
  // The 2012 cohort is the earliest in the grid, so its blocks are the ones the
  // measurement is most certain about, and semesters 7-8 are the sessions the
  // session watch still sees the portal serving for it.
  const roll = "1201210998";
  const started = Date.now();
  const details = await studentDetails(roll);
  const branch = details?.branchName || details?.branchId || "UNKNOWN";
  const plan = getSemesterSessions(batchYear).find((p) => p.semId === "7");
  const t0 = Date.now();
  let outcome = "upstream_error";
  let rows = 0;
  let latencyMs = 0;
  try {
    const result = await subjects({ rollNo: roll, semId: plan.semId, session: plan.session });
    latencyMs = Date.now() - t0;
    rows = Array.isArray(result?.grades) ? result.grades.length : 0;
    outcome = rows > 0 ? "published" : "not_published";
  } catch (e) {
    latencyMs = Date.now() - t0;
    const message = (e?.message ?? "").toLowerCase();
    outcome = /timeout|aborted/.test(message)
      ? "timeout"
      : /rate|429/.test(message)
        ? "rate_limited"
        : /unreachable|fetch failed/.test(message)
          ? "unreachable"
          : /malformed|parse/.test(message)
            ? "malformed"
            : "upstream_error";
  }
  return {
    event: {
      year: batchYear,
      semester: 7,
      branch,
      outcome,
      latencyMs,
      attempt: 1,
      source: "live",
      subjects: rows,
    },
    cost: Date.now() - started,
    session: plan.session,
  };
}

if (!PROBE) {
  console.log(
    "\n[analytics] read-only. Run with --probe to verify the write path with one real lookup.",
  );
  process.exit(0);
}

// Subscribe before writing, the way a page does, so the push is observed rather
// than inferred from a later read.
let pushed = null;
let pushStatus = "connecting";
const client = createClient(url, key, { realtime: { params: { eventsPerSecond: 5 } } });
const channel = client
  .channel("analytics-status")
  .on("postgres_changes", { event: "*", schema: "public", table: "analytics_live" }, (msg) => {
    if (pushed === null && typeof msg?.new?.events === "number") {
      pushed = { at: Date.now(), events: msg.new.events };
    }
  })
  .subscribe((status) => {
    pushStatus = status.toLowerCase();
  });
await new Promise((r) => setTimeout(r, 1500));

const observation = await realObservation();
const writeAt = Date.now();
const write = await rest("rpc/log_result_events", { _events: [observation.event] });
const accepted = write.ok && typeof write.data === "number" ? write.data : 0;

console.log("\n[analytics] probe — one real lookup, logged through the browser's own RPC");
console.log(
  `  observation       ${observation.event.year} · semester ${observation.event.semester} · ` +
    `${observation.event.branch} · ${observation.event.outcome} · ${observation.event.latencyMs} ms · ` +
    `${observation.event.subjects} subject row(s) (session ${observation.session}, ${observation.cost} ms)`,
);
console.log(
  `  write             ${write.ok ? `accepted, ${accepted} row(s) stored` : `HTTP ${write.status} — ${JSON.stringify(write.data).slice(0, 200)}`}`,
);

const deadline = Date.now() + 10_000;
while (pushed === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
const after = await liveRow();
const afterRow = Array.isArray(after.data) ? after.data[0] : after.data;

console.log(`  realtime          channel ${pushStatus}`);
if (pushed) {
  console.log(
    `  push              arrived ${pushed.at - writeAt}ms after the write — counter ${pushed.events}`,
  );
} else {
  console.log("  push              no push within 10 s");
}
console.log(
  `  counter           ${row.events} → ${afterRow?.events} (last event ${ago(afterRow?.updated_at)})`,
);

void channel.unsubscribe();

const moved = afterRow && afterRow.events === row.events + accepted && accepted > 0;
if (!write.ok || accepted === 0) {
  console.error("\n[analytics] FAILED — the write path rejected a real observation.");
  process.exit(1);
}
if (!moved) {
  console.error(
    "\n[analytics] FAILED — the row was stored but the live counter did not follow it.",
  );
  process.exit(1);
}
if (!pushed) {
  console.error(
    "\n[analytics] PARTIAL — writes land and the counter follows, but no push was seen here.",
  );
  process.exit(1);
}
console.log(
  "\n[analytics] the counter is live: writes land, the trigger maintains the row, realtime delivers it.",
);
