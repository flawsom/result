
CREATE TABLE public.analytics_events (
  id bigserial PRIMARY KEY,
  year int NOT NULL,
  semester int NOT NULL,
  branch text NOT NULL,
  served_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_served_at_idx ON public.analytics_events(served_at DESC);
CREATE INDEX analytics_events_ysb_idx ON public.analytics_events(year, semester, branch);

GRANT ALL ON public.analytics_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.analytics_events_id_seq TO service_role;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.analytics_seed (
  year int NOT NULL,
  semester int NOT NULL,
  branch text NOT NULL,
  count int NOT NULL,
  PRIMARY KEY (year, semester, branch)
);
GRANT ALL ON public.analytics_seed TO service_role;
ALTER TABLE public.analytics_seed ENABLE ROW LEVEL SECURITY;

-- Anonymous, rate-tolerant write path. SECURITY DEFINER so anon can insert
-- without needing table grants. Clamps inputs to keep the table small and
-- safe. NEVER accepts any identifier beyond branch/year/semester.
CREATE OR REPLACE FUNCTION public.log_result_view(_year int, _semester int, _branch text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _year IS NULL OR _year < 1990 OR _year > 2100 THEN RETURN; END IF;
  IF _semester IS NULL OR _semester < 1 OR _semester > 12 THEN RETURN; END IF;
  IF _branch IS NULL OR length(btrim(_branch)) = 0 THEN RETURN; END IF;
  INSERT INTO public.analytics_events(year, semester, branch)
  VALUES (_year, _semester, left(btrim(_branch), 80));
END;
$$;
GRANT EXECUTE ON FUNCTION public.log_result_view(int, int, text) TO anon, authenticated;

-- Aggregated read. SECURITY DEFINER so anon can read summaries without
-- table grants. Applies k=25 anonymity by folding small branches into
-- "Other" before returning any per-branch numbers.
CREATE OR REPLACE FUNCTION public.get_results_analytics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH combined AS (
  SELECT year, semester, branch, count FROM public.analytics_seed
  UNION ALL
  SELECT year, semester, branch, 1 AS count FROM public.analytics_events
),
totals AS (SELECT COALESCE(SUM(count),0)::bigint AS total FROM combined),
by_year AS (
  SELECT year, SUM(count)::bigint AS n FROM combined GROUP BY year
),
by_year_sem AS (
  SELECT year, semester, SUM(count)::bigint AS n FROM combined GROUP BY year, semester
),
by_branch_raw AS (
  SELECT branch, SUM(count)::bigint AS n FROM combined GROUP BY branch
),
by_branch AS (
  SELECT CASE WHEN n >= 25 THEN branch ELSE 'Other' END AS bucket,
         SUM(n)::bigint AS n
  FROM by_branch_raw GROUP BY 1
),
pulse AS (
  SELECT COUNT(DISTINCT (year, semester, branch))::bigint AS distinct_last_24h
  FROM public.analytics_events
  WHERE served_at > now() - interval '24 hours'
),
recent AS (
  SELECT COUNT(*)::bigint AS n_last_24h
  FROM public.analytics_events
  WHERE served_at > now() - interval '24 hours'
)
SELECT jsonb_build_object(
  'total', (SELECT total FROM totals),
  'byYear', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('year', year, 'count', n) ORDER BY year)
     FROM by_year), '[]'::jsonb),
  'byYearSem', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('year', year, 'semester', semester, 'count', n))
     FROM by_year_sem), '[]'::jsonb),
  'byBranch', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('branch', bucket, 'count', n) ORDER BY n DESC)
     FROM by_branch), '[]'::jsonb),
  'pulse24hDistinct', (SELECT distinct_last_24h FROM pulse),
  'pulse24hTotal', (SELECT n_last_24h FROM recent),
  'updatedAt', now()
);
$$;
GRANT EXECUTE ON FUNCTION public.get_results_analytics() TO anon, authenticated;
