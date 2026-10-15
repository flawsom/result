#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════
//  migrations-verify.mjs — replay every migration, then hold what they create to
//  the contract they claim.
//
//  What it covers
//  --------------
//    roles   the role enum, the census write gate, and the grant list around it
//    census  the panels' readers, the rollup and its refresh driver, the live
//            counter, and the write path: batch caps, row validation, a
//            replacement pass that has to be atomic
//    work    claim-once maintenance passes, the work list's resume arms, and the
//            frontier repair that keeps a finished block from being re-read
//    events  the analytics readers, their gap-filled series, the k-anonymity
//            floor, and the realtime counter row
//
//  Why this exists
//  ---------------
//  supabase/migrations/ is append-only and applied by hand, so a migration that
//  is wrong is discovered in production rather than in CI. Two of the files here
//  rewrite the census read path and add triggers to the fact table; the defects
//  they fix were found by replaying this whole directory into a real Postgres,
//  and this is that replay, kept.
//
//  How it works
//  ------------
//  PGlite is PostgreSQL compiled to WebAssembly: no server, no secret, no
//  network. The migrations go in in filename order, the fact table is seeded,
//  and the result is interrogated. The expected aggregates are recomputed in
//  JavaScript from the same rows, so the checks are an oracle rather than a
//  restatement of the SQL under test.
//
//  Usage
//  -----
//    bun scripts/migrations-verify.mjs                 # 20,000 seeded rows
//    bun scripts/migrations-verify.mjs --rows 150000
//
//  Exit status is 0 only when every migration applied and every check passed.
// ═══════════════════════════════════════════════════════════════════════════
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = resolve(import.meta.dir, "..");

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};

/** `--dir` exists so this can be pointed at a copy, which is how the checks that
 * follow were shown to actually fail when the migrations are wrong. */
const MIGRATIONS_DIR = resolve(argValue("--dir", join(ROOT, "supabase", "migrations")));
const ROWS = Number(argValue("--rows", process.env.MIGRATIONS_VERIFY_ROWS ?? "20000"));
/** What the deployed panel reports, only ever used for the extrapolation note. */
const DEPLOYED_ROWS = 1_313_945;

// ── reporting ─────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function fail(message) {
  throw new Error(message);
}

function trunc(text, max = 420) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function check(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push([name, err.message]);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function acheck(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push([name, err.message]);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

function close(actual, expected, what, tol = 1e-6) {
  if (actual === null || expected === null) return eq(actual, expected, what);
  if (Math.abs(Number(actual) - Number(expected)) > tol) {
    fail(`${what}: expected ${Number(expected)} ± ${tol}, got ${Number(actual)}`);
  }
}

const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canon(v[k])]),
    );
  }
  if (typeof v === "number") return Math.round(v * 1e6) / 1e6;
  return v;
};
const show = (v) => JSON.stringify(canon(v));

function deepEq(actual, expected, what) {
  const a = show(actual);
  const e = show(expected);
  if (a !== e) fail(`${what}\n      expected ${trunc(e)}\n      actual   ${trunc(a)}`);
}

/** Ascending comparator that orders nulls (a NULL college group) last. */
function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}
const byKeys =
  (...keys) =>
  (a, b) => {
    for (const k of keys) {
      const r = cmp(a[k], b[k]);
      if (r !== 0) return r;
    }
    return 0;
  };

/** percentile_cont(0.5) WITHIN GROUP (ORDER BY xs), i.e. linear interpolation. */
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = 0.5 * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** A PostgreSQL error carries a page of detail; the first line names the fault. */
function oneLine(err) {
  const first = String(err?.message ?? err)
    .split("\n")[0]
    .trim();
  return err?.position ? `${first} (at character ${err.position})` : first;
}

const timed = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
};

// ── the database ──────────────────────────────────────────────────────────────

const db = new PGlite();

async function one(sql, params) {
  const { rows } = await db.query(sql, params);
  return rows[0];
}

async function value(sql, params) {
  const row = await one(sql, params);
  return row ? Object.values(row)[0] : undefined;
}

/**
 * The primitives a Supabase project already has and PGlite does not. Nothing
 * here is part of the migration set: it is the floor the migrations stand on.
 */
