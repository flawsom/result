-- ═══════════════════════════════════════════════════════════════════════════
--  Census maintenance ledger, what makes the census keep itself true.
--
--  Why this exists
--  ---------------
--  The crawl in `20260928150000_bput_census.sql` is a first pass: read each
--  registration number once, reduce it to anonymous student-semester rows, and
--  record an offset. Two things follow from that, and both of them make a
--  published figure quietly wrong:
--
--    1. a finished block is never revisited. BPUT publishes on a rolling window
--       (2023 currently answers for semesters 1–6 and will answer for 7, then 8),
--       so when a batch year gains a semester, every block of that year holds a
--       hole that nothing will ever fill;
--    2. "finished" is indistinguishable from "read once, months ago". A blocked
--       college that later admits more students, or a session that is
--       re-published, leaves no trace anywhere.
--
--  What this adds
--  --------------
--    • `census_block_walk`, one row per college-and-year block: the measured
--      upper bound, the offset the walk reached, the highest serial it actually
--      resolved, and which semesters its first pass captured;
--    • `census_pass`, the unit of maintenance: one block, one semester. A
--      semester is claimed before it is read and marked done after, so a pass is
--      never spent twice and a re-read cannot duplicate observations;
--    • `census_session_watch`, the sessions the portal last said it serves, per
--      batch year. Written by the daily refresh, so the outstanding work is
--      derived from the portal rather than from a constant compiled into a
--      bundle;
--    • `census_work` + `census_plan()`, the derived work list and its counts.
--      Ranges stay server-side: the view is service-role only and the public
--      function returns counts per batch year, never a block.
--
--  Seeding
--  -------
--  The existing cursors are folded in, so the three ranges already walked are
--  not re-read and their observations are not duplicated. A seeded block is
--  marked complete only if its cursor says `done`, and its captured semesters are
--  taken from the rows that actually exist for its batch year.
--
--  Applying it
--  -----------
--  Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS, and the seed
--  is ON CONFLICT DO NOTHING. Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────── block state (per block) ──
-- `frontier` is the highest serial that answered for a student, which is what a
-- maintenance pass has to re-read and what tells growth from noise: a block whose
-- measured bound moves past its frontier has new numbers to read, and one that
-- does not has nothing new to say.

CREATE TABLE IF NOT EXISTS public.census_block_walk (
  year                integer     NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  code                integer     NOT NULL CHECK (code BETWEEN 0 AND 999),
  max_serial          integer     NOT NULL DEFAULT 0 CHECK (max_serial BETWEEN 0 AND 999),
  serial_offset       integer     NOT NULL DEFAULT 0 CHECK (serial_offset BETWEEN 0 AND 999),
  frontier            integer     NOT NULL DEFAULT 0 CHECK (frontier BETWEEN 0 AND 999),
  first_pass_at       timestamptz,
  first_pass_sessions smallint[]  NOT NULL DEFAULT '{}'::smallint[],
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (year, code)
);

COMMENT ON TABLE public.census_block_walk IS
  'Per-block census state: measured bound, walk offset, highest resolved serial, and the semesters the first pass captured. A block identity, never a student.';

CREATE INDEX IF NOT EXISTS census_block_walk_pending_idx
  ON public.census_block_walk (year, first_pass_at);

-- ────────────────────────────────────── maintenance passes (per block, sem) ──
-- The dedupe gate. `claim_pass` only succeeds for a semester that is not already
-- captured and not already in flight, so two workers cannot read the same
-- semester of the same block, and a pass that finishes is never claimed again.

CREATE TABLE IF NOT EXISTS public.census_pass (
  year          integer     NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  code          integer     NOT NULL CHECK (code BETWEEN 0 AND 999),
  semester      smallint    NOT NULL CHECK (semester BETWEEN 1 AND 12),
  status        text        NOT NULL DEFAULT 'running' CHECK (
                              status IN ('running', 'done', 'empty', 'failed')
                            ),
  serial_offset integer     NOT NULL DEFAULT 0 CHECK (serial_offset BETWEEN 0 AND 999),
  subjects      integer     NOT NULL DEFAULT 0 CHECK (subjects >= 0),
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (year, code, semester)
);

COMMENT ON TABLE public.census_pass IS
  'One maintenance pass: a single semester re-read across one block. Claimed before it is read, so no semester is ever read twice for the same block.';

