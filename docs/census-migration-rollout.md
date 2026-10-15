# Rollout — the census read path and the live counter

Two migrations, both written and neither yet applied. This is the order to apply
them in, how to tell whether it worked, and how to undo it.

| Migration                                       | Fixes                                                                                                                                   | What changes                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261015120000_census_read_path_rollup.sql`    | `census_progress` and `get_bput_census` intermittently answering HTTP 500 with PostgreSQL `57014`                                       | The eight aggregates move into a materialized view. The fact table's writers only _mark_ it stale; the refresh is a separate top-level statement. |
| `20261015121000_census_live_delete_trigger.sql` | `census_live.observations` over-counting, because a re-read DELETEs the semester it replaces and only an `AFTER INSERT` trigger existed | An `AFTER DELETE` counterpart with a transition table, plus `census_live_recount()`, which this migration runs itself.                            |

Both are idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF EXISTS`
before each create), so re-applying either is safe and is itself one of the checks
below.

## 1. Before you start

- **Credentials for the apply.** Either a database connection — `supabase db push`
  against a linked project wants an access token plus the database password, and
  `--db-url` takes a connection string instead — or the SQL editor. The
  service-role _API_ key is what the runtime scripts need; it cannot run DDL.
- **One slow statement.** `CREATE MATERIALIZED VIEW … WITH DATA` computes the whole
  aggregate once. Measured on a faithful replay: 126 ms at 20,000 rows and 393 ms
  at 60,000, linear, so expect **8–9 seconds at 1.3M rows**. If your SQL client
  has a statement timeout of its own, raise it for this migration.
- **The fact table does not change.** No migration here rewrites or deletes an
  observation. The only write either one makes to the census tables is the
  counter reconciliation, which sets `census_live.observations` to the true count.
- **Readers are already broken, so there is no healthy state to protect.** The
  panel is failing before you start.

## 2. Apply

In filename order — the second migration reuses nothing from the first, but the
append-only convention is the point:

```sh
# with the Supabase CLI, from the repository root
supabase db push

# or against a connection string instead of a linked project. The CLI wants it
# percent-encoded, which matters because database passwords tend to contain the
# characters that need encoding.
supabase db push --db-url "$SUPABASE_DB_URL"

# list what would be applied, without applying it
supabase db push --dry-run
```

Or paste each file into the SQL editor, in this order:

1. `supabase/migrations/20261015120000_census_read_path_rollup.sql`
2. `supabase/migrations/20261015121000_census_live_delete_trigger.sql`

Watch the notices. Migration 1 prints one line about the refresh driver:

```
NOTICE:  census rollup: pg_cron refreshes it every ten minutes
```

or, where `pg_cron` is not available:

```
NOTICE:  census rollup: pg_cron unavailable (…), so the refresh needs a scheduler outside the database
```

The second message is not a failure — the migrations still applied — but it makes
step 4 your responsibility.

## 3. Verify

**Offline, no credentials.** Replays every migration into an in-process Postgres
and checks the read path and the counter against an oracle recomputed in
JavaScript:

```sh
bun scripts/migrations-verify.mjs        # ~11 s, 44 checks
bun scripts/migrations-verify.mjs --rows 60000
```

It exits 0 only when every migration applied and every check passed. It covers the
census write path (batch caps, row validation, and a replacement pass that has to
be atomic), the panels' readers, the rollup and its refresh driver, the live
counter, the maintenance work list, the frontier repair, the role enum and the
write gate, and the analytics readers. It was shown to fail on five deliberately
broken copies — a delete trigger that stops decrementing, a non-unique index, a
removed stale marker, an atomicity guard deleted from the replacement pass, and
invalid SQL — each exit 1, each naming the check that caught it.