async function preflight() {
  await db.exec(`
    DO $$ BEGIN CREATE ROLE anon NOLOGIN;            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN;   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role NOLOGIN;   EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE SCHEMA IF NOT EXISTS auth;

    CREATE TABLE IF NOT EXISTS auth.users (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email      text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;

    -- The runner holds the service role; the checks below switch this to 'anon'
    -- to prove the write gate actually closes.
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'service_role')
      $$;

    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
      $$;

    DO $$ BEGIN CREATE PUBLICATION supabase_realtime;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
}

async function replay() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newest = files.slice(-2);
  check("migration filenames are unique and append-only ordered", () => {
    if (files.length === 0) fail("no migrations found");
    const names = files.map((f) => f.replace(/\.sql$/, ""));
    if (new Set(names).size !== names.length) fail("duplicate migration timestamps");
    for (const n of names) {
      if (!/^\d{14}_/.test(n)) fail(`migration name is not timestamp-prefixed: ${n}`);
    }
    const expected = [
      "20261015120000_census_read_path_rollup",
      "20261015121000_census_live_delete_trigger",
    ];
    if (JSON.stringify(newest.map((f) => f.replace(/\.sql$/, ""))) !== JSON.stringify(expected)) {
      fail(`the two newest migrations should sort last, got ${JSON.stringify(newest)}`);
    }
  });

  console.log(`\napplying ${files.length} migrations from ${MIGRATIONS_DIR}`);
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    try {
      const [, ms] = await timed(() => db.exec(sql));
      console.log(`  ✓ ${file} (${ms.toFixed(0)} ms)`);
      if (ms > 60_000) fail(`${file} took ${ms} ms`);
    } catch (err) {
      // A migration that does not apply stops the run, and the run has to name
      // the file that broke rather than unwinding into a parser stack.
      console.log(`  ✗ ${file} did not apply: ${oneLine(err)}`);
      failures.push([file, oneLine(err)]);
      return files.slice(0, files.indexOf(file) + 1);
    }
  }
  return files;
}

async function seed(rows) {
  // One deterministic population: five common branches plus one rare one, four
  // colleges plus the empty (unattributed) college plus one rare one, four batch
  // years, eight semesters, a mix of outcomes, and grade objects that sum to the
  // subject count exactly as the crawler's do.
  await db.exec(`
    WITH src AS (
      SELECT g AS i, (g % 41)::int AS subjects FROM generate_series(1, ${rows}) g
    ),
    graded AS (
      SELECT i, subjects,
             jsonb_build_object(
               'O', subjects / 5, 'E', subjects / 5, 'A', subjects / 5,
               'B', subjects / 5, 'C', subjects - 4 * (subjects / 5)
             ) AS grades
        FROM src
    )
    INSERT INTO public.bput_census_events
      (batch_year, semester, branch, college, college_code, outcome,
       subjects, credits, points, grades, served_at)
    SELECT
      2020 + (i % 4),
      (1 + (i % 8))::smallint,
      CASE WHEN i % 997 = 0 THEN 'AE'
           ELSE (ARRAY['CSE', 'ECE', 'ME', 'CE', 'IT'])[1 + (i % 5)] END,
      CASE WHEN i % 401 = 0 THEN 'Rare College'
           ELSE (ARRAY['', 'College A', 'College B', 'College C'])[1 + (i % 4)] END,
      (100 + (i % 6))::smallint,
      (ARRAY['published', 'published', 'published', 'not_published', 'failed',
             'unreachable'])[1 + (i % 6)],
      subjects::smallint,
      (subjects * 3)::smallint,
      ((subjects * 9) % 401)::smallint,
      grades,
      now() - (i % 1000) * interval '1 second'
    FROM graded;
  `);
}

// ── the oracle: the same rows, aggregated in JavaScript ───────────────────────

async function oracle() {
  const { rows } = await db.query(
    `SELECT batch_year, semester, branch, college, outcome, subjects, points, grades
       FROM public.bput_census_events`,
  );

  const rowsFor = (predicate) => rows.filter(predicate);
  const p50 = (xs, pick) => median(xs.map(pick));

  const byYear = [...new Set(rows.map((r) => r.batch_year))]
    .sort((a, b) => a - b)
    .map((year) => {
      const group = rowsFor((r) => r.batch_year === year);
      return {
        batchYear: year,
        observations: group.length,
        published: group.filter((r) => r.outcome === "published").length,
        subjectsP50: p50(group, (r) => r.subjects),
      };
    });

  const bySemester = [...new Set(rows.map((r) => r.semester))]
    .sort((a, b) => a - b)
    .map((sem) => {
      const group = rowsFor((r) => r.semester === sem);
      return {
        semester: sem,
        observations: group.length,
        published: group.filter((r) => r.outcome === "published").length,
        subjectsP50: p50(group, (r) => r.subjects),
        pointsP50: p50(group, (r) => r.points),
      };
    });

  /** k-anonymity: a group under 25 observations is pooled into 'Other'. */
  const pool = (keyOf, valueOf) => {
    const raw = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      if (!raw.has(key)) raw.set(key, []);
      raw.get(key).push(r);
    }
    const groups = new Map();
    for (const [key, group] of raw) {
      const target = group.length >= 25 ? key : "Other";
      if (!groups.has(target)) groups.set(target, { observations: 0, published: 0, p50: [] });
      const acc = groups.get(target);
      acc.observations += group.length;
      acc.published += group.filter((r) => r.outcome === "published").length;
      acc.p50.push(p50(group, (r) => r.subjects));
      if (valueOf) valueOf(key, group);
    }
    return [...groups.entries()].map(([key, acc]) => ({
      key,
      observations: acc.observations,
      published: acc.published,
      subjectsP50: Math.max(...acc.p50),
    }));
  };

  const byBranch = pool((r) => r.branch).map((g) => ({
    branch: g.key,
    observations: g.observations,
    published: g.published,
    subjectsP50: g.subjectsP50,
  }));

  const byCollege = pool((r) => (r.college === "" ? null : r.college)).map((g) => ({
    college: g.key === undefined ? null : g.key,
    observations: g.observations,
    published: g.published,
  }));

  const countBy = (keyOf) => {
    const counts = new Map();
    for (const r of rows) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1);
    return counts;
  };

  const outcomes = [...countBy((r) => r.outcome)].map(([outcome, n]) => ({ outcome, n }));

  const grades = (() => {
    const counts = new Map();
    for (const r of rows) {
      for (const [grade, n] of Object.entries(r.grades ?? {})) {
        counts.set(grade, (counts.get(grade) ?? 0) + Number(n));
      }
    }
    return [...counts].map(([grade, n]) => ({ grade, n }));
  })();

  const branchYear = [...countBy((r) => `${r.batch_year}|${r.branch}`)].map(
    ([key, observations]) => {
      const [batchYear, branch] = key.split("|");
      return { batchYear: Number(batchYear), branch, observations };
    },
  );

  return {
    rows: rows.length,
    subjects: rows.reduce((acc, r) => acc + Number(r.subjects), 0),
    meta: {
      observations: rows.length,
      batchYears: new Set(rows.map((r) => r.batch_year)).size,
      semesters: new Set(rows.map((r) => r.semester)).size,
      branches: new Set(rows.map((r) => r.branch)).size,
      colleges: new Set(rows.filter((r) => r.college !== "").map((r) => r.college)).size,
      minBatchYear: Math.min(...rows.map((r) => r.batch_year)),
      maxBatchYear: Math.max(...rows.map((r) => r.batch_year)),
    },
    byYear,
    bySemester,
    byBranch: byBranch.sort(byKeys("branch")),
    byCollege: byCollege.sort(byKeys("college")),
    outcomes: outcomes.sort(byKeys("outcome")),
    grades: grades.sort(byKeys("grade")),
    branchYear: branchYear.sort(byKeys("batchYear", "branch")),
  };
}

// ── the checks ────────────────────────────────────────────────────────────────

const forceRefresh = () => db.exec(`SELECT public.census_rollup_refresh('0 minutes')`);
const census = () => value("SELECT public.get_bput_census()");
const progress = () => value("SELECT public.census_progress()");

async function checkEmptyDatabase() {
  console.log("\nempty database");
  await acheck("get_bput_census() answers on an empty fact table", async () => {
    const payload = await census();
    deepEq(
      Object.keys(payload).sort(),
      [
        "branchYear",
        "byBranch",
        "byCollege",
        "bySemester",
        "byYear",
        "grades",
        "meta",
        "outcomes",
        "progress",
      ],
      "top-level keys",
    );
    eq(payload.meta.observations, 0, "meta.observations");
    deepEq(payload.byYear, [], "byYear");
    deepEq(payload.bySemester, [], "bySemester");
    deepEq(payload.grades, [], "grades");
  });

  await acheck("census_progress() answers on an empty cursor table", async () => {
    const p = await progress();
    eq(p.ranges, 0, "ranges");
    eq(p.doneRanges, 0, "doneRanges");
    eq(p.visited, 0, "visited");
    eq(p.observations, 0, "observations");
    eq(p.active, false, "active");
  });
}

const ADMIN_ID = "00000000-0000-0000-0000-0000000000a1";

async function checkAuthRoles() {
  console.log("");
  console.log("roles and the write gate");

  await acheck("the role enum is exactly what the migrations declare", async () => {
    const labels = await value(
      "SELECT array_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'public.app_role'::regtype",
    );
    deepEq(labels, ["admin", "viewer"], "public.app_role");
  });

  await acheck("an anonymous session cannot write census data", async () => {
    await db.exec("SET request.jwt.claim.role = 'anon'");
    eq(await value("SELECT public.census_can_write()"), false, "census_can_write() as anon");
  });

  await acheck("a signed-in user with no admin role cannot write census data", async () => {
    await db.exec("SET request.jwt.claim.role = 'authenticated'");
    eq(
      await value("SELECT public.census_can_write()"),
      false,
      "census_can_write() as authenticated",
    );
  });

  await acheck("an admin session can write census data", async () => {
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES ('${ADMIN_ID}', 'admin@example.com')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_ID}', 'admin')
        ON CONFLICT (user_id, role) DO NOTHING;
      SET request.jwt.claim.role = 'authenticated';
      SET request.jwt.claim.sub = '${ADMIN_ID}';
    `);
    eq(await value("SELECT public.census_can_write()"), true, "census_can_write() as an admin");
    eq(
      await value("SELECT public.has_role($1::uuid, 'admin'::public.app_role)", [ADMIN_ID]),
      true,
      "has_role for a granted role",
    );
    eq(
      await value("SELECT public.has_role($1::uuid, 'viewer'::public.app_role)", [ADMIN_ID]),
      false,
      "has_role for an ungranted role",
    );
  });

  await acheck("the role check itself is service_role-only", async () => {
    for (const role of ["anon", "authenticated"]) {
      eq(
        await value(
          `SELECT has_function_privilege('${role}', 'public.has_role(uuid, public.app_role)', 'EXECUTE')`,
        ),
        false,
        `${role} EXECUTE on has_role`,
      );
    }
    eq(
      await value(
        "SELECT has_function_privilege('service_role', 'public.has_role(uuid, public.app_role)', 'EXECUTE')",
      ),
      true,
      "service_role EXECUTE on has_role",
    );
    // Back to the runner, and drop the admin identity with it.
    await db.exec("SET request.jwt.claim.sub = ''");
    await db.exec("SET request.jwt.claim.role = 'service_role'");
  });

  await acheck("a role cannot be granted to the same user twice", async () => {
    let rejected = false;
    try {
      await db.exec(
        `INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_ID}', 'admin')`,
      );
    } catch {
      rejected = true;
    }
    eq(rejected, true, "a duplicate (user, role) was accepted");
  });
}

