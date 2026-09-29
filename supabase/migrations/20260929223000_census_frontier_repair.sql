-- ═══════════════════════════════════════════════════════════════════════════
--  Census ledger repair — the frontier of a block that has already been read.
--
--  Why this exists
--  ---------------
--  `20260929193000_census_maintenance.sql` seeds `census_block_walk` from the
--  cursors the first pass left behind. It copies each block's measured bound, its
--  offset and the semesters it captured, but `frontier` — "the highest serial that
--  answered for a student" — has no source in a cursor, so it kept its default of
--  zero.
--
--  That is not a cosmetic gap. `census_work` reads a finished block as outstanding
--  work whenever `max_serial > frontier`, so a frontier of zero makes every
--  finished block look like it grew out of nothing: the walk resumes at serial 001
--  and re-reads the whole block. And the observations table has no uniqueness
--  constraint, by design — an observation is a fact about a student-semester, and
--  the same fact served twice is not something the database can call a duplicate —
--  so a re-read appends a second copy of rows the census has already counted. That
--  is the single failure mode this whole design exists to prevent.
--
--  The repair is exact, not a heuristic: a block whose cursor says `done` was read
--  to its end, so its frontier *is* its measured bound. Writing it back keeps
--  `max_serial > frontier` meaning "the portal has moved past what was read"
--  instead of "nobody recorded a frontier", which is the distinction growth
--  detection rests on.
--
--  The view is then replaced to close the shape of row rather than the instance:
--  a finished block with no recorded frontier is left alone instead of re-read,
--  because there is nothing recorded to resume from and re-reading it cannot be
--  made idempotent. Losing growth detection on a row in that state is strictly
--  better than duplicating the population, and the state no longer occurs.
--
--  Idempotent: the update only touches a frontier that is still zero, and the view
--  is replaced rather than created.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.census_block_walk
   SET frontier = max_serial,
       updated_at = now()
 WHERE first_pass_at IS NOT NULL
   AND frontier = 0
   AND max_serial > 0;

CREATE OR REPLACE VIEW public.census_work AS
WITH watch AS (
  SELECT w.year, unnest(w.semesters) AS semester
    FROM public.census_session_watch w
),
-- A first pass resumes at the right place for its state:
--
--   • never finished — at the offset the last slice reached, which is where it
--     stopped probing;
--   • finished, but the measurement has since moved past the frontier — at the
--     frontier, because everything above it missed when it was read, and a serial
--     that answers now is a student who was not there before. That is what catches
--     a college admitting late, and it cannot duplicate a row: a serial above the
--     frontier has never produced one;
--   • finished with no frontier recorded — not work. There is no read position to
--     resume from, and starting at 001 would append a second copy of observations
--     this table cannot deduplicate. `20260929223000` repairs the rows that were
--     in that state; this arm keeps a future one from being walked.
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
     AND (
       b.first_pass_at IS NULL
       OR (b.frontier > 0 AND b.max_serial > b.frontier)
     )
),
-- A maintenance pass sweeps a block from its first serial up to the frontier,
-- because the students are below the frontier and there is nothing above it to
-- re-read. `serial_offset` is therefore always zero here and `serials_left` is
-- the sweep length: the unit of work is "read this one semester for these
-- students", not "carry on from where the first pass stopped".
-- A block needs a semester re-read when the portal serves it and the block has
-- not captured it. `first_pass_sessions` holds only semesters the portal actually
-- published, so "the portal serves S7 for 2023 and no 2023 block has S7" arrives
-- here as work by itself — nobody has to notice that BPUT published something.
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
