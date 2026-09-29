-- ═══════════════════════════════════════════════════════════════════════════
--  Analytics v2, real, live, privacy-safe telemetry for the public
--  "BPUT Results Intelligence" dashboard.
--
--  What changes and why
--  --------------------
--  v1 stored a single row per *successfully served* semester: (year, semester,
--  branch). That is enough to count volume and nothing else, every chart
--  built on it degenerates into "how many lookups happened", and the
--  published/empty/failed split, the upstream latency and the publication
--  timeline were all invisible.
--
--  v2 records ONE row per upstream attempt, with the operational facts we
--  already measure while serving the request:
--
--    outcome     published | not_published | timeout | rate_limited
--                | unreachable | malformed | upstream_error
--    latency_ms  end-to-end duration of that attempt, measured in the browser
--    attempt     1 = the semester's primary session, >1 = a back-paper probe
--    source      live | cache  (cache = IndexedDB hit, no upstream call)
--    subjects    how many subject rows came back (0 when nothing published)
--
--  NON-NEGOTIABLE: none of these carry a registration number, name, DOB,
--  grade, mark or session identifier. There is no foreign key, no session id,
--  no IP, and the writer function refuses anything that is not one of the
--  fields above. The unit of analysis is an anonymous request, never a
--  student.
--
--  All five new columns are nullable: rows written by v1 stay valid and are
--  reported as `unclassified` rather than silently back-filled with a guess.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────── schema extension ───

ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS outcome     text,
  ADD COLUMN IF NOT EXISTS latency_ms  integer,
  ADD COLUMN IF NOT EXISTS attempt     integer,
  ADD COLUMN IF NOT EXISTS source      text,
  ADD COLUMN IF NOT EXISTS subjects    integer;

COMMENT ON COLUMN public.analytics_events.outcome IS
  'Upstream result for this attempt. NULL = row written before v2 (reported as unclassified).';
COMMENT ON COLUMN public.analytics_events.latency_ms IS
  'End-to-end duration of the attempt as measured by the client. NULL = not measured.';
COMMENT ON COLUMN public.analytics_events.attempt IS
  '1 = primary session for the semester, >1 = back-paper re-publication probe index.';
COMMENT ON COLUMN public.analytics_events.source IS
  'live = fetched from BPUT, cache = served from the browser cache (no upstream call).';
COMMENT ON COLUMN public.analytics_events.subjects IS
  'Number of subject rows returned. Aggregate course-structure signal; no grades stored.';

CREATE INDEX IF NOT EXISTS analytics_events_outcome_idx
  ON public.analytics_events (outcome);
CREATE INDEX IF NOT EXISTS analytics_events_year_sem_idx
  ON public.analytics_events (year, semester);

-- ─────────────────────────────── live counter row (realtime broadcast) ───
-- A single row so anon can subscribe to genuine push updates without ever
-- being granted read access to the event stream. Aggregate counters only.

CREATE TABLE IF NOT EXISTS public.analytics_live (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  events          bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_year       integer,
  last_semester   integer,
  last_outcome    text,
  last_latency_ms integer
);

INSERT INTO public.analytics_live (id, events)
VALUES (1, (SELECT COUNT(*) FROM public.analytics_events))
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.touch_analytics_live()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.analytics_live
     SET events          = events + 1,
         updated_at      = NEW.served_at,
         last_year       = NEW.year,
         last_semester   = NEW.semester,
         last_outcome    = NEW.outcome,
         last_latency_ms = NEW.latency_ms
   WHERE id = 1;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS analytics_events_live ON public.analytics_events;
CREATE TRIGGER analytics_events_live
  AFTER INSERT ON public.analytics_events
  FOR EACH ROW EXECUTE FUNCTION public.touch_analytics_live();

ALTER TABLE public.analytics_live ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analytics_live_public_read ON public.analytics_live;
CREATE POLICY analytics_live_public_read
  ON public.analytics_live FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.analytics_live TO anon, authenticated;

ALTER TABLE public.analytics_live REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.analytics_live;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END;
$$;

