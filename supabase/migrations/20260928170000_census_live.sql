-- ═══════════════════════════════════════════════════════════════════════════
--  Census live counter, makes a running crawl watchable as it works.
--
--  Why this exists
--  ---------------
--  The census is a long job driven by a scheduler, so the landing page cannot
--  learn about progress by watching its own network activity. It needs the
--  database to tell it: one aggregate row, maintained by trigger, that every
--  open dashboard subscribes to. A batch landing in the portal therefore reaches
--  the page in about a second instead of at the next poll.
--
--  What it deliberately does NOT hold
--  ----------------------------------
--  Counts and a timestamp. Not "the newest observation", not the newest branch
--  or semester. This row is world-readable, and one row is not k-anonymous, so
--  the published cells stay pooled at 25 observations and this row says only how
--  much has been collected, never where from.
--
--  Applying it
--  -----------
--  Idempotent: IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS before each
--  create, and the realtime publication add wrapped so a re-run cannot fail on
--  duplicate_object. The seed UPDATE re-derives the counters from the fact
--  tables, so re-running it repairs drift rather than compounding it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────── counter row ────

CREATE TABLE IF NOT EXISTS public.census_live (
  id            integer     PRIMARY KEY CHECK (id = 1),
  observations  bigint      NOT NULL DEFAULT 0 CHECK (observations >= 0),
  visited       bigint      NOT NULL DEFAULT 0 CHECK (visited >= 0),
  not_found     bigint      NOT NULL DEFAULT 0 CHECK (not_found >= 0),
  ranges        integer     NOT NULL DEFAULT 0 CHECK (ranges >= 0),
  active        boolean     NOT NULL DEFAULT false,
  last_batch_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.census_live IS
  'Single-row realtime counter for the BPUT census. Counts only: never a branch, semester or observation tuple, because this row is publicly readable.';

INSERT INTO public.census_live (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Derive the counters from the fact tables instead of trusting defaults, so a
-- fresh install and a re-run both describe the data that actually exists.
UPDATE public.census_live
   SET observations  = (SELECT COUNT(*)::bigint FROM public.bput_census_events),
       visited       = (SELECT COALESCE(SUM(visited), 0)::bigint FROM public.bput_census_cursor),
       not_found     = (SELECT COALESCE(SUM(not_found), 0)::bigint FROM public.bput_census_cursor),
       ranges        = (SELECT COUNT(*)::integer FROM public.bput_census_cursor),
       last_batch_at = (SELECT MAX(served_at) FROM public.bput_census_events),
       updated_at    = now()
 WHERE id = 1;

-- ─────────────────────────────────────────── maintain on observation insert ─
-- Row-level and incremental: a 200-row batch costs 200 cheap updates inside the
-- same transaction, rather than 200 full-table recounts. The whole batch commits
-- together, so subscribers see one broadcast per flush rather than 200.

CREATE OR REPLACE FUNCTION public.census_live_on_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.census_live
     SET observations  = observations + 1,
         last_batch_at = GREATEST(COALESCE(last_batch_at, NEW.served_at), NEW.served_at),
         updated_at    = now()
   WHERE id = 1;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_live_on_event() FROM PUBLIC;

DROP TRIGGER IF EXISTS census_live_on_event ON public.bput_census_events;
CREATE TRIGGER census_live_on_event
  AFTER INSERT ON public.bput_census_events
  FOR EACH ROW
  EXECUTE FUNCTION public.census_live_on_event();

-- ────────────────────────────────────────────── maintain on cursor change ──
-- Progress counters live on the cursor, which is written once per flush, so this
-- one recounts the (tiny) cursor table rather than trying to add deltas.

CREATE OR REPLACE FUNCTION public.census_live_on_cursor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.census_live
     SET visited   = (SELECT COALESCE(SUM(visited), 0)::bigint FROM public.bput_census_cursor),
         not_found = (SELECT COALESCE(SUM(not_found), 0)::bigint FROM public.bput_census_cursor),
         ranges    = (SELECT COUNT(*)::integer FROM public.bput_census_cursor),
         active    = COALESCE((
           SELECT BOOL_OR(status = 'running' AND updated_at > now() - interval '3 minutes')
             FROM public.bput_census_cursor
         ), false),
         updated_at = now()
   WHERE id = 1;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_live_on_cursor() FROM PUBLIC;

DROP TRIGGER IF EXISTS census_live_on_cursor ON public.bput_census_cursor;
CREATE TRIGGER census_live_on_cursor
  AFTER INSERT OR UPDATE ON public.bput_census_cursor
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.census_live_on_cursor();

-- ────────────────────────────────────────────────────────── read surface ──

ALTER TABLE public.census_live ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS census_live_public_read ON public.census_live;
CREATE POLICY census_live_public_read ON public.census_live
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.census_live TO anon, authenticated;
GRANT ALL ON public.census_live TO service_role;

-- Full old-row payload so an UPDATE broadcast identifies the row it changed.
ALTER TABLE public.census_live REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.census_live;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END;
$$;

-- ───────────────────────────────────────────── progress: honest liveness ──
-- `active` was any range whose status said 'running', which left a crashed tick
-- claiming to be alive forever. It now also requires a recent write, so the
-- indicator means "a runner wrote recently", not "a runner intended to run".
-- `lastBatchAt` separates "the crawl is moving" from "the crawl is speaking".

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
    'lastBatchAt',   (SELECT MAX(served_at) FROM public.bput_census_events),
    'active',        COALESCE(
                       BOOL_OR(status = 'running' AND updated_at > now() - interval '3 minutes'),
                       false
                     )
  )
  FROM public.bput_census_cursor;
$$;

GRANT EXECUTE ON FUNCTION public.census_progress() TO anon, authenticated;