async function checkAnalytics() {
  console.log("");
  console.log("analytics readers");

  await acheck("v2 fills its time series instead of dropping empty buckets", async () => {
    const payload = await value("SELECT public.get_results_analytics_v2()");
    eq(payload.meta.schema, "v2", "meta.schema");
    eq(Number(payload.counts.eventsTotal), 0, "eventsTotal on an untouched event stream");
    eq(payload.observed.daily.length, 90, "daily buckets, one per day for 90 days");
    eq(payload.observed.hourly.length, 48, "hourly buckets, one per hour for 48 hours");
    eq(
      payload.observed.daily.every((d) => Number(d.total) === 0 && Number(d.published) === 0),
      true,
      "daily buckets are explicit zeros, not missing rows",
    );
    eq(
      payload.observed.hourly.every((h) => Number(h.count) === 0),
      true,
      "hourly buckets are explicit zeros",
    );
  });

  await acheck("v2 reports observed traffic only, never the modelled series", async () => {
    const seeded = Number(await value("SELECT COALESCE(SUM(count), 0) FROM public.analytics_seed"));
    eq(seeded > 0, true, "analytics_seed holds a series that could be mistaken for a measurement");
    const payload = await value("SELECT public.get_results_analytics_v2()");
    eq(Number(payload.counts.eventsTotal), 0, "eventsTotal counts the seed");
    eq(payload.observed.byYear.length, 0, "byYear reads the seed");
    eq(payload.observed.branchYear.length, 0, "branchYear reads the seed");
  });

  await acheck("v1 still folds the seed into its own total", async () => {
    const seeded = Number(await value("SELECT COALESCE(SUM(count), 0) FROM public.analytics_seed"));
    const payload = await value("SELECT public.get_results_analytics()");
    eq(Number(payload.total), seeded, "v1 total with no live events");
  });

  await acheck("log_result_events drops bad rows and clamps the rest", async () => {
    const stored = await value("SELECT public.log_result_events($1::jsonb)", [
      JSON.stringify([
        { year: 1800, semester: 1, branch: "CSE" },
        { year: 2024, semester: 99, branch: "CSE" },
        { year: 2024, semester: 1, branch: "   " },
        {
          year: 2024,
          semester: 1,
          branch: "CSE",
          outcome: "weird",
          latencyMs: 999999,
          attempt: 99,
          source: "nope",
          subjects: 999,
        },
      ]),
    ]);
    eq(Number(stored), 1, "rows stored");
    const row = await one(
      "SELECT year, semester, branch, outcome, latency_ms, attempt, source, subjects FROM public.analytics_events ORDER BY id DESC LIMIT 1",
    );
    eq(Number(row.year), 2024, "year");
    eq(row.branch, "CSE", "branch");
    eq(row.outcome, "unclassified", "an unknown outcome is labelled, never stored as itself");
    eq(Number(row.latency_ms), 600000, "latency is clamped to ten minutes");
    eq(Number(row.attempt), 16, "attempt is clamped to the session probe ceiling");
    eq(row.source, "unknown", "source");
    eq(Number(row.subjects), 200, "subjects");
  });

  await acheck("log_result_events caps one flush at 64 attempts", async () => {
    const rows = Array.from({ length: 70 }, () => ({ year: 2024, semester: 3, branch: "ECE" }));
    eq(
      Number(await value("SELECT public.log_result_events($1::jsonb)", [JSON.stringify(rows)])),
      64,
      "rows stored",
    );
    eq(
      Number(await value("SELECT COUNT(*) FROM public.analytics_events WHERE semester = 3")),
      64,
      "rows on the table for that flush",
    );
  });

  await acheck("v2 folds branch buckets below the k-anonymity floor", async () => {
    const { rows } = await db.query(
      "SELECT branch, COUNT(*) AS n FROM public.analytics_events GROUP BY 1",
    );
    const expected = new Map();
    for (const row of rows) {
      const bucket = Number(row.n) >= 25 ? row.branch : "Other";
      expected.set(bucket, (expected.get(bucket) ?? 0) + Number(row.n));
    }
    const payload = await value("SELECT public.get_results_analytics_v2()");
    const actual = payload.observed.byBranch
      .map((b) => ({ branch: b.branch, count: Number(b.count) }))
      .sort(byKeys("branch"));
    deepEq(
      actual,
      [...expected.entries()].map(([branch, count]) => ({ branch, count })).sort(byKeys("branch")),
      "byBranch",
    );
    const belowFloor = actual.filter((b) => b.count < 25 && b.branch !== "Other");
    deepEq(belowFloor, [], "buckets below the floor that were not pooled");
  });

  await acheck("the live counter follows the event stream", async () => {
    const events = Number(await value("SELECT COUNT(*) FROM public.analytics_events"));
    const live = await one(
      "SELECT events, last_year, last_semester FROM public.analytics_live WHERE id = 1",
    );
    eq(Number(live.events), events, "analytics_live.events against COUNT(*)");
    eq(Number(live.last_year), 2024, "last_year");
    eq(Number(live.last_semester), 3, "last_semester");
  });

  await acheck("the event stream stays closed while the counter stays readable", async () => {
    for (const role of ["anon", "authenticated"]) {
      eq(
        await value(`SELECT has_table_privilege('${role}', 'public.analytics_events', 'SELECT')`),
        false,
        `${role} SELECT on analytics_events`,
      );
      eq(
        await value(`SELECT has_table_privilege('${role}', 'public.analytics_live', 'SELECT')`),
        true,
        `${role} SELECT on analytics_live`,
      );
      eq(
        await value(
          `SELECT has_function_privilege('${role}', 'public.log_result_events(jsonb)', 'EXECUTE')`,
        ),
        true,
        `${role} EXECUTE on log_result_events`,
      );
      eq(
        await value(
          `SELECT has_function_privilege('${role}', 'public.get_results_analytics_v2()', 'EXECUTE')`,
        ),
        true,
        `${role} EXECUTE on get_results_analytics_v2`,
      );
    }
  });
}

