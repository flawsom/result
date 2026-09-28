-- ═══════════════════════════════════════════════════════════════════════════
--  BPUT population census — anonymous, aggregate-only.
--
--  Why this exists
--  ---------------
--  The dashboard's own telemetry describes the people who visited this site:
--  a self-selected sample, fine for operational health and useless as a
--  statement about the university. This census walks registration-number
--  ranges on the university's public result portal and keeps, for every
--  student, only a reduction:
--
--    batch year · semester · branch · college
--    outcome (published | not_published | failed | unreachable)
--    subject count, credit total, grade-point total, grade histogram
--
--  What it never keeps
--  -------------------
--  No registration number, no name, no date of birth, no photograph, no
--  per-subject row tied to a person, and no cursor that can be turned back
--  into one. Progress is a range and an offset, so a resumed crawl knows where
--  it stopped without knowing who it met.
--
--  A row here is therefore a student-semester OBSERVATION, not a person: this
--  table can answer "how many observations look like this", never "what did
--  roll 2101… get". Reads expose cells of at least 25 observations.
--
--  Applying it
--  -----------
--  Idempotent: every object is IF NOT EXISTS / CREATE OR REPLACE / DROP …
--  IF EXISTS. Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────── fact table ────

CREATE TABLE IF NOT EXISTS public.bput_census_events (
  id         bigserial   PRIMARY KEY,
  batch_year integer     NOT NULL CHECK (batch_year BETWEEN 1990 AND 2100),
  semester   smallint    NOT NULL CHECK (semester BETWEEN 1 AND 12),
  branch     text        NOT NULL CHECK (length(branch) BETWEEN 1 AND 80),
  college    text        NOT NULL DEFAULT '' CHECK (length(college) <= 80),
  outcome    text        NOT NULL CHECK (
                           outcome IN ('published', 'not_published', 'failed', 'unreachable')
                         ),
  subjects   smallint    NOT NULL DEFAULT 0 CHECK (subjects BETWEEN 0 AND 40),
  credits    smallint    NOT NULL DEFAULT 0 CHECK (credits BETWEEN 0 AND 200),
  points     smallint    NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 400),
  grades     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  served_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bput_census_events IS
  'Anonymous student-semester observations from the paced BPUT census. No identity is stored: see the header of 20260928150000_bput_census.sql.';

CREATE INDEX IF NOT EXISTS bput_census_events_year_sem_idx
  ON public.bput_census_events (batch_year, semester);
CREATE INDEX IF NOT EXISTS bput_census_events_branch_idx
  ON public.bput_census_events (branch);
CREATE INDEX IF NOT EXISTS bput_census_events_college_idx
  ON public.bput_census_events (college);
CREATE INDEX IF NOT EXISTS bput_census_events_served_idx
  ON public.bput_census_events (served_at DESC);

-- ─────────────────────────────────────────────────────────────── cursor ────
-- One row per declared range. `next_index` is an offset into the range, not a
-- position in any student record — resuming needs the offset, not the person.

CREATE TABLE IF NOT EXISTS public.bput_census_cursor (
  id          bigserial   PRIMARY KEY,
  range_start text        NOT NULL CHECK (range_start ~ '^[0-9]{6,12}$'),
  range_end   text        NOT NULL CHECK (range_end   ~ '^[0-9]{6,12}$'),
  next_index  integer     NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  visited     integer     NOT NULL DEFAULT 0 CHECK (visited >= 0),
  not_found   integer     NOT NULL DEFAULT 0 CHECK (not_found >= 0),
  facts       integer     NOT NULL DEFAULT 0 CHECK (facts >= 0),
  status      text        NOT NULL DEFAULT 'idle' CHECK (
                            status IN ('idle', 'running', 'paused', 'done')
                          ),
  started_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (range_start, range_end)
);

COMMENT ON TABLE public.bput_census_cursor IS
  'Crawl progress as (range, offset). Stores no registration numbers: an offset identifies a position in a range, not a student.';

-- ───────────────────────────────────────────────────── write permission ────
-- Only an admin session, or the service role (for a scheduled runner), may
-- append census data. Anonymous clients can read aggregates and nothing else.

CREATE OR REPLACE FUNCTION public.census_can_write()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT auth.role()) = 'service_role'
    OR public.has_role(auth.uid(), 'admin'::public.app_role),
    false
  );
