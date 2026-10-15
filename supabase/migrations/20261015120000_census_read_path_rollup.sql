-- ──────────────────────────────────────────────── the census read path, cheaply ──
--
-- `get_bput_census()` and `census_progress()` were the two public RPCs still
-- aggregating the raw fact table on every call, and the fact table is now past
-- 1.3M rows. Measured on a faithful replay of these migrations (40k seeded rows,
-- real schema, real functions), a single `get_bput_census()` call cost 329 ms,
-- dominated by the `jsonb_each` that expands every row's grade object (100 ms on
-- its own). The cost is linear in the table, so the same call on the live table
-- lands around ten seconds: past the statement timeout, which is exactly the
-- HTTP 500 / `57014` the deployed panel was returning, and it moves between
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
--   * `census_rollup_refresh()` recomputes it behind a throttle, so a burst of
--     batches costs at most one refresh per window.
--   * A statement-level trigger on both the events and the cursor table drives
--     that refresh, so the rollup maintains itself with no external scheduler
--     and no change to any client.
--
-- Readers never queue behind the refresh: it runs `CONCURRENTLY`, against the
-- unique index below, so a swap does not block the page.

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

-- ──────────────────────────────────────────────────────── throttled refresh ──
-- The refresh is the expensive part, so it is budgeted rather than run per write:
-- a crawl flushing batches every few seconds still costs one refresh per window.
-- `_max_age = '0 minutes'` forces one, for a job that wants the newest numbers.

CREATE OR REPLACE FUNCTION public.census_rollup_refresh(_max_age interval DEFAULT '10 minutes')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_age interval;
BEGIN
  SELECT now() - generated_at INTO v_age
    FROM public.bput_census_rollup
   WHERE id = 1;

  IF v_age IS NOT NULL AND v_age < _max_age THEN
    RETURN false;
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY public.bput_census_rollup;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_rollup_refresh(interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.census_rollup_refresh(interval) FROM anon;
GRANT EXECUTE ON FUNCTION public.census_rollup_refresh(interval) TO authenticated, service_role;

-- Self-maintaining: no cron entry, no client change. Statement-level, so a
-- 200-row batch is one throttle check rather than 200.
CREATE OR REPLACE FUNCTION public.census_rollup_on_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.census_rollup_refresh();
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_rollup_on_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS census_rollup_on_events ON public.bput_census_events;
CREATE TRIGGER census_rollup_on_events
  AFTER INSERT OR DELETE ON public.bput_census_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.census_rollup_on_write();

DROP TRIGGER IF EXISTS census_rollup_on_cursor ON public.bput_census_cursor;
CREATE TRIGGER census_rollup_on_cursor
  AFTER INSERT OR UPDATE ON public.bput_census_cursor
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.census_rollup_on_write();

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

-- The rollup is an implementation detail of the function above. Nothing reads it
-- directly, so it is not granted to the public roles.
REVOKE ALL ON public.bput_census_rollup FROM PUBLIC;
REVOKE ALL ON public.bput_census_rollup FROM anon;
REVOKE ALL ON public.bput_census_rollup FROM authenticated;
GRANT ALL ON public.bput_census_rollup TO service_role;