async function checkCensusWritePath() {
  console.log("");
  console.log("census write path");

  await acheck("log_census_events drops invalid rows and reports what it stored", async () => {
    const stored = await value("SELECT public.log_census_events($1::jsonb)", [
      JSON.stringify([
        { batchYear: 1800, semester: 1, branch: "CSE" },
        { batchYear: 2025, semester: 1, branch: "   " },
        {
          batchYear: 2025,
          semester: 1,
          collegeCode: 900,
          branch: "CSE",
          outcome: "nonsense",
          subjects: 6,
        },
      ]),
    ]);
    eq(Number(stored), 1, "rows stored");
    const row = await one(
      "SELECT college_code, outcome, subjects FROM public.bput_census_events ORDER BY id DESC LIMIT 1",
    );
    eq(Number(row.college_code), 900, "the block the row was stamped with");
    eq(row.outcome, "failed", "an unknown outcome falls back rather than being stored");
  });

  await acheck("log_census_events caps one batch at 200 rows", async () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({
      batchYear: 2025,
      semester: 2,
      collegeCode: 901,
      branch: "CSE",
      college: "College X",
      outcome: "published",
      subjects: i % 7,
      credits: 18,
      points: 42,
      grades: { O: i % 7 },
    }));
    eq(
      Number(await value("SELECT public.log_census_events($1::jsonb)", [JSON.stringify(rows)])),
      200,
      "rows stored from a 205-row batch",
    );
    eq(
      Number(
        await value("SELECT COUNT(*) FROM public.bput_census_events WHERE college_code = 901"),
      ),
      200,
      "rows on the table for that batch",
    );
  });

  await acheck("a pass that cannot store every row leaves the block untouched", async () => {
    // census_apply_pass deletes the block's rows and then stores the re-read. If
    // the store refuses any row the whole thing has to roll back: a semester that
    // is deleted without being replaced is a hole where a published figure was,
    // and that is worse than not having re-read it at all.
    const block = await one(`
      SELECT batch_year, semester, college_code, COUNT(*) AS n
        FROM public.bput_census_events
       GROUP BY 1, 2, 3 HAVING COUNT(*) >= 10 ORDER BY 4 DESC LIMIT 1
    `);
    if (!block) fail("the seed produced no block big enough to replace");
    const before = Number(await value("SELECT COUNT(*) FROM public.bput_census_events"));
    const rows = [
      {
        batchYear: block.batch_year,
        semester: block.semester,
        collegeCode: block.college_code,
        branch: "CSE",
        college: "College A",
        outcome: "published",
        subjects: 6,
      },
      // One row the store will refuse, which is what makes the pass fail.
      { batchYear: block.batch_year, semester: 99, collegeCode: block.college_code, branch: "CSE" },
    ];
    let raised = false;
    try {
      await value("SELECT public.census_apply_pass($1, $2, $3::smallint, $4::jsonb)", [
        block.batch_year,
        block.college_code,
        block.semester,
        JSON.stringify(rows),
      ]);
    } catch (err) {
      raised = true;
      if (!/rolled back/i.test(String(err.message))) fail(`unexpected error: ${oneLine(err)}`);
    }
    eq(raised, true, "a pass that stored fewer rows than it was given did not raise");
    eq(
      Number(await value("SELECT COUNT(*) FROM public.bput_census_events")),
      before,
      "fact table after the rolled-back pass",
    );
    eq(
      Number(await value("SELECT observations FROM public.census_live WHERE id = 1")),
      before,
      "counter after the rolled-back pass",
    );
  });

  await acheck("a maintenance pass can be claimed exactly once", async () => {
    await db.exec(`
      INSERT INTO public.census_block_walk
        (year, code, max_serial, serial_offset, first_pass_at, first_pass_sessions)
      VALUES (2024, 700, 300, 300, now(), '{1,2}'::smallint[])
      ON CONFLICT (year, code) DO UPDATE
        SET max_serial = EXCLUDED.max_serial,
            serial_offset = EXCLUDED.serial_offset,
            first_pass_at = EXCLUDED.first_pass_at,
            first_pass_sessions = EXCLUDED.first_pass_sessions;
    `);
    eq(await value("SELECT public.census_claim_pass(2024, 700, 3::smallint)"), true, "first claim");
    eq(
      await value("SELECT public.census_claim_pass(2024, 700, 3::smallint)"),
      false,
      "a second claim while the first is in flight",
    );
    eq(
      await value("SELECT public.census_claim_pass(2024, 700, 1::smallint)"),
      false,
      "a semester the first pass already captured",
    );
    eq(
      await value("SELECT public.census_claim_pass(2024, 701, 3::smallint)"),
      false,
      "a block the ledger does not have",
    );
    await db.exec("SELECT public.census_report_pass(2024, 700, 3::smallint, 'failed')");
    eq(
      await value("SELECT public.census_claim_pass(2024, 700, 3::smallint)"),
      true,
      "retry after a failure",
    );
  });

  await acheck("the work list reschedules a block only where it can resume", async () => {
    await db.exec(`
      INSERT INTO public.census_block_walk
        (year, code, max_serial, serial_offset, first_pass_at, first_pass_sessions, frontier)
      VALUES
        (2023, 100, 300, 300, now(), '{1}'::smallint[], 300),
        (2023, 101, 400, 400, now(), '{1}'::smallint[], 350),
        (2023, 102, 250, 250, now(), '{1}'::smallint[], 0)
      ON CONFLICT (year, code) DO UPDATE
        SET max_serial = EXCLUDED.max_serial,
            serial_offset = EXCLUDED.serial_offset,
            first_pass_at = EXCLUDED.first_pass_at,
            first_pass_sessions = EXCLUDED.first_pass_sessions,
            frontier = EXCLUDED.frontier;
      INSERT INTO public.census_session_watch (year, semesters) VALUES (2023, '{1,5}'::smallint[])
        ON CONFLICT (year) DO UPDATE SET semesters = EXCLUDED.semesters;
    `);
    const { rows } = await db.query(
      "SELECT year, code, semester, serial_offset, serials_left FROM public.census_work WHERE year = 2023",
    );
    const actual = rows
      .map((r) => ({
        code: Number(r.code),
        semester: r.semester === null ? null : Number(r.semester),
        serialOffset: Number(r.serial_offset),
        serialsLeft: Number(r.serials_left),
      }))
      .sort(byKeys("code", "semester"));
    // Sorted with the same comparator as the actual rows, so a difference in
    // ordering between the view and this list cannot be mistaken for a defect.
    const expected = [
      // Finished and unchanged: nothing above the frontier, so not work.
      // A block can still owe a semester the portal only now serves.
      { code: 100, semester: 5, serialOffset: 0, serialsLeft: 300 },
      // The measurement moved past the frontier: resume at the frontier, which
      // has never produced a row, so this cannot duplicate one.
      { code: 101, semester: null, serialOffset: 350, serialsLeft: 50 },
      { code: 101, semester: 5, serialOffset: 0, serialsLeft: 350 },
      { code: 102, semester: 5, serialOffset: 0, serialsLeft: 0 },
    ].sort(byKeys("code", "semester"));
    deepEq(actual, expected, "census_work for 2023");
  });

  await acheck("a settled semester reopens after thirty days, not before", async () => {
    await db.exec(`
      INSERT INTO public.census_pass (year, code, semester, status)
      VALUES (2023, 100, 5, 'done')
      ON CONFLICT (year, code, semester) DO UPDATE SET status = 'done', updated_at = now();
    `);
    eq(
      Number(
        await value(
          "SELECT COUNT(*) FROM public.census_work WHERE year = 2023 AND code = 100 AND semester = 5",
        ),
      ),
      0,
      "a semester closed today",
    );
    await db.exec(
      "UPDATE public.census_pass SET updated_at = now() - interval '31 days' WHERE year = 2023 AND code = 100 AND semester = 5",
    );
    eq(
      Number(
        await value(
          "SELECT COUNT(*) FROM public.census_work WHERE year = 2023 AND code = 100 AND semester = 5",
        ),
      ),
      1,
      "the same semester a month later",
    );
  });

  await acheck("the frontier repair writes back only where a frontier is missing", async () => {
    // The repair is what stops a finished block from being walked from serial 001
    // and appending a second copy of observations the table cannot deduplicate.
    const repair = readFileSync(
      join(MIGRATIONS_DIR, "20260929223000_census_frontier_repair.sql"),
      "utf8",
    );
    await db.exec(repair);
    const repaired = await one(
      "SELECT frontier, max_serial FROM public.census_block_walk WHERE year = 2023 AND code = 102",
    );
    eq(
      Number(repaired.frontier),
      Number(repaired.max_serial),
      "a finished block's frontier is its bound",
    );
    eq(
      Number(
        await value(
          "SELECT COUNT(*) FROM public.census_work WHERE year = 2023 AND code = 102 AND semester IS NULL",
        ),
      ),
      0,
      "a repaired block is not walked again",
    );
    const untouched = await one(
      "SELECT frontier FROM public.census_block_walk WHERE year = 2023 AND code = 101",
    );
    eq(Number(untouched.frontier), 350, "a frontier that was already recorded is left alone");
  });
}