-- ─────────────────────────────────── the portal's window, as last observed ──

CREATE TABLE IF NOT EXISTS public.census_session_watch (
  year       integer     PRIMARY KEY CHECK (year BETWEEN 2000 AND 2100),
  semesters  smallint[]  NOT NULL DEFAULT '{}'::smallint[],
  checked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.census_session_watch IS
  'Which semester sessions the portal answered for, per batch year, as last checked. This is the reason a new publication becomes work without anybody noticing it by hand.';

-- ───────────────────────────────────────────────── fold in the old cursors ──
-- The grid's ranges are always `YY01CCC001`–`YY01CCC999`, so the serial offset in
-- the existing cursor is also the number of serials already walked. Captured
-- semesters come from the rows that exist for the block's batch year, because a
-- row per semester is exactly what "captured" means here.

INSERT INTO public.census_block_walk
  (year, code, max_serial, serial_offset, first_pass_at, first_pass_sessions)
SELECT
  (substring(c.range_start from 1 for 2))::integer + 2000 AS year,
  (substring(c.range_start from 5 for 3))::integer        AS code,
  0                                                       AS max_serial,
  LEAST(GREATEST(c.next_index, 0), 999)                   AS serial_offset,
  CASE WHEN c.status = 'done' THEN c.updated_at END       AS first_pass_at,
  CASE WHEN c.status = 'done' THEN COALESCE((
    SELECT array_agg(DISTINCT e.semester ORDER BY e.semester)
      FROM public.bput_census_events e
     WHERE e.batch_year = (substring(c.range_start from 1 for 2))::integer + 2000
  ), '{}'::smallint[]) ELSE '{}'::smallint[] END          AS first_pass_sessions
FROM public.bput_census_cursor c
WHERE c.range_start ~ '^[0-9]{10}$'
  AND c.range_end   ~ '^[0-9]{10}$'
ON CONFLICT (year, code) DO NOTHING;

-- ─────────────────────────────────────────────────────────── derive work ──
-- Everything outstanding, derived rather than queued: blocks with serials left to
-- walk, and semesters the portal serves that a block has not captured. A view, so
-- it cannot go stale relative to the two tables it reads.

CREATE OR REPLACE VIEW public.census_work AS
WITH watch AS (
  SELECT w.year, unnest(w.semesters) AS semester
    FROM public.census_session_watch w
),
-- A first pass resumes at the right place for its state:
--
--   • never finished, at the offset the last slice reached, which is where it
--     stopped probing;
--   • finished, but the measurement has since moved past the frontier, at the
--     frontier, because everything above it missed when it was read, and a serial
--     that answers now is a student who was not there before. That is what catches
--     a college admitting late, and it cannot duplicate a row: a serial above the
--     frontier has never produced one.
--
-- `serial_offset` and `frontier` are read positions, not serials: serial 001 is
-- index 0, so the next index after a frontier of 121 is 121.
first_pass AS (
  SELECT b.year,
         b.code,
         NULL::smallint AS semester,
         b.max_serial,
         CASE WHEN b.first_pass_at IS NOT NULL THEN b.frontier ELSE b.serial_offset END
           AS serial_offset,
         GREATEST(
           b.max_serial - CASE WHEN b.first_pass_at IS NOT NULL THEN b.frontier ELSE b.serial_offset END,
           0
         ) AS serials_left
    FROM public.census_block_walk b
   WHERE b.max_serial > 0
     AND (b.first_pass_at IS NULL OR b.max_serial > b.frontier)
),
-- A maintenance pass sweeps a block from its first serial up to the frontier,
-- because the students are below the frontier and there is nothing above it to
-- re-read. `serial_offset` is therefore always zero here and `serials_left` is
-- the sweep length: the unit of work is "read this one semester for these
-- students", not "carry on from where the first pass stopped".
-- A block needs a semester re-read when the portal serves it and the block has
-- not captured it. `first_pass_sessions` holds only semesters the portal actually
-- published, so "the portal serves S7 for 2023 and no 2023 block has S7" arrives
-- here as work by itself, nobody has to notice that BPUT published something.
--
-- A pass that was closed is settled, but only for a while. Results are published
-- in batches, so a semester can answer for none of a block's students today and
-- for all of them next month; re-checking a served-but-unpublished semester once
-- a month is what catches that, and it costs two reads per student rather than
-- another eight.
maintenance AS (
  SELECT b.year,
         b.code,
         w.semester,
         b.max_serial,
         0 AS serial_offset,
         GREATEST(b.frontier, 0) AS serials_left
    FROM public.census_block_walk b
    JOIN watch w ON w.year = b.year
   WHERE b.first_pass_at IS NOT NULL
     AND NOT (w.semester = ANY (b.first_pass_sessions))
     AND NOT EXISTS (
           SELECT 1 FROM public.census_pass p
            WHERE p.year = b.year
              AND p.code = b.code
              AND p.semester = w.semester
              AND p.status IN ('done', 'empty')
              AND p.updated_at > now() - interval '30 days'
         )
)
SELECT * FROM first_pass
UNION ALL
SELECT * FROM maintenance;

COMMENT ON VIEW public.census_work IS
  'Outstanding census work: one row per unit (a block with serials left, or a block-and-semester the portal now serves). Derived from the ledger and the session watch, never queued by hand.';

-- ───────────────────────────────────────── measurement and watch ingestion ──

CREATE OR REPLACE FUNCTION public.census_note_blocks(_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       jsonb;
  n       integer := 0;
  v_year  integer;
  v_code  integer;
  v_max   integer;
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;
  IF _rows IS NULL OR jsonb_typeof(_rows) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(_rows) AS t(value) LIMIT 4000 LOOP
    v_year := public.census_int(r->>'year', NULL);
    v_code := public.census_int(r->>'code', NULL);
    v_max  := public.census_int(r->>'max', NULL);
    CONTINUE WHEN v_year IS NULL OR v_year < 2000 OR v_year > 2100;
    CONTINUE WHEN v_code IS NULL OR v_code < 0 OR v_code > 999;
    CONTINUE WHEN v_max IS NULL OR v_max < 0 OR v_max > 999;

    INSERT INTO public.census_block_walk (year, code, max_serial)
    VALUES (v_year, v_code, v_max)
    ON CONFLICT (year, code) DO UPDATE
      SET max_serial = EXCLUDED.max_serial,
          updated_at = now()
      WHERE public.census_block_walk.max_serial IS DISTINCT FROM EXCLUDED.max_serial;

    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_note_blocks(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_note_blocks(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.census_note_watch(_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        jsonb;
  n        integer := 0;
  v_year   integer;
  v_sems   smallint[];
  v_raw    jsonb;
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;
  IF _rows IS NULL OR jsonb_typeof(_rows) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(_rows) AS t(value) LIMIT 64 LOOP
    v_year := public.census_int(r->>'year', NULL);
    CONTINUE WHEN v_year IS NULL OR v_year < 2000 OR v_year > 2100;

    v_sems := '{}'::smallint[];
    v_raw  := r->'semesters';
    IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) = 'array' THEN
      SELECT COALESCE(array_agg(DISTINCT s ORDER BY s), '{}'::smallint[]) INTO v_sems
        FROM (
          SELECT (value #>> '{}')::smallint AS s
            FROM jsonb_array_elements(v_raw)
           WHERE (value #>> '{}') ~ '^[0-9]{1,2}$'
             AND (value #>> '{}')::integer BETWEEN 1 AND 12
        ) q;
    END IF;

    INSERT INTO public.census_session_watch (year, semesters, checked_at)
    VALUES (v_year, v_sems, now())
    ON CONFLICT (year) DO UPDATE
      SET semesters  = EXCLUDED.semesters,
          checked_at = now();

    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_note_watch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_note_watch(jsonb) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────── walk reporting ──
-- Called by the crawl at every flush. `_captured` is the set of semesters the
-- block's first pass actually read, a session whose every row came back
-- `unreachable` is not captured, so it stays outstanding instead of being
-- mistaken for a hole in the portal.

CREATE OR REPLACE FUNCTION public.census_note_walk(
  _year      integer,
  _code      integer,
  _offset    integer,
  _frontier  integer,
  _captured  smallint[] DEFAULT '{}'::smallint[],
  _completed boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.census_block_walk
     SET serial_offset = LEAST(GREATEST(_offset, 0), 999),
         frontier      = GREATEST(frontier, LEAST(GREATEST(_frontier, 0), 999)),
         first_pass_at = CASE WHEN _completed THEN COALESCE(first_pass_at, now()) ELSE first_pass_at END,
         first_pass_sessions = CASE
           WHEN _completed THEN (
             SELECT COALESCE(array_agg(DISTINCT s ORDER BY s), '{}'::smallint[])
               FROM unnest(first_pass_sessions || COALESCE(_captured, '{}'::smallint[])) AS s
           )
           ELSE first_pass_sessions
         END,
         updated_at    = now()
   WHERE year = _year AND code = _code;

  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_note_walk(integer, integer, integer, integer, smallint[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_note_walk(integer, integer, integer, integer, smallint[], boolean) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────── pass claiming ──
-- The one place that decides whether a semester still needs reading. A claim on a
-- semester already captured returns false; a claim on a pass whose worker died
-- (no write for twenty minutes) is allowed again, because the alternative is a
-- unit that is never finished.

CREATE OR REPLACE FUNCTION public.census_claim_pass(
  _year     integer,
  _code     integer,
  _semester smallint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_block public.census_block_walk;
  v_ok    boolean;
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_block FROM public.census_block_walk
   WHERE year = _year AND code = _code;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Already captured by the first pass: nothing to read, ever.
  IF v_block.first_pass_at IS NOT NULL
     AND _semester = ANY (v_block.first_pass_sessions) THEN
    RETURN false;
  END IF;

  /*
   * The answer is yes or no, not "where to resume": a pass is applied as one
   * replacement at the end (`census_apply_pass`), so a pass that dies halfway has
   * written nothing and starts again at the first serial. That is deliberate, a
   * partially applied pass would either double-count the students already read or
   * leave the semester half-populated, and both are worse than re-reading a block.
   */
  INSERT INTO public.census_pass (year, code, semester, status)
  VALUES (_year, _code, _semester, 'running')
  ON CONFLICT (year, code, semester) DO UPDATE
    SET status     = 'running',
        started_at = now(),
        updated_at = now()
    WHERE public.census_pass.status = 'failed'
       OR (public.census_pass.status = 'running'
           AND public.census_pass.updated_at < now() - interval '20 minutes')
  RETURNING true INTO v_ok;

  -- No row returned means the pass is already captured or still in flight.
  RETURN COALESCE(v_ok, false);
END;
$$;

-- ─────────────────────────────────────────── block-attributable rows ──
-- A maintenance pass re-reads a semester the portal has only now started
-- serving, and the row it corrects is one the first pass stored as
-- `not_published`. Appending a second row would count that student twice in every
-- total on the site, so a pass has to *replace* the rows it corrects, and to
-- replace a row you have to be able to find it. That is all this column is: which
-- college-and-year block a row came from. It names a college, never a student,
-- which is the same grain this table already publishes at (`college`).
--
-- Rows written before this migration carry 0, meaning "block not recorded". They
-- are never deleted, a pass only ever replaces rows that carry its own code, so
-- the census cannot lose history it collected earlier.

ALTER TABLE public.bput_census_events
  ADD COLUMN IF NOT EXISTS college_code smallint NOT NULL DEFAULT 0;

ALTER TABLE public.bput_census_events
  DROP CONSTRAINT IF EXISTS bput_census_events_college_code_check;
ALTER TABLE public.bput_census_events
  ADD CONSTRAINT bput_census_events_college_code_check
  CHECK (college_code BETWEEN 0 AND 999);

CREATE INDEX IF NOT EXISTS bput_census_events_block_idx
  ON public.bput_census_events (batch_year, semester, college_code);

-- `log_census_events` is replaced so a walk can stamp the block it read. The
-- validation is unchanged: same whitelists, same bounds, same drop-on-invalid.
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
  v_code     integer;
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
    v_code := COALESCE(public.census_int(r->>'collegeCode', 0), 0);

    CONTINUE WHEN v_year IS NULL OR v_year < 1990 OR v_year > 2100;
    CONTINUE WHEN v_sem IS NULL OR v_sem < 1 OR v_sem > 12;
    CONTINUE WHEN v_code < 0 OR v_code > 999;

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
      (batch_year, semester, branch, college, college_code, outcome, subjects, credits, points, grades)
    VALUES
      (v_year, v_sem, v_branch, v_college, v_code, v_outcome, v_subjects, v_credits, v_points, v_grades);

    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_census_events(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_census_events(jsonb) TO authenticated, service_role;

-- ────────────────────────────────────── apply a maintenance pass (atomic) ──
-- One transaction: drop this block's rows for the semester, then store what the
-- re-read found. Either the corrected population is in place or nothing changed,
-- which is the only way to re-read a semester without either double-counting it
-- or leaving a hole while a crawl is halfway through.

CREATE OR REPLACE FUNCTION public.census_apply_pass(
  _year     integer,
  _code     integer,
  _semester smallint,
  _rows     jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  /* 200 is `log_census_events`'s batch ceiling. The biggest measured block holds
     up to about 960 students, so the replacement is chunked rather than sent in
     one call, and still inside this one transaction, so the semester is never
     left half-populated. */
  v_chunk  jsonb;
  v_stored integer := 0;
  v_total  integer;
  i        integer;
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.bput_census_events
   WHERE batch_year = _year
     AND semester = _semester
     AND college_code = _code;

  v_total := COALESCE(jsonb_array_length(_rows), 0);

  IF v_total > 0 THEN
    FOR i IN 0 .. ((v_total - 1) / 200) LOOP
      SELECT jsonb_agg(value ORDER BY ord)
        INTO v_chunk
        FROM jsonb_array_elements(_rows) WITH ORDINALITY AS t(value, ord)
       WHERE ord > i * 200 AND ord <= (i + 1) * 200;

      v_stored := v_stored + public.log_census_events(v_chunk);
    END LOOP;
  END IF;

  /*
   * If the store refused any row, the whole replacement is rolled back rather than
   * committed short: the rows that were deleted are still deleted inside this
   * transaction, so a half-stored semester would be a hole where a figure used to
   * be. Raising here undoes both halves, and the pass row (marked running by the
   * claim, stale in twenty minutes) is retried by a later slice.
   */
  IF v_stored < v_total THEN
    RAISE EXCEPTION
      'maintenance pass stored % of % rows for %/% semester %, rolled back',
      v_stored, v_total, _year, _code, _semester;
  END IF;

  UPDATE public.census_pass
     SET subjects   = GREATEST(v_stored, 0),
         status     = 'done',
         updated_at = now()
   WHERE year = _year AND code = _code AND semester = _semester;

  RETURN v_stored;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_apply_pass(integer, integer, smallint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_apply_pass(integer, integer, smallint, jsonb) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.census_claim_pass(integer, integer, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_claim_pass(integer, integer, smallint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.census_report_pass(
  _year     integer,
  _code     integer,
  _semester smallint,
  _status   text,
  _subjects integer DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.census_can_write() THEN
    RAISE EXCEPTION 'census write not permitted for this session'
      USING ERRCODE = '42501';
  END IF;

  -- `done` and `empty` close the pass for good (the work view stops listing it);
  -- `failed` hands it back to a later slice. A pass that stored rows closes itself
  -- inside `census_apply_pass`, so this is for the cases with nothing to store.
  UPDATE public.census_pass
     SET status     = CASE WHEN _status IN ('done', 'empty', 'failed') THEN _status ELSE 'failed' END,
         subjects   = GREATEST(COALESCE(_subjects, 0), 0),
         updated_at = now()
   WHERE year = _year AND code = _code AND semester = _semester;

  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_report_pass(integer, integer, smallint, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_report_pass(integer, integer, smallint, text, integer) TO authenticated, service_role;

-- ───────────────────────────────────────────────────── work list (crawler) ──
-- Service-role only: it names blocks, and the public surface deliberately does
-- not. Ordered so the first pass drains before maintenance, and maintenance is
-- ordered by the largest year first, because a bigger batch year is more of a
-- published figure than a smaller one.

CREATE OR REPLACE FUNCTION public.census_next_work(_limit integer DEFAULT 64)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'year', w.year,
           'code', w.code,
           'semester', w.semester,
           'maxSerial', w.max_serial,
           'serialOffset', w.serial_offset,
           'serialsLeft', w.serials_left)), '[]'::jsonb)
    FROM (
      SELECT * FROM public.census_work
       -- Maintenance first: a semester the portal has only now started serving
       -- is a hole in a figure that is already published, where the rest of the
       -- grid is work in progress.
       ORDER BY (semester IS NULL), year DESC, code
       LIMIT LEAST(GREATEST(_limit, 1), 4000)
    ) w;
$$;

REVOKE EXECUTE ON FUNCTION public.census_next_work(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.census_next_work(integer) TO authenticated, service_role;

-- ──────────────────────────────────────────────────── the plan (public) ──
-- Counts per batch year, and nothing that identifies a block. This is what the
-- dashboard reads: the denominator of crawl progress stops being a constant
-- compiled into a bundle and becomes a measurement of what is left.

CREATE OR REPLACE FUNCTION public.census_plan()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH blocks AS (
  SELECT * FROM public.census_block_walk
),
per_year AS (
  SELECT b.year,
         COUNT(*)::int                                              AS blocks,
         COUNT(*) FILTER (WHERE b.first_pass_at IS NOT NULL)::int     AS first_pass_done,
         COALESCE(SUM(GREATEST(b.max_serial - b.serial_offset, 0))
                  FILTER (WHERE b.first_pass_at IS NULL
                            OR b.max_serial > b.frontier), 0)::bigint AS serials_left
    FROM blocks b
   GROUP BY b.year
),
passes AS (
  SELECT w.year,
         COUNT(*) FILTER (WHERE w.semester IS NOT NULL)::int                   AS pending_passes,
         COALESCE(SUM(w.serials_left) FILTER (WHERE w.semester IS NOT NULL), 0)::bigint
                                                                               AS pending_serials
    FROM public.census_work w
   GROUP BY w.year
),
captured AS (
  SELECT p.year,
         COUNT(*) FILTER (WHERE p.status = 'done')::int AS captured_passes
    FROM public.census_pass p
   GROUP BY p.year
)
SELECT jsonb_build_object(
  'blocks',          (SELECT COUNT(*)::int FROM blocks),
  'blocksMeasured',  (SELECT COUNT(*)::int FROM blocks WHERE max_serial > 0),
  'blocksDone',      (SELECT COUNT(*)::int FROM blocks WHERE first_pass_at IS NOT NULL),
  'serialsRemaining',(SELECT COALESCE(SUM(GREATEST(max_serial - serial_offset, 0))
                                        FILTER (WHERE first_pass_at IS NULL OR max_serial > frontier), 0)::bigint
                        FROM blocks),
  'passesDone',      (SELECT COALESCE(SUM(captured_passes), 0)::int FROM captured),
  'passesPending',   (SELECT COALESCE(SUM(pending_passes), 0)::int FROM passes),
  'passSerialsPending', (SELECT COALESCE(SUM(pending_serials), 0)::bigint FROM passes),
  'watchCheckedAt',  (SELECT MAX(checked_at) FROM public.census_session_watch),
  'updatedAt',       GREATEST(
                       COALESCE((SELECT MAX(updated_at) FROM blocks), to_timestamp(0)),
                       COALESCE((SELECT MAX(updated_at) FROM public.census_pass), to_timestamp(0))
                     ),
  'years', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'year', y.year,
             'blocks', y.blocks,
             'firstPassDone', y.first_pass_done,
             'serialsLeft', y.serials_left,
             'pendingPasses', COALESCE(p.pending_passes, 0),
             'passSerialsPending', COALESCE(p.pending_serials, 0),
             'passesDone', COALESCE(c.captured_passes, 0)) ORDER BY y.year)
      FROM per_year y
      LEFT JOIN passes   p ON p.year = y.year
      LEFT JOIN captured c ON c.year = y.year
  ), '[]'::jsonb)
);
$$;

GRANT EXECUTE ON FUNCTION public.census_plan() TO anon, authenticated;

-- ────────────────────────────────────────────────────────── read surface ──
-- The ledger names blocks, so it is service-role only; the aggregate function
-- above is the only public door, and it returns counts.

ALTER TABLE public.census_block_walk ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.census_pass ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.census_session_watch ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS census_block_walk_admin_read ON public.census_block_walk;
DROP POLICY IF EXISTS census_pass_admin_read ON public.census_pass;
DROP POLICY IF EXISTS census_session_watch_admin_read ON public.census_session_watch;

GRANT ALL ON public.census_block_walk TO service_role;
GRANT ALL ON public.census_pass TO service_role;
GRANT ALL ON public.census_session_watch TO service_role;
GRANT SELECT ON public.census_work TO service_role;

REVOKE ALL ON public.census_block_walk FROM anon, authenticated;
REVOKE ALL ON public.census_pass FROM anon, authenticated;
REVOKE ALL ON public.census_session_watch FROM anon, authenticated;
REVOKE ALL ON public.census_work FROM anon, authenticated;
