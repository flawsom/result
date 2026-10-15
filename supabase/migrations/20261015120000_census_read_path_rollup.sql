-- ──────────────────────────────────────────────── the census read path, cheaply ──
--
-- `get_bput_census()` and `census_progress()` were the two public RPCs still
-- aggregating the raw fact table on every call, and the fact table is now past
-- 1.3M rows. Measured on a faithful replay of these migrations (real schema, real
-- functions), the cost is linear in the table, so a call on the live table lands
-- around ten seconds: past the statement timeout, which is exactly the HTTP 500 /
-- `57014` the deployed panel was returning, and it moves between
-- `get_bput_census` and `census_progress` depending on which one the timeout
-- catches first.
--
-- Neither function can be made fast just by indexing: eight grouped aggregations
-- with `percentile_cont` and a JSONB expansion are O(rows) work by definition.
-- The fix is to do that work once per refresh instead of once per page view,
-- which is the same conclusion `census_live` already reached for the counters.
--
--   * `bput_census_rollup` holds the whole payload, minus the two parts that are
--     genuinely live (`progress`, and the timestamp it was measured at).
--   * `census_rollup_refresh()` recomputes it, and refuses to do so when nothing
--     has been written since the last time.
--   * A statement-level trigger on the events and cursor tables *marks* that
--     something changed. It deliberately does not refresh: ten seconds of
--     aggregation inside a crawler's batch would put the crawl behind the same
--     timeout this migration exists to get off the read path, so the refresh runs
--     as its own top-level statement instead (see "who drives this", below).
--
-- Readers never queue behind the refresh either: it runs `CONCURRENTLY`, against
-- the unique index below, so a swap does not block the page.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.bput_census_rollup AS
WITH base AS (
  SELECT batch_year, semester, branch, college, outcome, subjects, points, grades
    FROM public.bput_census_events
),
coverage AS (
  SELECT
    COUNT(*)::bigint                         AS observations,
    COUNT(DISTINCT batch_year)::int          AS batch_years,
    COUNT(DISTINCT semester)::int            AS semesters,
    COUNT(DISTINCT branch)::int              AS branches,
    COUNT(DISTINCT NULLIF(college, ''))::int AS colleges,
    MIN(batch_year)                          AS min_year,
    MAX(batch_year)                          AS max_year
  FROM base
),
by_year AS (
  SELECT batch_year,
         COUNT(*)::bigint AS observations,
         COUNT(*) FILTER (WHERE outcome = 'published')::bigint AS published,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY subjects)::numeric AS subjects_p50
  FROM base GROUP BY batch_year ORDER BY batch_year
),
by_sem AS (
  SELECT semester,
         COUNT(*)::bigint AS observations,
         COUNT(*) FILTER (WHERE outcome = 'published')::bigint AS published,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY subjects)::numeric AS subjects_p50,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY points)::numeric   AS points_p50
  FROM base GROUP BY semester ORDER BY semester
),
branch_raw AS (
  SELECT branch,
         COUNT(*)::bigint AS observations,
         COUNT(*) FILTER (WHERE outcome = 'published')::bigint AS published,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY subjects)::numeric AS subjects_p50
  FROM base GROUP BY branch
),
by_branch AS (
  SELECT CASE WHEN observations >= 25 THEN branch ELSE 'Other' END AS branch,
         SUM(observations)::bigint AS observations,
         SUM(published)::bigint    AS published,
         MAX(subjects_p50)::numeric AS subjects_p50
  FROM branch_raw GROUP BY 1
),
college_raw AS (
  SELECT NULLIF(college, '') AS college,
         COUNT(*)::bigint AS observations,
         COUNT(*) FILTER (WHERE outcome = 'published')::bigint AS published
  FROM base GROUP BY 1
),
by_college AS (
  SELECT CASE WHEN observations >= 25 THEN college ELSE 'Other' END AS college,
         SUM(observations)::bigint AS observations,
         SUM(published)::bigint    AS published
  FROM college_raw GROUP BY 1
),
by_outcome AS (
  SELECT outcome, COUNT(*)::bigint AS n FROM base GROUP BY outcome
),
by_grade AS (
  SELECT g.key AS grade, SUM(NULLIF(g.value #>> '{}', '')::bigint)::bigint AS n
  FROM base, jsonb_each(base.grades) AS g
  GROUP BY g.key ORDER BY n DESC
),
branch_year AS (
  SELECT batch_year, branch, COUNT(*)::bigint AS observations
  FROM base GROUP BY batch_year, branch ORDER BY batch_year, observations DESC
)
SELECT
  1::smallint  AS id,
  now()        AS generated_at,
  jsonb_build_object(
    'meta', jsonb_build_object(
      'schema', 'census1',
      'observations', (SELECT observations FROM coverage),
      'batchYears', (SELECT batch_years FROM coverage),
      'semesters', (SELECT semesters FROM coverage),
      'branches', (SELECT branches FROM coverage),
      'colleges', (SELECT colleges FROM coverage),
      'minBatchYear', (SELECT min_year FROM coverage),
      'maxBatchYear', (SELECT max_year FROM coverage),
      'kAnonymity', 25
    ),
    'byYear', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'batchYear', batch_year, 'observations', observations,
        'published', published, 'subjectsP50', subjects_p50))
      FROM by_year), '[]'::jsonb),
    'bySemester', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'semester', semester, 'observations', observations, 'published', published,
        'subjectsP50', subjects_p50, 'pointsP50', points_p50))
      FROM by_sem), '[]'::jsonb),
    'byBranch', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'branch', branch, 'observations', observations, 'published', published,
        'subjectsP50', subjects_p50) ORDER BY observations DESC)
      FROM by_branch), '[]'::jsonb),
    'byCollege', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'college', college, 'observations', observations, 'published', published)
        ORDER BY observations DESC)
      FROM by_college), '[]'::jsonb),
    'outcomes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('outcome', outcome, 'n', n) ORDER BY n DESC)
      FROM by_outcome), '[]'::jsonb),
    'grades', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('grade', grade, 'n', n))
      FROM by_grade), '[]'::jsonb),
    'branchYear', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'batchYear', batch_year, 'branch', branch, 'observations', observations))
      FROM branch_year), '[]'::jsonb)
  ) AS payload