async function checkCounter() {
  console.log("\nlive counter");
  const count = () => value("SELECT COUNT(*) FROM public.bput_census_events");

  await acheck("the counter equals the fact table, row for row", async () => {
    const actual = Number(await count());
    eq(actual > 0, true, "the fact table has rows to count");
    eq(
      Number(await value("SELECT observations FROM public.census_live WHERE id = 1")),
      actual,
      "census_live.observations against COUNT(*)",
    );
  });

  await acheck("census_live_recount() returns and repairs the true count", async () => {
    const actual = Number(await count());
    await db.exec("UPDATE public.census_live SET observations = 1 WHERE id = 1");
    eq(
      Number(await value("SELECT public.census_live_recount()")),
      actual,
      "recount() return value",
    );
    eq(
      Number(await value("SELECT observations FROM public.census_live WHERE id = 1")),
      actual,
      "counter after recount",
    );
  });

  // The defect this migration exists for: a maintenance pass DELETEs the rows it
  // replaces, and before the delete trigger the counter only ever climbed.
  await acheck("a replacement pass lowers the counter to the true count", async () => {
    const before = Number(await count());
    const block = await one(
      `SELECT batch_year, semester, college_code, COUNT(*) AS n
         FROM public.bput_census_events
        GROUP BY 1, 2, 3 HAVING COUNT(*) > 200 ORDER BY 4 DESC LIMIT 1`,
    );
    if (!block) fail("seed did not produce a block large enough to replace");
    // A re-read that finds fewer students than last time, which is exactly the
    // case that used to leave the counter high forever.
    const replacement = Array.from({ length: Math.floor(block.n / 2) }, (_, i) => ({
      batchYear: block.batch_year,
      semester: block.semester,
      collegeCode: block.college_code,
      branch: "CSE",
      college: "College A",
      outcome: "published",
      subjects: 6,
      credits: 18,
      points: 42,
      grades: { O: 2, A: 4 },
    }));
    const stored = await value("SELECT public.census_apply_pass($1, $2, $3, $4::jsonb)", [
      block.batch_year,
      block.college_code,
      block.semester,
      JSON.stringify(replacement),
    ]);
    eq(Number(stored), replacement.length, "rows stored by the pass");
    const after = Number(await count());
    eq(after, before - Number(block.n) + replacement.length, "fact table after the pass");
    eq(
      Number(await value("SELECT observations FROM public.census_live WHERE id = 1")),
      after,
      "counter after the pass",
    );
  });

  await acheck("the counter cannot go negative on a delete", async () => {
    // A counter that is already behind must not turn a data problem into a
    // failed maintenance pass: the column has a CHECK, so this is the guard.
    await db.exec("UPDATE public.census_live SET observations = 0 WHERE id = 1");
    const block = await one(
      `SELECT batch_year, semester, college_code FROM public.bput_census_events
        ORDER BY id LIMIT 1`,
    );
    await db.exec(
      `DELETE FROM public.bput_census_events
        WHERE batch_year = ${block.batch_year}
          AND semester = ${block.semester}
          AND college_code = ${block.college_code}`,
    );
    eq(
      Number(await value("SELECT observations FROM public.census_live WHERE id = 1")),
      0,
      "counter",
    );
    await db.exec("SELECT public.census_live_recount()");
  });

  await acheck("the write gate refuses an anonymous session", async () => {
    await db.exec("SET request.jwt.claim.role = 'anon'");
    try {
      await db.exec("SELECT public.census_apply_pass(2020, 100, 1::smallint, '[]'::jsonb)");
      fail("an anonymous session was allowed to write");
    } catch (err) {
      if (!/not permitted/i.test(err.message)) fail(`unexpected error: ${err.message}`);
    } finally {
      await db.exec("SET request.jwt.claim.role = 'service_role'");
    }
  });
}

