-- An organizer claims a giveaway prize for its winner.
--
-- Ian, 2026-11-24: "I want to be able to manually claim/end the giveaway so
-- if a person we want to have the prize is chosen they dont have to claim
-- themselves we can do it for them". A drawn winner has claim_minutes to
-- press Claim on Home, else the prize is drawn again (1790104300). From
-- P2 Collective Orders an admin can now claim it for them inside that same
-- window: the win is theirs, the window stops, and nothing is redrawn.
--
-- The rules, for every writer:
--   * Only a LIVE, UNCLAIMED winner whose window is still open. The window
--     binds the organizers too (CHECK giveaway_winners_claim_in_time): once
--     it closes the slot is being drawn again, and a redrawn or expired
--     winner is history. A claimed winner returns created = false.
--   * The same 42040 lock as the member's claim and the redraw, so a
--     member's own claim, the organizer's and the expiry redraw never both
--     land: whichever holds the lock first decides.
--   * When the prize ships, the ship-to on the member's account at that
--     moment is snapshotted, as the member's own claim does, through ONE
--     rule both claims share (giveaway_ship_to). A member with no complete
--     address is still claimed for, with no ship-to: the organizers get it
--     from them. The member's own claim still requires one.
--   * claimed_by names the organizer (NULL = the winner claimed). Members
--     only ever learn THAT the P² Team claimed it, never who. A claim is
--     final, claimed_by included (guard trigger below).
--   * Audited `giveaway_claimed_for` with the slot and whether a ship-to
--     was on file; never the address or the member's email.

ALTER TABLE storefront.giveaway_winners
  ADD COLUMN IF NOT EXISTS claimed_by TEXT;

ALTER TABLE storefront.giveaway_winners DROP CONSTRAINT IF EXISTS giveaway_winners_claimed_by_shape;
ALTER TABLE storefront.giveaway_winners ADD CONSTRAINT giveaway_winners_claimed_by_shape
  CHECK (claimed_by IS NULL OR (claimed_at IS NOT NULL AND btrim(claimed_by) <> ''));

COMMENT ON COLUMN storefront.giveaway_winners.claimed_by IS
  'The organizer who claimed this prize for the winner (P2 Collective Orders actor); NULL when the winner claimed it or nobody has. Written only by storefront.giveaway_claim_for().';

-- A draw is a record (1790104300), and now so is who claimed it. The
-- forfeit and claim checks run first, so no update that also clears the
-- member (account deletion) can rewrite a claim or a forfeit on the way.
CREATE OR REPLACE FUNCTION storefront.giveaway_winners_guard()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.giveaway_id <> OLD.giveaway_id OR NEW.slot <> OLD.slot
     OR NEW.drawn_at <> OLD.drawn_at OR NEW.claim_deadline <> OLD.claim_deadline THEN
    RAISE EXCEPTION 'giveaway winner %: the giveaway, slot, draw time and claim deadline never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.forfeited_at IS NOT NULL AND (NEW.forfeited_at IS DISTINCT FROM OLD.forfeited_at
       OR NEW.forfeit_reason IS DISTINCT FROM OLD.forfeit_reason OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
       OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by) THEN
    RAISE EXCEPTION 'giveaway winner %: a forfeit is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.claimed_at IS NOT NULL AND (NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
       OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by) THEN
    RAISE EXCEPTION 'giveaway winner %: a claim is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.auth_user_id IS NOT NULL AND NEW.auth_user_id IS NULL THEN
    NEW.username := NULL;
    NEW.display_name := NULL;
    NEW.ship_to := NULL;
    IF NEW.forfeited_at IS NULL AND NEW.claimed_at IS NULL THEN
      NEW.forfeited_at := clock_timestamp();
      NEW.forfeit_reason := 'account_deleted';
      NEW.forfeited_by := 'member';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
    RAISE EXCEPTION 'giveaway winner %: a draw never changes hands', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