$$;

REVOKE EXECUTE ON FUNCTION public.census_can_write() FROM PUBLIC;

-- ─────────────────────────────────────────────────── safe integer parse ────
-- A regex guard instead of a BEGIN/EXCEPTION cast. Two reasons: an exception
-- block per column per row is expensive at 200 rows a batch, and a malformed
-- payload must be dropped rather than coerced, which a guard does explicitly.

CREATE OR REPLACE FUNCTION public.census_int(_value text, _fallback integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN _value ~ '^-?[0-9]{1,6}$' THEN _value::integer ELSE _fallback END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_int(text, integer) FROM PUBLIC;

-- ───────────────────────────────────────────────────────── batched write ────
-- One round trip per crawl batch (up to 200 observations). Rows that fail the
-- contract are dropped rather than coerced; the caller gets the count it
-- actually stored so a batch that was silently rejected is visible.

CREATE OR REPLACE FUNCTION public.log_census_events(_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r          jsonb;
  n          integer := 0;
  v_year     integer;
  v_sem      integer;
  v_branch   text;
  v_college  text;
  v_outcome  text;
  v_subjects integer;
  v_credits  integer;
  v_points   integer;
  v_grades   jsonb;
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;

  IF _rows IS NULL OR jsonb_typeof(_rows) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(_rows) AS t(value) LIMIT 200 LOOP
    v_year := public.census_int(r->>'batchYear', NULL);
    v_sem  := public.census_int(r->>'semester', NULL);

    CONTINUE WHEN v_year IS NULL OR v_year < 1990 OR v_year > 2100;
    CONTINUE WHEN v_sem IS NULL OR v_sem < 1 OR v_sem > 12;

    v_branch  := left(btrim(COALESCE(r->>'branch', '')), 80);
    v_college := left(btrim(COALESCE(r->>'college', '')), 80);
    CONTINUE WHEN length(v_branch) = 0;

    v_outcome := COALESCE(r->>'outcome', 'published');
    IF v_outcome NOT IN ('published', 'not_published', 'failed', 'unreachable') THEN
      v_outcome := 'failed';
    END IF;

    v_subjects := LEAST(GREATEST(COALESCE(public.census_int(r->>'subjects', 0), 0), 0), 40);
    v_credits  := LEAST(GREATEST(COALESCE(public.census_int(r->>'credits', 0), 0), 0), 200);
    v_points   := LEAST(GREATEST(COALESCE(public.census_int(r->>'points', 0), 0), 0), 400);

    -- Grade histogram is re-validated key by key: only the nine known grades,
    -- each a bounded count, so a malformed payload cannot poison a panel.
    v_grades := '{}'::jsonb;
    IF r ? 'grades' AND jsonb_typeof(r->'grades') = 'object' THEN
      SELECT COALESCE(jsonb_object_agg(k, LEAST(GREATEST(v, 0), 40)), '{}'::jsonb)
        INTO v_grades
        FROM (
          SELECT key AS k, (value #>> '{}')::integer AS v
            FROM jsonb_each(r->'grades')
           WHERE key IN ('O','E','A','B','C','D','F','M','S')
             AND (value #>> '{}') ~ '^[0-9]{1,3}$'
        ) g;
    END IF;

    INSERT INTO public.bput_census_events
      (batch_year, semester, branch, college, outcome, subjects, credits, points, grades)
    VALUES
      (v_year, v_sem, v_branch, v_college, v_outcome, v_subjects, v_credits, v_points, v_grades);

    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_census_events(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_census_events(jsonb) TO authenticated, service_role;

-- ──────────────────────────────────────────────────── cursor persistence ────

CREATE OR REPLACE FUNCTION public.census_cursor_upsert(
  _range_start text,
  _range_end   text,
  _next_index  integer,
  _visited_add integer,
  _not_found_add integer,
  _facts_add   integer,
  _status      text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id integer;
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;

  IF _range_start !~ '^[0-9]{6,12}$' OR _range_end !~ '^[0-9]{6,12}$' THEN
    RAISE EXCEPTION 'range bounds must be 6-12 digit numbers';
  END IF;

  INSERT INTO public.bput_census_cursor
    (range_start, range_end, next_index, visited, not_found, facts, status)
  VALUES
    (_range_start, _range_end, GREATEST(_next_index, 0), GREATEST(_visited_add, 0),
     GREATEST(_not_found_add, 0), GREATEST(_facts_add, 0),
     CASE WHEN _status IN ('idle','running','paused','done') THEN _status ELSE 'running' END)
  ON CONFLICT (range_start, range_end) DO UPDATE SET
    next_index = GREATEST(EXCLUDED.next_index, 0),
    visited    = public.bput_census_cursor.visited   + GREATEST(_visited_add, 0),
    not_found  = public.bput_census_cursor.not_found + GREATEST(_not_found_add, 0),
    facts      = public.bput_census_cursor.facts     + GREATEST(_facts_add, 0),
    status     = CASE WHEN _status IN ('idle','running','paused','done')
                      THEN _status ELSE public.bput_census_cursor.status END,
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_cursor_upsert(text, text, integer, integer, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_cursor_upsert(text, text, integer, integer, integer, integer, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────── cursor state (admin) ────
-- Needed to resume: the offset lives server-side so a closed tab, a different
-- device, or a scheduled run all pick up from the same place. Gated, because
-- unlike the public progress counts this exposes the declared ranges.

CREATE OR REPLACE FUNCTION public.census_cursor_state(_range_start text, _range_end text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.bput_census_cursor;
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census cursor not readable for this session' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.bput_census_cursor
   WHERE range_start = _range_start AND range_end = _range_end;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('nextIndex', 0, 'status', 'idle', 'exists', false);
  END IF;

  RETURN jsonb_build_object(
    'nextIndex', v_row.next_index,
    'status', v_row.status,
    'visited', v_row.visited,
    'notFound', v_row.not_found,
    'facts', v_row.facts,
    'exists', true
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_cursor_state(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_cursor_state(text, text) TO authenticated, service_role;

-- ──────────────────────────────────────────────────── progress (public) ────
-- Deliberately exposes counts only — never the ranges themselves, so nobody can
-- reconstruct which registration numbers have been visited.

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
    'observations',  (SELECT COUNT(*) FROM public.bput_census_events),
    'updatedAt',     MAX(updated_at),
    'active',        COALESCE(BOOL_OR(status = 'running'), false)
  )
  FROM public.bput_census_cursor;
$$;

GRANT EXECUTE ON FUNCTION public.census_progress() TO anon, authenticated;

-- ────────────────────────────────────────────── census aggregate (public) ──
-- Everything the census panels need in one round trip, already k-anonymised:
-- branch and college cells below 25 observations are pooled, so no panel can
-- describe an individual.

CREATE OR REPLACE FUNCTION public.get_bput_census()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH base AS (
  SELECT * FROM public.bput_census_events
),
coverage AS (
  SELECT
    COUNT(*)::bigint                        AS observations,
    COUNT(DISTINCT batch_year)::int         AS batch_years,
    COUNT(DISTINCT semester)::int           AS semesters,
    COUNT(DISTINCT branch)::int             AS branches,
    COUNT(DISTINCT NULLIF(college, ''))::int AS colleges,
    MIN(batch_year)                         AS min_year,
    MAX(batch_year)                         AS max_year
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
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'schema', 'census1',
    'generatedAt', now(),
    'observations', (SELECT observations FROM coverage),
    'batchYears', (SELECT batch_years FROM coverage),
    'semesters', (SELECT semesters FROM coverage),
    'branches', (SELECT branches FROM coverage),
    'colleges', (SELECT colleges FROM coverage),
    'minBatchYear', (SELECT min_year FROM coverage),
    'maxBatchYear', (SELECT max_year FROM coverage),
    'kAnonymity', 25
  ),
  'progress', public.census_progress(),
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
);
$$;

GRANT EXECUTE ON FUNCTION public.get_bput_census() TO anon, authenticated;

-- ────────────────────────────────────────────────────────── read surface ──
-- The raw observations are not exposed to anon or authenticated at all: the
-- only door into them is the aggregate function above. Service role keeps full
-- access for operational queries.

ALTER TABLE public.bput_census_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bput_census_cursor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bput_census_events_admin_read ON public.bput_census_events;
DROP POLICY IF EXISTS bput_census_cursor_admin_read ON public.bput_census_cursor;

GRANT ALL ON public.bput_census_events TO service_role;
GRANT ALL ON public.bput_census_cursor TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bput_census_events_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bput_census_cursor_id_seq TO service_role;