**Live, with the service-role key** (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`):

```sh
bun scripts/census-rollup.mjs --force   # forces a refresh; expect ~8-9 s, then
                                        # "the panel now reports N observations"
bun scripts/census-rollup.mjs --status  # observations, measurement time, staleness
bun scripts/census-status.mjs           # the panel's own reader, end to end
```

Before this rollout `census-status.mjs` failed with `census_progress (500): 57014`.
After it, that line is gone and the figures come from the rollup.

**The counter, in the SQL editor.** This prints the true row count and reconciles
the counter to it in the same statement:

```sql
select public.census_live_recount();
```

Then confirm the delete trigger is the thing keeping it there — the maintenance
pass is what used to break it:

```sql
select observations from public.census_live where id = 1;   -- before
-- run a maintenance pass against any block, then:
select observations from public.census_live where id = 1;   -- must fall by the
                                                            -- number replaced
```

## 4. The refresh driver

The aggregate is 8–9 seconds of work on the live table, so it deliberately does
**not** run inside a write: the fact table's writers only update a single row in
`census_rollup_state`. Something at top level has to call the refresh, and if that
never happens the panels keep answering — with numbers that stop moving. Check
which driver you have:

```sql
select jobname, schedule, command from cron.job where jobname = 'census-rollup-refresh';
```

- **One row** — `pg_cron` is driving it every ten minutes, and the refresh is
  skipped entirely when nothing has been written. Nothing further to do.
- **No rows** — `pg_cron` is not installed. `create extension pg_cron;` and re-run
  the `DO` block at the end of migration 1, or run the refresh from any scheduler
  you already have:

  ```sh
  bun scripts/census-rollup.mjs      # no-op unless something was written
  ```

  This repository already carries that workflow:
  [`census-rollup.yml`](../.github/workflows/census-rollup.yml) runs every ten
  minutes and calls the same script. It needs nothing beyond the secrets the crawl
  already uses, and it is a no-op when the rollup is current, so where `pg_cron`
  _is_ available both drivers can run without fighting: whichever refreshes first
  leaves nothing dirty for the other. The equivalent, if you would rather not keep
  a workflow:

  ```yaml
  on:
    schedule:
      - cron: "*/10 * * * *"
  jobs:
    rollup:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
        - run: bun scripts/census-rollup.mjs
          env:
            SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
            SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
  ```

Either way, think of the rollup as a cache with a ten-minute lag rather than as
live data: the payload carries `meta.generatedAt`, which says when it was measured,
and `--status` prints it. The panels render it beside the figure.

## 5. What to expect afterwards

|                         | Before                                        | After                                                         |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------- | --- | ------------------------- | ------------- | ----------------------------------------------------------- |
| `get_bput_census()`     | seconds, and a 500 when it outran the timeout | 0.8 ms, measured at both 20,000 and 60,000 rows               |
| `census_progress()`     | a full scan of the fact table                 | 0.4–0.7 ms                                                    |
| `meta.generatedAt`      | the instant of the request                    | when the rollup was last refreshed                            |
| `progress.observations` | re-counted per call                           | the maintained counter                                        |     | A write to the fact table | no extra work | one row update (17–27 ms for a 500-row batch in the replay) |
| The refresh             | ran per page view                             | 126 ms at 20,000 rows, 393 ms at 60,000, ≈ 8–9 s at 1,313,945 |
| A maintenance pass      | counter climbs by every row re-read           | counter falls by the rows replaced                            |

Bandwidth is unchanged: same keys, same order, same k-anonymity floor of 25, and
the rollup is not readable by `anon` or `authenticated` — only the two functions
are.

## 6. Roll back

Both migrations are additive, so rolling back means restoring the two reader
functions and dropping what these files added. The definitions to restore are the
ones already in this repository: `get_bput_census()` from
`20260928150000_bput_census.sql` and `census_progress()` from
`20260928170000_census_live.sql`.

```sql
-- 1. restore the reader bodies, in full, from those two files
-- 2. then remove what these migrations added
drop trigger if exists census_rollup_dirty_on_events on public.bput_census_events;
drop trigger if exists census_rollup_dirty_on_cursor on public.bput_census_cursor;
drop trigger if exists census_live_on_event_delete on public.bput_census_events;
drop trigger if exists census_live_on_event_truncate on public.bput_census_events;
drop function if exists public.census_rollup_mark_dirty();
drop function if exists public.census_rollup_refresh(interval);
drop function if exists public.census_live_on_event_delete();
drop function if exists public.census_live_on_event_truncate();
drop function if exists public.census_live_recount();
drop materialized view if exists public.bput_census_rollup;
drop table if exists public.census_rollup_state;
select cron.unschedule('census-rollup-refresh');   -- only if pg_cron is present
```

Rolling back restores the 500s: it puts the per-request aggregation back. It does
not undo the counter reconciliation, because there is no reason to reintroduce a
known-wrong number — if you need the old behaviour exactly, the counter can be
made to over-count again by dropping only the `AFTER DELETE` trigger.
