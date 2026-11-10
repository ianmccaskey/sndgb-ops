-- Take a drawn giveaway off members' Home, and put it back.
--
-- Ian, 2026-11-10. After its draw a giveaway stays on Home: the winners'
-- announcement for up to an hour, then the "previous winners" line at the
-- foot of the next live giveaway for seven days. The organizers can take it
-- off from P2 Collective Orders (a test run, an announcement they would
-- rather not leave up) and put it back. Hidden means members' Home skips it
-- everywhere it would show, and a member's own past result in it (claimed,
-- missed, redrawn) is not shown either.
--
-- What hiding never does: void a win. A winner whose claim window is still
-- open keeps their OWN claim panel on Home (they were emailed a link to it),
-- an expired claim is still redrawn, and a redraw still emails its winner,
-- who claims from that panel. Hiding changes what members see, not who won.
--
-- Only a DRAWN giveaway is hidden. One still running (or ended and about to
-- be drawn) is cancelled instead: members can't enter what they can't see.
-- The CHECK below holds that for every writer, and the admin function holds
-- the 42040 lock as the other admin writes do (1790104300).

ALTER TABLE storefront.giveaways
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hidden_by TEXT;

ALTER TABLE storefront.giveaways DROP CONSTRAINT IF EXISTS giveaways_hidden_shape;
ALTER TABLE storefront.giveaways ADD CONSTRAINT giveaways_hidden_shape
  CHECK ((hidden_at IS NULL) = (hidden_by IS NULL));

ALTER TABLE storefront.giveaways DROP CONSTRAINT IF EXISTS giveaways_hidden_drawn;
ALTER TABLE storefront.giveaways ADD CONSTRAINT giveaways_hidden_drawn
  CHECK (hidden_at IS NULL OR drawn_at IS NOT NULL);

COMMENT ON COLUMN storefront.giveaways.hidden_at IS
  'Set: the organizers took this drawn giveaway off members'' Home (announcement and previous-winners line). A winner''s own open claim still shows. Written only by storefront.giveaway_set_hidden().';
COMMENT ON COLUMN storefront.giveaways.hidden_by IS
  'Who took it off Home (the P2 Collective Orders actor); NULL while it shows.';

-- Take it off Home (p_hidden 'true') or put it back ('false'). Idempotent:
-- asking for the state it is already in changes nothing and writes no audit.
CREATE OR REPLACE FUNCTION storefront.giveaway_set_hidden(p_actor text, p_id text, p_hidden text)
RETURNS TABLE (id bigint, hidden boolean, changed boolean)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_id    bigint;
  v_hide  boolean;
  g       storefront.giveaways%ROWTYPE;
BEGIN
  v_id := storefront.giveaway_parse_int(p_id, 'id', 1, 2147483647, 'That giveaway no longer exists. Reload.');
  v_hide := CASE lower(btrim(coalesce(p_hidden, ''))) WHEN 'true' THEN true WHEN 'false' THEN false END;
  IF v_hide IS NULL THEN
    RAISE EXCEPTION 'Say whether to take it off Home or put it back.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:hidden';
  END IF;

  PERFORM pg_advisory_xact_lock(42040, hashtext(v_id::text));

  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That giveaway no longer exists. Reload.' USING ERRCODE = 'no_data_found';
  END IF;
  IF g.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'It was cancelled, so members don''t see it.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF g.drawn_at IS NULL THEN
    RAISE EXCEPTION 'Its winners aren''t drawn yet. Cancel it, or end it now and then take it off Home.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF (g.hidden_at IS NOT NULL) = v_hide THEN
    RETURN QUERY SELECT v_id, v_hide, false;
    RETURN;
  END IF;

  UPDATE storefront.giveaways x
     SET hidden_at = CASE WHEN v_hide THEN clock_timestamp() END,
         hidden_by = CASE WHEN v_hide THEN v_actor END
   WHERE x.id = v_id;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaways', v_id::text, CASE WHEN v_hide THEN 'giveaway_hidden' ELSE 'giveaway_shown' END, v_actor,
          jsonb_build_object('hiddenAt', g.hidden_at, 'hiddenBy', g.hidden_by),
          jsonb_build_object('hidden', v_hide));

  RETURN QUERY SELECT v_id, v_hide, true;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_set_hidden(text, text, text) FROM PUBLIC;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104400_giveaway_hidden.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104400_giveaway_hidden.sql');