async function checkReadPath(truth) {
  console.log("\nread path");

  await acheck("forced refresh makes the payload agree with the fact table", async () => {
    await forceRefresh();
    const payload = await census();
    const { meta } = payload;
    eq(meta.schema, "census1", "meta.schema");
    eq(meta.kAnonymity, 25, "meta.kAnonymity");
    eq(Number(meta.observations), truth.meta.observations, "meta.observations");
    eq(Number(meta.batchYears), truth.meta.batchYears, "meta.batchYears");
    eq(Number(meta.semesters), truth.meta.semesters, "meta.semesters");
    eq(Number(meta.branches), truth.meta.branches, "meta.branches");
    eq(Number(meta.colleges), truth.meta.colleges, "meta.colleges");
    eq(Number(meta.minBatchYear), truth.meta.minBatchYear, "meta.minBatchYear");
    eq(Number(meta.maxBatchYear), truth.meta.maxBatchYear, "meta.maxBatchYear");
  });

  await acheck("byYear matches the oracle, medians included", async () => {
    const { byYear } = await census();
    deepEq(
      byYear.map((g) => ({
        batchYear: g.batchYear,
        observations: Number(g.observations),
        published: Number(g.published),
        subjectsP50: Number(g.subjectsP50),
      })),
      truth.byYear,
      "byYear",
    );
  });

  await acheck("bySemester matches the oracle, medians included", async () => {
    const { bySemester } = await census();
    deepEq(
      bySemester.map((g) => ({
        semester: Number(g.semester),
        observations: Number(g.observations),
        published: Number(g.published),
        subjectsP50: Number(g.subjectsP50),
        pointsP50: Number(g.pointsP50),
      })),
      truth.bySemester,
      "bySemester",
    );
  });

  await acheck("byBranch matches the oracle and pools small branches", async () => {
    const { byBranch } = await census();
    const actual = byBranch
      .map((g) => ({
        branch: g.branch,
        observations: Number(g.observations),
        published: Number(g.published),
        subjectsP50: Number(g.subjectsP50),
      }))
      .sort(byKeys("branch"));
    deepEq(actual, truth.byBranch, "byBranch");
    const pooled = actual.filter((g) => g.observations < 25 && g.branch !== "Other");
    deepEq(pooled, [], "branches below the k-anonymity floor that were not pooled");
  });

  await acheck("byCollege matches the oracle and pools small colleges", async () => {
    const { byCollege } = await census();
    const actual = byCollege
      .map((g) => ({
        college: g.college ?? null,
        observations: Number(g.observations),
        published: Number(g.published),
      }))
      .sort(byKeys("college"));
    deepEq(actual, truth.byCollege, "byCollege");
    const pooled = actual.filter((g) => g.observations < 25 && g.college !== "Other");
    deepEq(pooled, [], "colleges below the k-anonymity floor that were not pooled");
  });

  await acheck("outcomes, grades and branchYear match the oracle", async () => {
    const payload = await census();
    deepEq(
      payload.outcomes.map((g) => ({ outcome: g.outcome, n: Number(g.n) })).sort(byKeys("outcome")),
      truth.outcomes,
      "outcomes",
    );
    deepEq(
      payload.grades.map((g) => ({ grade: g.grade, n: Number(g.n) })).sort(byKeys("grade")),
      truth.grades,
      "grades",
    );
    const branchYear = payload.branchYear
      .map((g) => ({
        batchYear: Number(g.batchYear),
        branch: g.branch,
        observations: Number(g.observations),
      }))
      .sort(byKeys("batchYear", "branch"));
    deepEq(branchYear, truth.branchYear, "branchYear");
  });

  await acheck("every bucket total adds up to the observation count", async () => {
    const payload = await census();
    const sum = (xs, pick) => xs.reduce((acc, x) => acc + Number(pick(x)), 0);
    const total = Number(payload.meta.observations);
    eq(
      sum(payload.byYear, (g) => g.observations),
      total,
      "byYear total",
    );
    eq(
      sum(payload.bySemester, (g) => g.observations),
      total,
      "bySemester total",
    );
    eq(
      sum(payload.byBranch, (g) => g.observations),
      total,
      "byBranch total",
    );
    eq(
      sum(payload.byCollege, (g) => g.observations),
      total,
      "byCollege total",
    );
    eq(
      sum(payload.branchYear, (g) => g.observations),
      total,
      "branchYear total",
    );
    eq(
      sum(payload.outcomes, (g) => g.n),
      total,
      "outcomes total",
    );
    eq(
      sum(payload.grades, (g) => g.n),
      truth.subjects,
      "grade counts against subject counts",
    );
  });

  await acheck("the payload documents when it was measured", async () => {
    await forceRefresh();
    const measured = await value("SELECT generated_at FROM public.bput_census_rollup WHERE id = 1");
    const payload = await census();
    const generatedAt = new Date(payload.meta.generatedAt).getTime();
    close(
      generatedAt,
      new Date(measured).getTime(),
      "meta.generatedAt against the rollup row",
      1500,
    );
  });

  // The aggregate is seconds of work on the live table. If it ran inside a write
  // transaction the crawler would inherit the statement timeout this migration
  // exists to get off the read path, so the write path may only *mark* staleness.
  const WRITE_BATCH = 500;
  await acheck("a write marks the rollup stale instead of refreshing it", async () => {
    await forceRefresh();
    const before = await one("SELECT generated_at FROM public.bput_census_rollup WHERE id = 1");
    const state = await one(
      "SELECT dirty_at, refreshed_at FROM public.census_rollup_state WHERE id = 1",
    );
    if (!(state.dirty_at <= state.refreshed_at)) fail("the rollup did not start clean");

    const counted = Number(await value("SELECT COUNT(*) FROM public.bput_census_events"));
    await db.exec(`
      INSERT INTO public.bput_census_events
        (batch_year, semester, branch, college, college_code, outcome, subjects, credits, points, grades)
      SELECT 2020, 1, 'CSE', 'College A', 100, 'published', 6, 18, 42, '{"O": 6}'::jsonb
        FROM generate_series(1, ${WRITE_BATCH});
    `);

    const after = await one("SELECT generated_at FROM public.bput_census_rollup WHERE id = 1");
    eq(
      new Date(after.generated_at).getTime(),
      new Date(before.generated_at).getTime(),
      "the write refreshed the rollup, which puts the aggregate back in the write path",
    );
    const marked = await one(
      "SELECT dirty_at, refreshed_at FROM public.census_rollup_state WHERE id = 1",
    );
    if (!(marked.dirty_at > marked.refreshed_at)) fail("the write did not mark the rollup stale");

    // And the reader still answers, from the rollup it already had: this is what
    // makes it cheap, and it is why `generatedAt` is part of the payload.
    const payload = await census();
    eq(
      Number(payload.meta.observations),
      counted,
      "meta.observations, which must be the stale rollup",
    );
    eq(
      Number((await progress()).observations),
      counted + WRITE_BATCH,
      "progress.observations, which comes from the live counter and not the rollup",
    );

    // ...and the next refresh does pick the new rows up.
    await forceRefresh();
    eq(
      Number((await census()).meta.observations),
      counted + WRITE_BATCH,
      "meta.observations after the next refresh",
    );
  });

  await acheck(
    "the refresh is skipped when clean, throttled when dirty, and forcible",
    async () => {
      await forceRefresh();
      eq(
        await value("SELECT public.census_rollup_refresh()"),
        false,
        "a refresh with nothing dirty",
      );
      eq(
        await value("SELECT public.census_rollup_refresh('0 minutes')"),
        false,
        "a forced refresh with nothing dirty",
      );

      await db.exec("UPDATE public.census_rollup_state SET dirty_at = now() WHERE id = 1");
      eq(
        await value("SELECT public.census_rollup_refresh()"),
        false,
        "a refresh inside the window",
      );
      eq(await value("SELECT public.census_rollup_refresh('0 minutes')"), true, "a forced refresh");
      eq(
        await value("SELECT public.census_rollup_refresh('0 minutes')"),
        false,
        "a refresh just after one",
      );
    },
  );

  await acheck("progress reads the maintained counter, and computes liveness live", async () => {
    await db.exec(`
      INSERT INTO public.bput_census_cursor
        (range_start, range_end, next_index, visited, not_found, status, updated_at)
      VALUES
        ('2101010001', '2101010100', 100, 10, 2, 'done',   now() - interval '1 day'),
        ('2101010101', '2101010200',  40,  5, 1, 'running', now()),
        ('2101010201', '2101010300',   0,  0, 0, 'paused',  now() - interval '1 hour')
      ON CONFLICT (range_start, range_end) DO NOTHING;
    `);

    // The counter, deliberately wrong: progress must report it rather than
    // re-count the fact table.
    await db.exec("UPDATE public.census_live SET observations = 12345 WHERE id = 1");
    const p = await progress();
    eq(Number(p.observations), 12345, "progress.observations");
    eq(Number(p.ranges), 3, "ranges");
    eq(Number(p.doneRanges), 1, "doneRanges");
    eq(Number(p.visited), 15, "visited");
    eq(Number(p.notFound), 3, "notFound");
    eq(p.active, true, "active while a runner wrote seconds ago");

    await db.exec(
      "UPDATE public.bput_census_cursor SET updated_at = now() - interval '5 minutes' WHERE status = 'running'",
    );
    eq((await progress()).active, false, "active after the three-minute window closed");

    await db.exec("SELECT public.census_live_recount()");
    eq(
      Number((await progress()).observations),
      Number(await value("SELECT COUNT(*) FROM public.bput_census_events")),
      "progress after the recount",
    );
  });

  await acheck("the rollup is not readable by the public roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      eq(
        await value(`SELECT has_table_privilege('${role}', 'public.bput_census_rollup', 'SELECT')`),
        false,
        `${role} SELECT on the rollup`,
      );
      eq(
        await value(
          `SELECT has_function_privilege('${role}', 'public.get_bput_census()', 'EXECUTE')`,
        ),
        true,
        `${role} EXECUTE on get_bput_census`,
      );
      eq(
        await value(
          `SELECT has_function_privilege('${role}', 'public.census_progress()', 'EXECUTE')`,
        ),
        true,
        `${role} EXECUTE on census_progress`,
      );
      eq(
        await value(
          `SELECT has_function_privilege('${role}', 'public.census_rollup_refresh(interval)', 'EXECUTE')`,
        ),
        false,
        `${role} EXECUTE on census_rollup_refresh`,
      );
      eq(
        await value(
          `SELECT has_function_privilege('${role}', 'public.census_live_recount()', 'EXECUTE')`,
        ),
        false,
        `${role} EXECUTE on census_live_recount`,
      );
    }
    eq(
      await value(
        "SELECT has_function_privilege('service_role', 'public.census_rollup_refresh(interval)', 'EXECUTE')",
      ),
      true,
      "service_role EXECUTE on census_rollup_refresh",
    );
  });
}

