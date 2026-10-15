-- ────────────────────────────────────── the census counter, and its one blind spot ──
--
-- `census_live.observations` is maintained by a trigger that only fires on INSERT,
-- but `census_apply_pass()` maintains the fact table by DELETING a block-and-semester's
-- rows and storing what the re-read found. Nothing ever decremented the counter, so
-- it only climbs, once per replaced row, forever. The public counter read 1,313,945
-- on 2026-10-15, and the row count it reports is one the dashboard puts in front of
-- readers, so it is the kind of figure this project is not allowed to be wrong about.
-- It also silently breaks the documented invariant that a re-read replaces a semester
-- rather than doubling it.
--
-- How much has drifted is deliberately not asserted here. The fact table has no public
-- read path (anon and authenticated are granted only the aggregate function), so the
-- true count is not knowable from the publishable key. Rather than guess at it, this
-- migration recounts at the end and returns the real figure: whatever that differs
-- from 1,313,945 by is the drift that had banked up.
--
-- The fix is symmetric with the INSERT trigger, and that already-banked drift is
-- reconciled in the same transaction, so the counter is exact the moment this
-- migration lands and stays exact afterwards.

-- ───────────────────────────────────────────────── count the rows that left ──
-- Statement-level with a transition table: one write per statement no matter how
-- many rows it removed, so a 960-row maintenance pass costs one update instead of
-- 960. `GREATEST` keeps a counter that is somehow already behind from going
-- negative, which would violate the column's CHECK and roll back the caller's
-- whole maintenance pass — a data problem turning into an outage.

CREATE OR REPLACE FUNCTION public.census_live_on_event_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removed bigint;
BEGIN
  SELECT COUNT(*) INTO v_removed FROM deleted;

  IF v_removed = 0 THEN
    RETURN NULL;
  END IF;

  UPDATE public.census_live
     SET observations = GREATEST(observations - v_removed, 0),
         updated_at   = now()
   WHERE id = 1;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_live_on_event_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS census_live_on_event_delete ON public.bput_census_events;
CREATE TRIGGER census_live_on_event_delete
  AFTER DELETE ON public.bput_census_events
  REFERENCING OLD TABLE AS deleted
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.census_live_on_event_delete();

-- ──────────────────────────────────────────── recount, for the bulk paths ──
-- TRUNCATE fires no row trigger, and an operator emptying the table by hand would
-- otherwise leave the counter describing rows that no longer exist. This is also
-- the reconciliation the migration itself uses below, so it is exercised on the
-- way in rather than being a function nobody has ever run.

CREATE OR REPLACE FUNCTION public.census_live_recount()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.bput_census_events;

  UPDATE public.census_live
     SET observations  = v_count,
         last_batch_at = (SELECT MAX(served_at) FROM public.bput_census_events),
         updated_at    = now()
   WHERE id = 1;

  RETURN v_count;
END;
$$;

-- service_role only: this counts the whole fact table, so it is a lever anyone
-- signed in could otherwise pull in a loop. The crawler and the reconciliation
-- above both hold the service role; a panel never needs it.
REVOKE EXECUTE ON FUNCTION public.census_live_recount() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.census_live_recount() FROM anon;
REVOKE EXECUTE ON FUNCTION public.census_live_recount() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.census_live_recount() TO service_role;

CREATE OR REPLACE FUNCTION public.census_live_on_event_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.census_live_recount();
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.census_live_on_event_truncate() FROM PUBLIC;

DROP TRIGGER IF EXISTS census_live_on_event_truncate ON public.bput_census_events;
CREATE TRIGGER census_live_on_event_truncate
  AFTER TRUNCATE ON public.bput_census_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.census_live_on_event_truncate();

-- ─────────────────────────────────────────── reconcile what has already drifted ──
-- One statement, inside this migration's transaction, so a concurrent insert
-- simply waits on the counter's row lock and then applies its own increment.
-- After this the counter equals the fact table, and the delete trigger above is
-- what keeps it there.

SELECT public.census_live_recount();