-- ───────────────────────────────────────────────── batched, validated write ──
-- One round trip for a whole lookup (up to 40 attempts: 8 semesters × up to
-- 5 sessions). Replaces the v1 fire-and-forget loop, which could issue 8+
-- requests per lookup and still only recorded successes.

CREATE OR REPLACE FUNCTION public.log_result_events(_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e          jsonb;
  n          integer := 0;
  v_year     integer;
  v_sem      integer;
  v_branch   text;
  v_outcome  text;
  v_latency  integer;
  v_attempt  integer;
  v_source   text;
  v_subjects integer;
BEGIN
  IF _events IS NULL OR jsonb_typeof(_events) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR e IN SELECT value FROM jsonb_array_elements(_events) AS t(value) LIMIT 64 LOOP
    v_year := NULLIF(e->>'year', '')::integer;
    v_sem  := NULLIF(e->>'semester', '')::integer;

    -- Hard input contract. Bad rows are dropped, never coerced.
    CONTINUE WHEN v_year IS NULL OR v_year < 1990 OR v_year > 2100;
    CONTINUE WHEN v_sem IS NULL OR v_sem < 1 OR v_sem > 12;

    v_branch := left(btrim(COALESCE(e->>'branch', '')), 80);
    CONTINUE WHEN length(v_branch) = 0;

    v_outcome := COALESCE(e->>'outcome', 'unclassified');
    IF v_outcome NOT IN (
      'published', 'not_published', 'timeout', 'rate_limited',
      'unreachable', 'malformed', 'upstream_error', 'unclassified'
    ) THEN
      v_outcome := 'unclassified';
    END IF;

    BEGIN v_latency := NULLIF(e->>'latencyMs', '')::integer;
    EXCEPTION WHEN others THEN v_latency := NULL; END;
    v_latency := LEAST(GREATEST(COALESCE(v_latency, 0), 0), 600000);
    v_latency := NULLIF(v_latency, 0);

    BEGIN v_attempt := NULLIF(e->>'attempt', '')::integer;
    EXCEPTION WHEN others THEN v_attempt := NULL; END;
    v_attempt := LEAST(GREATEST(COALESCE(v_attempt, 1), 1), 16);

    v_source := COALESCE(e->>'source', 'live');
    IF v_source NOT IN ('live', 'cache', 'unknown') THEN
      v_source := 'unknown';
    END IF;

    BEGIN v_subjects := NULLIF(e->>'subjects', '')::integer;
    EXCEPTION WHEN others THEN v_subjects := NULL; END;
    v_subjects := LEAST(GREATEST(COALESCE(v_subjects, 0), 0), 200);

    INSERT INTO public.analytics_events
      (year, semester, branch, outcome, latency_ms, attempt, source, subjects)
    VALUES
      (v_year, v_sem, v_branch, v_outcome, v_latency, v_attempt, v_source, v_subjects);

    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_result_events(jsonb) TO anon, authenticated;

-- ──────────────────────────────────────────── analysis-ready aggregate read ──
-- Returns everything the dashboard needs in ONE round trip, already
-- gap-filled server-side: a time series with missing buckets silently
-- dropped is a lie, so daily/hourly series come back with explicit zeros.

CREATE OR REPLACE FUNCTION public.get_results_analytics_v2()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH ev AS (
  SELECT
    year, semester, branch,
    COALESCE(outcome, 'unclassified') AS outcome,
    latency_ms, attempt, source, subjects, served_at
  FROM public.analytics_events
),
pulse AS (
  SELECT
    COUNT(*) FILTER (WHERE served_at > now() - interval '1 hour')::bigint   AS total_1h,
    COUNT(*) FILTER (WHERE served_at > now() - interval '24 hours')::bigint AS total_24h,
    COUNT(*) FILTER (WHERE served_at > now() - interval '7 days')::bigint   AS total_7d
  FROM ev
),
mixed AS (
  SELECT
    COUNT(*)::bigint                                                      AS events_total,
    COUNT(*) FILTER (WHERE attempt = 1)::bigint                           AS primaries,
    COUNT(*) FILTER (WHERE attempt > 1)::bigint                           AS probes,
    COUNT(*) FILTER (WHERE outcome = 'published')::bigint                 AS published,
    COUNT(*) FILTER (WHERE outcome = 'not_published')::bigint             AS not_published,
    COUNT(*) FILTER (WHERE source = 'cache')::bigint                      AS cache_hits,
    COUNT(*) FILTER (WHERE latency_ms IS NOT NULL)::bigint                AS latency_samples,
    MIN(served_at)                                                        AS first_at,
    MAX(served_at)                                                        AS last_at,
    COUNT(DISTINCT (served_at AT TIME ZONE 'Asia/Kolkata')::date)::bigint AS active_days
  FROM ev
),
by_year AS (
  SELECT year, COUNT(*)::bigint AS n
  FROM ev WHERE year IS NOT NULL GROUP BY year ORDER BY year
),
by_year_sem AS (
  SELECT year, semester, COUNT(*)::bigint AS n
  FROM ev WHERE year IS NOT NULL GROUP BY year, semester ORDER BY year, semester
),
by_branch_raw AS (
  SELECT branch, COUNT(*)::bigint AS n FROM ev GROUP BY branch
),
by_branch AS (
  -- k = 25 anonymity floor: a branch bucket only appears if at least 25
  -- observations support it, otherwise it is folded into "Other".
  SELECT CASE WHEN n >= 25 THEN branch ELSE 'Other' END AS bucket,
         SUM(n)::bigint AS n
  FROM by_branch_raw GROUP BY 1 ORDER BY 2 DESC
),
by_outcome AS (
  SELECT outcome, COUNT(*)::bigint AS n FROM ev GROUP BY outcome ORDER BY 2 DESC
),
funnel AS (
  SELECT semester,
         COUNT(*) FILTER (WHERE attempt = 1)::bigint               AS attempts,
         COUNT(*) FILTER (WHERE attempt = 1
                            AND outcome = 'published')::bigint    AS published,
         COUNT(*) FILTER (WHERE attempt = 1
                            AND outcome <> 'published')::bigint   AS failed
  FROM ev GROUP BY semester ORDER BY semester
),
latency AS (
  SELECT semester,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::integer AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::integer AS p95,
         MAX(latency_ms)                                                   AS max_ms,
         COUNT(*)::bigint                                                  AS n
  FROM ev WHERE latency_ms IS NOT NULL
  GROUP BY semester ORDER BY semester
),
subjects AS (
  SELECT semester,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY subjects)::integer AS p50,
         MAX(subjects)                                                   AS max_subjects,
         COUNT(*)::bigint                                                AS n
  FROM ev WHERE subjects IS NOT NULL AND subjects > 0
  GROUP BY semester ORDER BY semester
),
days AS (
  SELECT generate_series(
    ((now() AT TIME ZONE 'UTC')::date - 89),
    (now() AT TIME ZONE 'UTC')::date,
    interval '1 day'
  )::date AS d
),
daily_raw AS (
  SELECT (served_at AT TIME ZONE 'UTC')::date AS d,
         COUNT(*)::bigint AS total,
         COUNT(*) FILTER (WHERE outcome = 'published')::bigint AS published
  FROM ev GROUP BY 1
),
daily AS (
  SELECT d.d AS day,
         COALESCE(r.total, 0)::bigint     AS total,
         COALESCE(r.published, 0)::bigint AS published
  FROM days d LEFT JOIN daily_raw r ON r.d = d.d ORDER BY d.d
),
hours AS (
  SELECT generate_series(
    date_trunc('hour', now()) - interval '47 hours',
    date_trunc('hour', now()),
    interval '1 hour'
  ) AS h
),
hourly_raw AS (
  SELECT date_trunc('hour', served_at) AS h, COUNT(*)::bigint AS n
  FROM ev GROUP BY 1
),
hourly AS (
  SELECT h.h AS hour, COALESCE(r.n, 0)::bigint AS n
  FROM hours h LEFT JOIN hourly_raw r ON r.h = h.h ORDER BY h.h
),
seasonality AS (
  SELECT EXTRACT(DOW  FROM (served_at AT TIME ZONE 'Asia/Kolkata'))::integer AS dow,
         EXTRACT(HOUR FROM (served_at AT TIME ZONE 'Asia/Kolkata'))::integer AS hour,
         COUNT(*)::bigint AS n
  FROM ev GROUP BY 1, 2 ORDER BY 1, 2
),
publication AS (
  SELECT year, semester,
         MIN(served_at) AS first_seen_at,
         MAX(served_at) AS last_seen_at,
         COUNT(*)::bigint AS n
  FROM ev
  WHERE outcome = 'published' AND year IS NOT NULL
  GROUP BY year, semester ORDER BY year, semester
),
branch_year AS (
  SELECT year, branch, COUNT(*)::bigint AS n
  FROM ev WHERE year IS NOT NULL GROUP BY year, branch ORDER BY year, branch
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'schema', 'v2',
    'generatedAt', now(),
    'firstEventAt', m.first_at,
    'lastEventAt', m.last_at,
    'activeDays', m.active_days
  ),
  'counts', jsonb_build_object(
    'eventsTotal', m.events_total,
    'primaries', m.primaries,
    'probes', m.probes,
    'published', m.published,
    'notPublished', m.not_published,
    'cacheHits', m.cache_hits,
    'latencySamples', m.latency_samples,
    'pulse1h', p.total_1h,
    'pulse24h', p.total_24h,
    'pulse7d', p.total_7d
  ),
  'observed', jsonb_build_object(
    'byYear', COALESCE((SELECT jsonb_agg(jsonb_build_object('year', year, 'count', n) ORDER BY year) FROM by_year), '[]'::jsonb),
    'byYearSem', COALESCE((SELECT jsonb_agg(jsonb_build_object('year', year, 'semester', semester, 'count', n)) FROM by_year_sem), '[]'::jsonb),
    'byBranch', COALESCE((SELECT jsonb_agg(jsonb_build_object('branch', bucket, 'count', n)) FROM by_branch), '[]'::jsonb),
    'byOutcome', COALESCE((SELECT jsonb_agg(jsonb_build_object('outcome', outcome, 'count', n)) FROM by_outcome), '[]'::jsonb),
    'funnel', COALESCE((SELECT jsonb_agg(jsonb_build_object('semester', semester, 'attempts', attempts, 'published', published, 'failed', failed)) FROM funnel), '[]'::jsonb),
    'latency', COALESCE((SELECT jsonb_agg(jsonb_build_object('semester', semester, 'p50', p50, 'p95', p95, 'maxMs', max_ms, 'n', n)) FROM latency), '[]'::jsonb),
    'subjects', COALESCE((SELECT jsonb_agg(jsonb_build_object('semester', semester, 'p50', p50, 'maxSubjects', max_subjects, 'n', n)) FROM subjects), '[]'::jsonb),
    'daily', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', day, 'total', total, 'published', published)) FROM daily), '[]'::jsonb),
    'hourly', COALESCE((SELECT jsonb_agg(jsonb_build_object('hour', hour, 'count', n)) FROM hourly), '[]'::jsonb),
    'seasonality', COALESCE((SELECT jsonb_agg(jsonb_build_object('dow', dow, 'hour', hour, 'count', n)) FROM seasonality), '[]'::jsonb),
    'publication', COALESCE((SELECT jsonb_agg(jsonb_build_object('year', year, 'semester', semester, 'firstSeenAt', first_seen_at, 'lastSeenAt', last_seen_at, 'count', n)) FROM publication), '[]'::jsonb),
    'branchYear', COALESCE((SELECT jsonb_agg(jsonb_build_object('year', year, 'branch', branch, 'count', n)) FROM branch_year), '[]'::jsonb)
  )
)
FROM mixed m, pulse p;
$$;

GRANT EXECUTE ON FUNCTION public.get_results_analytics_v2() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────── seed clear ──
-- `public.analytics_seed` holds the synthetic 2018–2025 series that the v1
-- aggregate drew on. This function deliberately does not read it and returns no
-- key for it: the dashboard plots observed traffic only, so a modelled series
-- has nowhere to appear and cannot be mistaken for a measurement. The table is
-- left untouched by this migration. Remove it if you want it gone:
--
--   DELETE FROM public.analytics_seed;