WITH DATA;

-- Required by REFRESH ... CONCURRENTLY, and the reason readers do not block.
CREATE UNIQUE INDEX IF NOT EXISTS bput_census_rollup_id_idx
  ON public.bput_census_rollup (id);

COMMENT ON MATERIALIZED VIEW public.bput_census_rollup IS
  'The census panels'' aggregates, computed once per refresh instead of once per page view. Counts only, k-anonymised the same way the function was, so the rollup exposes nothing the function did not.';

-- ───────────────────────────────────────── has anything changed since then? ──
-- The marker is what keeps a scheduler cheap: a tick that finds no writes costs
-- one row read rather than ten seconds of aggregation, which matters because the
-- census is idle for most of the year and because a crawl that has stopped writing
-- cannot have made the rollup stale.

CREATE TABLE IF NOT EXISTS public.census_rollup_state (
  id           smallint    PRIMARY KEY CHECK (id = 1),
  dirty_at     timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.census_rollup_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row update per statement, no matter how many rows the statement touched, and
-- no aggregation. This is the whole cost the fact table's writers pay.
CREATE OR REPLACE FUNCTION public.census_rollup_mark_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.census_rollup_state SET dirty_at = now() WHERE id = 1;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_rollup_mark_dirty() FROM PUBLIC;

DROP TRIGGER IF EXISTS census_rollup_dirty_on_events ON public.bput_census_events;
CREATE TRIGGER census_rollup_dirty_on_events
  AFTER INSERT OR DELETE OR TRUNCATE ON public.bput_census_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.census_rollup_mark_dirty();

DROP TRIGGER IF EXISTS census_rollup_dirty_on_cursor ON public.bput_census_cursor;
CREATE TRIGGER census_rollup_dirty_on_cursor
  AFTER INSERT OR UPDATE ON public.bput_census_cursor
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.census_rollup_mark_dirty();

-- ──────────────────────────────────────────────────────── throttled refresh ──
-- Top level only. The default lets a caller tick as often as it likes without
-- paying the aggregate more than once a window, and `_max_age = '0 minutes'`
-- lowers that to "now" — it skips the throttle, not the marker, because a rollup
-- with nothing written since it was measured has nothing to recompute.

CREATE OR REPLACE FUNCTION public.census_rollup_refresh(_max_age interval DEFAULT '10 minutes')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dirty     timestamptz;
  v_refreshed timestamptz;
BEGIN
  SELECT dirty_at, refreshed_at INTO v_dirty, v_refreshed
    FROM public.census_rollup_state
   WHERE id = 1;

  -- Nothing written since the last refresh: the rollup already describes the fact
  -- table, and the aggregate is the expensive part.
  IF v_dirty IS NULL OR v_dirty <= v_refreshed THEN
    RETURN false;
  END IF;

  IF v_refreshed IS NOT NULL AND now() - v_refreshed < _max_age THEN
    RETURN false;
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY public.bput_census_rollup;

  UPDATE public.census_rollup_state
     SET refreshed_at = (SELECT generated_at FROM public.bput_census_rollup WHERE id = 1)
   WHERE id = 1;

  RETURN true;
END;
$$;

-- service_role only. The aggregate is seconds of work on the live table, so an
-- ordinary signed-in user must not be able to ask for it, let alone loop on the
-- forcing variant above.
REVOKE EXECUTE ON FUNCTION public.census_rollup_refresh(interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.census_rollup_refresh(interval) FROM anon;
REVOKE EXECUTE ON FUNCTION public.census_rollup_refresh(interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.census_rollup_refresh(interval) TO service_role;

-- The rollup starts describing the data as it was when this migration ran, so the
-- first write after it is the first thing that can make it stale.
UPDATE public.census_rollup_state
   SET dirty_at     = (SELECT generated_at FROM public.bput_census_rollup WHERE id = 1),
       refreshed_at = (SELECT generated_at FROM public.bput_census_rollup WHERE id = 1)
 WHERE id = 1;

-- ────────────────────────────────────────────────────── who drives this ──
-- Something outside a write transaction has to call the refresh. Where pg_cron is
-- available the database does it itself; where it is not, this NOTICEs and the
-- scheduler that already runs the crawl calls
-- `select public.census_rollup_refresh();` instead. See
-- docs/census-migration-rollout.md, which lists the check that tells you which of
-- the two you got.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('census-rollup-refresh', '*/10 * * * *',
                        $job$SELECT public.census_rollup_refresh('10 minutes')$job$);
  RAISE NOTICE 'census rollup: pg_cron refreshes it every ten minutes';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'census rollup: pg_cron unavailable (%), so the refresh needs a scheduler outside the database', SQLERRM;
END;
$$;

-- ──────────────────────────────────────────────────────────── read surface ──
-- Same keys, same order, same k-anonymity floor as before; only the source of the
-- numbers changed. `generatedAt` is now the measurement time of the rollup rather
-- than the instant of the request, which is the more honest of the two, and the
-- panel already renders it beside the figure.

CREATE OR REPLACE FUNCTION public.get_bput_census()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_set(
           jsonb_set(payload, '{meta,generatedAt}', to_jsonb(generated_at)),
           '{progress}', public.census_progress()
         )
    FROM public.bput_census_rollup
   WHERE id = 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_bput_census() TO anon, authenticated;

-- `observations` and `lastBatchAt` come from the maintained counter instead of
-- re-counting the fact table; everything else is read from the cursor, which is
-- 1103 rows. `active` is still computed live, not read from the stored boolean,
-- because a stored one goes stale as the three-minute window closes.
CREATE OR REPLACE FUNCTION public.census_progress()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'ranges',        COUNT(*),
    'doneRanges',    COUNT(*) FILTER (WHERE status = 'done'),
    'visited',       COALESCE(SUM(visited), 0),
    'notFound',      COALESCE(SUM(not_found), 0),
    'observations',  COALESCE((SELECT observations FROM public.census_live WHERE id = 1), 0),
    'updatedAt',     MAX(updated_at),
    'lastBatchAt',   (SELECT last_batch_at FROM public.census_live WHERE id = 1),
    'active',        COALESCE(
                       BOOL_OR(status = 'running' AND updated_at > now() - interval '3 minutes'),
                       false
                     )
  )
  FROM public.bput_census_cursor;
$$;

GRANT EXECUTE ON FUNCTION public.census_progress() TO anon, authenticated;

-- The rollup and its marker are implementation details of the functions above.
-- Neither is readable by the public roles.
REVOKE ALL ON public.bput_census_rollup FROM PUBLIC;
REVOKE ALL ON public.bput_census_rollup FROM anon;
REVOKE ALL ON public.bput_census_rollup FROM authenticated;
GRANT ALL ON public.bput_census_rollup TO service_role;

REVOKE ALL ON public.census_rollup_state FROM PUBLIC;
REVOKE ALL ON public.census_rollup_state FROM anon;
REVOKE ALL ON public.census_rollup_state FROM authenticated;
GRANT ALL ON public.census_rollup_state TO service_role;