async function checkTruncate() {
  console.log("\nbulk paths");
  await acheck("TRUNCATE leaves the counter describing nothing", async () => {
    await db.exec("TRUNCATE public.bput_census_events");
    const live = await one(
      "SELECT observations, last_batch_at FROM public.census_live WHERE id = 1",
    );
    eq(Number(live.observations), 0, "counter after TRUNCATE");
    eq(live.last_batch_at, null, "last_batch_at after TRUNCATE");
  });
}

// ── run ───────────────────────────────────────────────────────────────────────

await preflight();

const files = await replay();
if (failures.length > 0) {
  console.log("\nthe migration set did not apply; not running the rest");
  process.exit(1);
}

console.log("\nre-applying the two newest migrations (they claim to be idempotent)");
for (const file of files.slice(-2)) {
  await acheck(`${file.replace(/\.sql$/, "")} re-applies`, async () => {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  });
}

await checkEmptyDatabase();
await checkAuthRoles();
await checkAnalytics();

await seed(ROWS);
const truth = await oracle();
// The read path is checked against the pristine seed: the checks after it
// deliberately mutate the fact table (a rejected pass, a capped batch, a delete),
// and an oracle taken before that would be comparing two different databases.
await checkReadPath(truth);
await checkCensusWritePath();
await checkCounter();