-- The ship-to a claim snapshots: the member's account address when it is
-- complete (line 1, city, state, ZIP), else NULL. One rule for both claims.
CREATE OR REPLACE FUNCTION storefront.giveaway_ship_to(p_auth_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $fn$
  SELECT jsonb_build_object('name', p.display_name, 'phone', p.phone, 'line1', p.address_line1,
                            'line2', p.address_line2, 'city', p.city, 'state', p.state_code,
                            'postalCode', p.postal_code)
  FROM storefront.customer_profiles p
  WHERE p.auth_user_id = p_auth_user_id
    AND coalesce(btrim(p.address_line1), '') <> '' AND coalesce(btrim(p.city), '') <> ''
    AND coalesce(btrim(p.state_code), '') <> '' AND coalesce(btrim(p.postal_code), '') <> ''
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_ship_to(uuid) FROM PUBLIC;

-- The winner claims inside their window (1790104300, unchanged but for the
-- ship-to now read through giveaway_ship_to). When the prize ships, the
-- ship-to on their profile at this moment is what the organizers send it to.
CREATE OR REPLACE FUNCTION storefront.giveaway_claim(p_winner_id bigint, p_auth_user_id uuid)
RETURNS TABLE (winner_id bigint, giveaway_id bigint, claimed_at timestamptz, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_gid  bigint;
  w      storefront.giveaway_winners%ROWTYPE;
  g      storefront.giveaways%ROWTYPE;
  v_now  timestamptz;
  v_ship jsonb;
BEGIN
  SELECT x.giveaway_id INTO v_gid FROM storefront.giveaway_winners x WHERE x.id = p_winner_id;
  IF v_gid IS NULL OR p_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'That prize isn''t yours to claim.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(42040, hashtext(v_gid::text));

  v_now := clock_timestamp();
  SELECT * INTO w FROM storefront.giveaway_winners x WHERE x.id = p_winner_id FOR UPDATE;
  IF NOT FOUND OR w.auth_user_id IS DISTINCT FROM p_auth_user_id THEN
    RAISE EXCEPTION 'That prize isn''t yours to claim.' USING ERRCODE = 'no_data_found';
  END IF;
  IF w.forfeited_at IS NOT NULL THEN
    IF w.forfeit_reason = 'expired' THEN
      RAISE EXCEPTION 'The claim window closed, so this prize was drawn again.' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RAISE EXCEPTION 'The P² Team drew this prize again.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.claimed_at IS NOT NULL THEN
    RETURN QUERY SELECT w.id, w.giveaway_id, w.claimed_at, false;
    RETURN;
  END IF;
  IF v_now >= w.claim_deadline THEN
    RAISE EXCEPTION 'The claim window has closed, so this prize will be drawn again.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = w.giveaway_id;
  IF g.prize_ships THEN
    v_ship := storefront.giveaway_ship_to(p_auth_user_id);
    IF v_ship IS NULL THEN
      RAISE EXCEPTION 'Add your ship-to address under Account, then claim.'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'field:ship_to';
    END IF;
  END IF;

  UPDATE storefront.giveaway_winners x SET claimed_at = v_now, ship_to = v_ship WHERE x.id = w.id;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaway_winners', w.id::text, 'giveaway_claimed', p_auth_user_id::text, NULL,
          jsonb_build_object('giveawayId', w.giveaway_id, 'slot', w.slot, 'ships', g.prize_ships));

  RETURN QUERY SELECT w.id, w.giveaway_id, v_now, true;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_claim(bigint, uuid) FROM PUBLIC;

-- An organizer claims for the winner (P2 Collective Orders; owner-only).
-- ship_to_on_file: a prize that ships had a complete address to snapshot.
CREATE OR REPLACE FUNCTION storefront.giveaway_claim_for(p_actor text, p_winner_id text)
RETURNS TABLE (winner_id bigint, giveaway_id bigint, claimed_at timestamptz, created boolean, ship_to_on_file boolean)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_wid   bigint;
  v_gid   bigint;
  w       storefront.giveaway_winners%ROWTYPE;
  g       storefront.giveaways%ROWTYPE;
  v_now   timestamptz;
  v_ship  jsonb;
BEGIN
  v_wid := storefront.giveaway_parse_int(p_winner_id, 'winner', 1, 2147483647, 'That winner is no longer listed. Reload.');
  SELECT x.giveaway_id INTO v_gid FROM storefront.giveaway_winners x WHERE x.id = v_wid;
  IF v_gid IS NULL THEN
    RAISE EXCEPTION 'That winner is no longer listed. Reload.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(42040, hashtext(v_gid::text));

  v_now := clock_timestamp();
  SELECT * INTO w FROM storefront.giveaway_winners x WHERE x.id = v_wid FOR UPDATE;
  IF w.forfeited_at IS NOT NULL THEN
    IF w.forfeit_reason = 'expired' THEN
      RAISE EXCEPTION 'Their claim window closed, so the prize was drawn again. Reload.' USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSIF w.forfeit_reason = 'account_deleted' THEN
      RAISE EXCEPTION 'They deleted their account, so the prize was drawn again. Reload.' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RAISE EXCEPTION 'That winner was already redrawn. Reload.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.claimed_at IS NOT NULL THEN
    RETURN QUERY SELECT w.id, w.giveaway_id, w.claimed_at, false, w.ship_to IS NOT NULL;
    RETURN;
  END IF;
  IF w.auth_user_id IS NULL THEN
    RAISE EXCEPTION 'That winner''s account is gone. Reload.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_now >= w.claim_deadline THEN
    RAISE EXCEPTION 'Their claim window has closed, so the prize is being drawn again. Reload in a minute.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = w.giveaway_id;
  IF g.prize_ships THEN
    v_ship := storefront.giveaway_ship_to(w.auth_user_id);
  END IF;

  UPDATE storefront.giveaway_winners x
  SET claimed_at = v_now, claimed_by = v_actor, ship_to = v_ship
  WHERE x.id = w.id;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaway_winners', w.id::text, 'giveaway_claimed_for', v_actor, NULL,
          jsonb_build_object('giveawayId', w.giveaway_id, 'slot', w.slot, 'ships', g.prize_ships,
                             'shipToOnFile', v_ship IS NOT NULL));

  RETURN QUERY SELECT w.id, w.giveaway_id, v_now, true, v_ship IS NOT NULL;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_claim_for(text, text) FROM PUBLIC;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790105600_giveaway_claim_for.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790105600_giveaway_claim_for.sql');