// ── the measurement the design rests on ───────────────────────────────────────
// Printed, not asserted: the checks above are the contract, these are the numbers
// behind the two decisions in the migration set (the aggregate is not on the read
// path, and it is not on the write path either).

console.log(`\nmeasurements at ${ROWS.toLocaleString("en-US")} rows`);
{
  await db.exec("SELECT public.census_live_recount()");
  const [, writeMs] = await timed(() =>
    db.exec(`
      INSERT INTO public.bput_census_events
        (batch_year, semester, branch, college, college_code, outcome, subjects, credits, points, grades)
      SELECT 2023, 4, 'ME', 'College B', 101, 'published', 6, 18, 42, '{"O": 6}'::jsonb
        FROM generate_series(1, 500);
    `),
  );
  await db.exec("UPDATE public.census_rollup_state SET dirty_at = now() WHERE id = 1");
  const [, refreshMs] = await timed(() => forceRefresh());
  const reader = [];
  for (let i = 0; i < 5; i += 1) {
    const [, ms] = await timed(() => census());
    reader.push(ms);
  }
  const [, progressMs] = await timed(() => progress());
  const scale = DEPLOYED_ROWS / ROWS;
  console.log(`  a 500-row write, which only marks         ${writeMs.toFixed(1)} ms`);
  console.log(`  a forced refresh (the whole aggregate)    ${refreshMs.toFixed(1)} ms`);
  console.log(
    `  get_bput_census()                         ${median(reader).toFixed(1)} ms (median of 5)`,
  );
  console.log(`  census_progress()                         ${progressMs.toFixed(1)} ms`);
  console.log(
    `  ↑ extrapolated to the deployed ${DEPLOYED_ROWS.toLocaleString("en-US")} rows: refresh ≈ ` +
      `${((refreshMs * scale) / 1000).toFixed(1)} s, reads unchanged`,
  );
}

// ── bulk paths, last: this empties the fact table ─────────────────────────────

await checkTruncate();

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const [name, message] of failures) console.log(`  ✗ ${name}: ${message}`);
  process.exit(1);
}
console.log(`all migrations applied and every check passed`);
process.exit(0);
