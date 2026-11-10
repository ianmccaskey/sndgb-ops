-- Giveaways for p2collective.app members.
--
-- Ian, 2026-11-09. The organizers set up a giveaway in P2 Collective Orders
-- (/store/giveaways): a prize, how long it runs, how many winners. While it
-- runs, every member's Home shows it with a countdown, the number of
-- entrants and an Enter button. Entering takes a signed-in member with a
-- verified Telegram or Discord account (the store's rule; the per-member
-- Store switch does NOT apply, suspension does). When the countdown ends the
-- winners are drawn at random; each winner has `claim_minutes` (30 by
-- default) to claim in the app, or the prize is drawn again from the
-- entrants nobody has drawn yet. An organizer can force a redraw of any
-- winner from the admin page. Winners are shown to members by the handle
-- they verified with, never by name or email.
--
-- ONE implementation, TWO entry points (as 1790103600): every rule is in
-- the functions below. The storefront calls the member path
-- (giveaway_enter, giveaway_claim, giveaway_settle, giveaway_take_notice,
-- giveaway_due_ids) with the member id taken from its own session, never
-- from the request; P2 Collective Orders calls the admin path
-- (giveaway_create, _update, _end_now, _cancel, _reroll) as the owner with
-- its usual actor. The member path is SECURITY DEFINER with a pinned
-- search_path, so the storefront role (1790101500, when applied) needs only
-- EXECUTE on those five; it gets SELECT on the tables through its default
-- privileges and no write grant is to be added.
--
-- Locks: advisory class 42040 keyed by hashtext(giveaway id), as its own
-- statement, so every read after it sees what was committed before it was
-- granted. Entering holds it SHARED (members enter at once, side by side);
-- the draw, a claim, a redraw and every admin write hold it EXCLUSIVE. So
-- no entry commits into a giveaway being drawn (the entry re-reads the row
-- and the clock after the lock), and a claim at the last second and the
-- redraw of its slot run one after the other, judged by one clock
-- (clock_timestamp()).
--
-- The draw: `ORDER BY gen_random_uuid()` (Postgres's strong random source)
-- over entrants who are still eligible at that moment (a verified identity,
-- not banned) and were never drawn in this giveaway. A slot nobody is left
-- to fill stays empty and the giveaway is marked pool-exhausted, so it is
-- not retried. Every refusal RAISEs a plain sentence:
-- invalid_parameter_value + HINT 'field:<name>' for input, no_data_found
-- for "not yours / gone", object_not_in_prerequisite_state for the wrong
-- moment, insufficient_privilege for eligibility. Audit rows go to
-- public.audit_log with camelCase payloads and never carry an email or a
-- ship-to.

-- ============ Tables ============

CREATE TABLE IF NOT EXISTS storefront.giveaways (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prize             TEXT NOT NULL CHECK (prize = btrim(prize) AND char_length(prize) BETWEEN 1 AND 80),
  details           TEXT CHECK (details IS NULL OR (details = btrim(details) AND char_length(details) BETWEEN 1 AND 2000)),
  winners_count     INTEGER NOT NULL CHECK (winners_count BETWEEN 1 AND 20),
  claim_minutes     INTEGER NOT NULL DEFAULT 30 CHECK (claim_minutes BETWEEN 5 AND 1440),
  prize_ships       BOOLEAN NOT NULL DEFAULT true,       -- true: a claim snapshots the winner's ship-to
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  drawn_at          TIMESTAMPTZ,
  entrants_at_draw  INTEGER CHECK (entrants_at_draw IS NULL OR entrants_at_draw >= 0),
  pool_exhausted_at TIMESTAMPTZ,                         -- a draw found nobody left to draw
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT giveaways_window CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '30 days'),
  CONSTRAINT giveaways_cancel_shape CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CONSTRAINT giveaways_drawn_not_cancelled CHECK (drawn_at IS NULL OR cancelled_at IS NULL),
  CONSTRAINT giveaways_drawn_shape CHECK ((drawn_at IS NULL) = (entrants_at_draw IS NULL)),
  -- one giveaway at a time, for every writer (range gist is built in)
  CONSTRAINT giveaways_one_at_a_time EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (cancelled_at IS NULL)
);

COMMENT ON TABLE storefront.giveaways IS
  'Member giveaways (P2 Collective Orders writes through storefront.giveaway_* functions; the storefront shows them on Home). One at a time.';

CREATE TABLE IF NOT EXISTS storefront.giveaway_entries (
  giveaway_id  BIGINT NOT NULL REFERENCES storefront.giveaways(id),
  auth_user_id UUID NOT NULL REFERENCES storefront.customer_profiles(auth_user_id) ON DELETE CASCADE,
  entered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (giveaway_id, auth_user_id)
);
CREATE INDEX IF NOT EXISTS giveaway_entries_member_idx ON storefront.giveaway_entries (auth_user_id);

COMMENT ON TABLE storefront.giveaway_entries IS
  'One entry per member per giveaway, written only by storefront.giveaway_enter().';

-- One row per draw of a slot. A forfeited row stays as the record; the
-- slot's live winner is the row with forfeited_at IS NULL.
CREATE TABLE IF NOT EXISTS storefront.giveaway_winners (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  giveaway_id         BIGINT NOT NULL REFERENCES storefront.giveaways(id),
  slot                INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 20),
  auth_user_id        UUID REFERENCES storefront.customer_profiles(auth_user_id) ON DELETE SET NULL,
  -- the handle shown to members, from the identity they verified with (newest), at the draw
  provider            storefront.identity_provider,
  username            TEXT,
  display_name        TEXT,
  drawn_at            TIMESTAMPTZ NOT NULL,
  claim_deadline      TIMESTAMPTZ NOT NULL,
  claimed_at          TIMESTAMPTZ,
  ship_to             JSONB,                             -- snapshot at the claim, when the prize ships
  forfeited_at        TIMESTAMPTZ,
  forfeit_reason      TEXT CHECK (forfeit_reason IN ('expired', 'rerolled', 'account_deleted')),
  forfeited_by        TEXT,
  forfeit_note        TEXT,
  notified_won_at     TIMESTAMPTZ,
  notified_claimed_at TIMESTAMPTZ,
  notified_forfeit_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (giveaway_id, auth_user_id),                    -- nobody is drawn twice in one giveaway
  CONSTRAINT giveaway_winners_deadline CHECK (claim_deadline > drawn_at),
  CONSTRAINT giveaway_winners_forfeit_shape CHECK ((forfeited_at IS NULL) = (forfeit_reason IS NULL)),
  CONSTRAINT giveaway_winners_claim_in_time CHECK (claimed_at IS NULL OR claimed_at < claim_deadline),
  CONSTRAINT giveaway_winners_expired_unclaimed CHECK (forfeit_reason IS DISTINCT FROM 'expired' OR claimed_at IS NULL),
  CONSTRAINT giveaway_winners_ship_to_claimed CHECK (ship_to IS NULL OR claimed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS giveaway_winners_live_slot
  ON storefront.giveaway_winners (giveaway_id, slot) WHERE forfeited_at IS NULL;
CREATE INDEX IF NOT EXISTS giveaway_winners_member_idx ON storefront.giveaway_winners (auth_user_id);
CREATE INDEX IF NOT EXISTS giveaway_winners_pending_idx
  ON storefront.giveaway_winners (claim_deadline) WHERE forfeited_at IS NULL AND claimed_at IS NULL;

COMMENT ON TABLE storefront.giveaway_winners IS
  'Every draw of a giveaway slot: the live winner has forfeited_at NULL. Written only by storefront.giveaway_* functions.';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['giveaways', 'giveaway_winners']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON storefront.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON storefront.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
  END LOOP;
END $$;

-- A draw is a record: what was drawn, when and until when never changes; a
-- claim and a forfeit are final. When the member's account is deleted
-- (customer_profiles row gone → auth_user_id SET NULL by the FK) the row
-- keeps its slot but drops what identified them, and a pending claim is
-- forfeited so the slot is drawn again.
CREATE OR REPLACE FUNCTION storefront.giveaway_winners_guard()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.giveaway_id <> OLD.giveaway_id OR NEW.slot <> OLD.slot
     OR NEW.drawn_at <> OLD.drawn_at OR NEW.claim_deadline <> OLD.claim_deadline THEN
    RAISE EXCEPTION 'giveaway winner %: the giveaway, slot, draw time and claim deadline never change', OLD.id
      USING ERRCODE = 'check_violation';
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
  IF OLD.forfeited_at IS NOT NULL AND (NEW.forfeited_at IS DISTINCT FROM OLD.forfeited_at
       OR NEW.forfeit_reason IS DISTINCT FROM OLD.forfeit_reason OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at) THEN
    RAISE EXCEPTION 'giveaway winner %: a forfeit is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'giveaway winner %: a claim is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS giveaway_winners_guard ON storefront.giveaway_winners;
CREATE TRIGGER giveaway_winners_guard BEFORE UPDATE ON storefront.giveaway_winners
  FOR EACH ROW EXECUTE FUNCTION storefront.giveaway_winners_guard();

-- ============ Shared pieces (owner-only) ============

-- Eligible to enter and to be drawn: a verified identity (a row exists only
-- once the provider confirmed it), a Neon Auth user, and no ban in force
-- (lib/auth/ban-rules.ts banActive: banned and open-ended or not expired).
CREATE OR REPLACE FUNCTION storefront.giveaway_member_eligible(p_auth_user_id uuid, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (SELECT 1 FROM storefront.customer_identities ci WHERE ci.auth_user_id = p_auth_user_id)
     AND EXISTS (SELECT 1 FROM neon_auth."user" u
                 WHERE u.id = p_auth_user_id
                   AND NOT (coalesce(u.banned, false) AND (u."banExpires" IS NULL OR u."banExpires" > p_at)))
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_member_eligible(uuid, timestamptz) FROM PUBLIC;

-- Something for giveaway_settle to do: ended and not drawn, a claim window
-- that ran out, or an empty slot while someone may still be left to draw.
CREATE OR REPLACE FUNCTION storefront.giveaway_is_due(p_giveaway_id bigint, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM storefront.giveaways g
    WHERE g.id = p_giveaway_id AND g.cancelled_at IS NULL AND g.ends_at <= p_at
      AND (g.drawn_at IS NULL
           OR EXISTS (SELECT 1 FROM storefront.giveaway_winners w
                      WHERE w.giveaway_id = g.id AND w.forfeited_at IS NULL
                        AND w.claimed_at IS NULL AND w.claim_deadline <= p_at)
           OR (g.pool_exhausted_at IS NULL
               AND (SELECT count(*) FROM storefront.giveaway_winners w
                    WHERE w.giveaway_id = g.id AND w.forfeited_at IS NULL) < g.winners_count)))
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_is_due(bigint, timestamptz) FROM PUBLIC;

-- Fill every empty slot with a random eligible entrant never drawn in this
-- giveaway. The CALLER holds the exclusive lock. Returns who was drawn.
CREATE OR REPLACE FUNCTION storefront.giveaway_fill_slots(p_giveaway_id bigint)
RETURNS uuid[] LANGUAGE plpgsql AS $fn$
DECLARE
  g      storefront.giveaways%ROWTYPE;
  v_now  timestamptz := clock_timestamp();
  v_slot integer;
  v_pick record;
  v_ids  uuid[] := '{}';
BEGIN
  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = p_giveaway_id;
  IF NOT FOUND OR g.drawn_at IS NULL OR g.cancelled_at IS NOT NULL OR g.pool_exhausted_at IS NOT NULL THEN
    RETURN v_ids;
  END IF;
  FOR v_slot IN
    SELECT s FROM generate_series(1, g.winners_count) s
    WHERE NOT EXISTS (SELECT 1 FROM storefront.giveaway_winners w
                      WHERE w.giveaway_id = g.id AND w.slot = s AND w.forfeited_at IS NULL)
    ORDER BY s
  LOOP
    SELECT e.auth_user_id, i.provider, i.username, i.display_name INTO v_pick
    FROM storefront.giveaway_entries e
    CROSS JOIN LATERAL (
      SELECT ci.provider, ci.username, ci.display_name
      FROM storefront.customer_identities ci
      WHERE ci.auth_user_id = e.auth_user_id
      ORDER BY ci.verified_at DESC, ci.id DESC
      LIMIT 1
    ) i
    WHERE e.giveaway_id = g.id
      AND NOT EXISTS (SELECT 1 FROM storefront.giveaway_winners w
                      WHERE w.giveaway_id = g.id AND w.auth_user_id = e.auth_user_id)
      AND storefront.giveaway_member_eligible(e.auth_user_id, v_now)
    ORDER BY gen_random_uuid()
    LIMIT 1;
    IF NOT FOUND THEN
      UPDATE storefront.giveaways x SET pool_exhausted_at = v_now WHERE x.id = g.id;
      EXIT;
    END IF;
    INSERT INTO storefront.giveaway_winners
      (giveaway_id, slot, auth_user_id, provider, username, display_name, drawn_at, claim_deadline)
    VALUES (g.id, v_slot, v_pick.auth_user_id, v_pick.provider, v_pick.username, v_pick.display_name,
            v_now, v_now + make_interval(mins => g.claim_minutes));
    v_ids := v_ids || v_pick.auth_user_id;
  END LOOP;
  RETURN v_ids;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_fill_slots(bigint) FROM PUBLIC;

-- How a time reads in an admin refusal.
CREATE OR REPLACE FUNCTION storefront.giveaway_et(p_at timestamptz)
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT to_char(p_at AT TIME ZONE 'America/New_York', 'Mon FMDD FMHH12:MI AM') || ' ET'
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_et(timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION storefront.giveaway_parse_int(p_txt text, p_field text, p_min integer, p_max integer, p_msg text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  v text := btrim(coalesce(p_txt, ''));
BEGIN
  IF v !~ '^[0-9]{1,7}$' THEN
    RAISE EXCEPTION '%', p_msg USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  IF v::integer < p_min OR v::integer > p_max THEN
    RAISE EXCEPTION '%', p_msg USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  RETURN v::integer;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_parse_int(text, text, integer, integer, text) FROM PUBLIC;

-- An ISO date-time with a zone (the admin page sends toISOString()).
CREATE OR REPLACE FUNCTION storefront.giveaway_parse_ts(p_txt text, p_field text)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v text := btrim(coalesce(p_txt, ''));
  r timestamptz;
BEGIN
  IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    RAISE EXCEPTION 'Pick a date and time.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  BEGIN
    r := v::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'That date and time doesn''t exist.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END;
  RETURN r;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_parse_ts(text, text) FROM PUBLIC;

-- ============ Member path (the storefront; SECURITY DEFINER) ============

-- Enter the live giveaway. Idempotent: a second press returns the entry.
CREATE OR REPLACE FUNCTION storefront.giveaway_enter(p_giveaway_id bigint, p_auth_user_id uuid)
RETURNS TABLE (giveaway_id bigint, entered_at timestamptz, created boolean, entrants integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  g         storefront.giveaways%ROWTYPE;
  v_now     timestamptz;
  v_at      timestamptz;
  v_created boolean := false;
  v_count   integer;
BEGIN
  IF p_giveaway_id IS NULL OR p_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'That giveaway isn''t running any more.' USING ERRCODE = 'no_data_found';
  END IF;

  -- shared: members enter side by side; the draw waits for every entry in flight
  PERFORM pg_advisory_xact_lock_shared(42040, hashtext(p_giveaway_id::text));

  v_now := clock_timestamp();
  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = p_giveaway_id;
  IF NOT FOUND OR g.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'That giveaway isn''t running any more.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_now < g.starts_at THEN
    RAISE EXCEPTION 'This giveaway hasn''t started yet.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_now >= g.ends_at OR g.drawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'Entries closed when the countdown ended.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storefront.customer_profiles cp WHERE cp.auth_user_id = p_auth_user_id) THEN
    RAISE EXCEPTION 'Finish setting up your account first.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storefront.customer_identities ci WHERE ci.auth_user_id = p_auth_user_id) THEN
    RAISE EXCEPTION 'Link Telegram or Discord under Account to enter.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT storefront.giveaway_member_eligible(p_auth_user_id, v_now) THEN
    RAISE EXCEPTION 'This account can''t enter giveaways right now.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO storefront.giveaway_entries AS e (giveaway_id, auth_user_id, entered_at)
  VALUES (g.id, p_auth_user_id, v_now)
  ON CONFLICT (giveaway_id, auth_user_id) DO NOTHING
  RETURNING e.entered_at INTO v_at;

  IF v_at IS NULL THEN
    SELECT e.entered_at INTO v_at FROM storefront.giveaway_entries e
    WHERE e.giveaway_id = g.id AND e.auth_user_id = p_auth_user_id;
  ELSE
    v_created := true;
    INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
    VALUES ('storefront.giveaway_entries', g.id::text || ':' || p_auth_user_id::text, 'giveaway_entered',
            p_auth_user_id::text, NULL, jsonb_build_object('giveawayId', g.id));
  END IF;

  SELECT count(*)::integer INTO v_count FROM storefront.giveaway_entries e WHERE e.giveaway_id = g.id;
  RETURN QUERY SELECT g.id, v_at, v_created, v_count;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_enter(bigint, uuid) FROM PUBLIC;

-- Draw an ended giveaway, forfeit claim windows that ran out, and draw
-- their slots again. Idempotent; cheap when nothing is due. The worker
-- calls it every minute, the storefront's status read when it sees one due.
CREATE OR REPLACE FUNCTION storefront.giveaway_settle(p_giveaway_id bigint, p_actor text DEFAULT 'storefront')
RETURNS TABLE (giveaway_id bigint, drew boolean, expired integer, drawn integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  g          storefront.giveaways%ROWTYPE;
  v_actor    text := coalesce(nullif(btrim(p_actor), ''), 'storefront');
  v_now      timestamptz;
  v_drew     boolean := false;
  v_expired  bigint[] := '{}';
  v_ids      uuid[] := '{}';
  v_entrants integer;
BEGIN
  IF p_giveaway_id IS NULL OR NOT storefront.giveaway_is_due(p_giveaway_id, clock_timestamp()) THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(42040, hashtext(p_giveaway_id::text));

  v_now := clock_timestamp();
  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = p_giveaway_id FOR UPDATE;
  IF NOT FOUND OR g.cancelled_at IS NOT NULL OR g.ends_at > v_now THEN
    RETURN;
  END IF;

  IF g.drawn_at IS NULL THEN
    SELECT count(*)::integer INTO v_entrants FROM storefront.giveaway_entries e WHERE e.giveaway_id = g.id;
    UPDATE storefront.giveaways x SET drawn_at = v_now, entrants_at_draw = v_entrants WHERE x.id = g.id;
    v_ids := storefront.giveaway_fill_slots(g.id);
    v_drew := true;
    INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
    VALUES ('storefront.giveaways', g.id::text, 'giveaway_drawn', v_actor, NULL,
            jsonb_build_object('entrants', v_entrants, 'winnersCount', g.winners_count, 'drawn', to_jsonb(v_ids)));
  ELSE
    WITH x AS (
      UPDATE storefront.giveaway_winners w
      SET forfeited_at = v_now, forfeit_reason = 'expired', forfeited_by = v_actor
      WHERE w.giveaway_id = g.id AND w.forfeited_at IS NULL AND w.claimed_at IS NULL AND w.claim_deadline <= v_now
      RETURNING w.id
    )
    SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}') INTO v_expired FROM x;
    v_ids := storefront.giveaway_fill_slots(g.id);
    IF cardinality(v_expired) > 0 OR cardinality(v_ids) > 0 THEN
      INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
      VALUES ('storefront.giveaways', g.id::text, 'giveaway_redrawn', v_actor, NULL,
              jsonb_build_object('expiredWinnerIds', to_jsonb(v_expired), 'drawn', to_jsonb(v_ids),
                                 'why', CASE WHEN cardinality(v_expired) > 0 THEN 'claim window closed' ELSE 'empty slot' END));
    END IF;
  END IF;

  RETURN QUERY SELECT g.id, v_drew, cardinality(v_expired), cardinality(v_ids);
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_settle(bigint, text) FROM PUBLIC;

-- Every giveaway with something for giveaway_settle to do (the worker's list).
CREATE OR REPLACE FUNCTION storefront.giveaway_due_ids()
RETURNS SETOF bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT g.id FROM storefront.giveaways g
  WHERE g.cancelled_at IS NULL AND g.ends_at <= clock_timestamp()
    AND storefront.giveaway_is_due(g.id, clock_timestamp())
  ORDER BY g.id
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_due_ids() FROM PUBLIC;

-- The winner claims inside their window. When the prize ships, the ship-to
-- on their profile at this moment is what the organizers send it to.
CREATE OR REPLACE FUNCTION storefront.giveaway_claim(p_winner_id bigint, p_auth_user_id uuid)
RETURNS TABLE (winner_id bigint, giveaway_id bigint, claimed_at timestamptz, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_gid  bigint;
  w      storefront.giveaway_winners%ROWTYPE;
  g      storefront.giveaways%ROWTYPE;
  p      storefront.customer_profiles%ROWTYPE;
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
    SELECT * INTO p FROM storefront.customer_profiles cp WHERE cp.auth_user_id = p_auth_user_id;
    IF NOT FOUND OR coalesce(btrim(p.address_line1), '') = '' OR coalesce(btrim(p.city), '') = ''
       OR coalesce(btrim(p.state_code), '') = '' OR coalesce(btrim(p.postal_code), '') = '' THEN
      RAISE EXCEPTION 'Add your ship-to address under Account, then claim.'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'field:ship_to';
    END IF;
    v_ship := jsonb_build_object('name', p.display_name, 'phone', p.phone, 'line1', p.address_line1,
                                 'line2', p.address_line2, 'city', p.city, 'state', p.state_code,
                                 'postalCode', p.postal_code);
  END IF;

  UPDATE storefront.giveaway_winners x SET claimed_at = v_now, ship_to = v_ship WHERE x.id = w.id;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaway_winners', w.id::text, 'giveaway_claimed', p_auth_user_id::text, NULL,
          jsonb_build_object('giveawayId', w.giveaway_id, 'slot', w.slot, 'ships', g.prize_ships));

  RETURN QUERY SELECT w.id, w.giveaway_id, v_now, true;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_claim(bigint, uuid) FROM PUBLIC;

-- Claim-then-send for the member emails: sets the marker once and says
-- whether this caller is the one to send. kind: won | claimed | forfeit
-- (forfeit = the claim window ran out; an organizer's redraw sends nothing).
CREATE OR REPLACE FUNCTION storefront.giveaway_take_notice(p_winner_id bigint, p_kind text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
BEGIN
  IF p_kind = 'won' THEN
    UPDATE storefront.giveaway_winners w SET notified_won_at = clock_timestamp()
    WHERE w.id = p_winner_id AND w.notified_won_at IS NULL AND w.forfeited_at IS NULL
      AND w.claimed_at IS NULL AND w.auth_user_id IS NOT NULL;
  ELSIF p_kind = 'claimed' THEN
    UPDATE storefront.giveaway_winners w SET notified_claimed_at = clock_timestamp()
    WHERE w.id = p_winner_id AND w.notified_claimed_at IS NULL AND w.claimed_at IS NOT NULL
      AND w.forfeited_at IS NULL AND w.auth_user_id IS NOT NULL;
  ELSIF p_kind = 'forfeit' THEN
    UPDATE storefront.giveaway_winners w SET notified_forfeit_at = clock_timestamp()
    WHERE w.id = p_winner_id AND w.notified_forfeit_at IS NULL AND w.forfeit_reason = 'expired'
      AND w.auth_user_id IS NOT NULL;
  ELSE
    RETURN false;
  END IF;
  RETURN FOUND;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_take_notice(bigint, text) FROM PUBLIC;

-- ============ Admin path (P2 Collective Orders; owner-only) ============
-- Params arrive as text (UI Bakery). Times are ISO strings with a zone; an
-- empty start means now. Duration is in minutes (5 minutes to 30 days).

CREATE OR REPLACE FUNCTION storefront.giveaway_create(
  p_actor text, p_prize text, p_details text, p_winners text, p_starts_at text,
  p_duration_minutes text, p_claim_minutes text, p_prize_ships text
)
RETURNS TABLE (id bigint, version text)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
DECLARE
  v_actor    text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_now      timestamptz := clock_timestamp();
  v_prize    text := btrim(coalesce(p_prize, ''));
  v_details  text := nullif(btrim(coalesce(p_details, '')), '');
  v_winners  integer;
  v_minutes  integer;
  v_claim    integer;
  v_ships    boolean;
  v_start    timestamptz;
  v_end      timestamptz;
  v_clash    storefront.giveaways%ROWTYPE;
  v_id       bigint;
  v_version  text;
BEGIN
  IF char_length(v_prize) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Name the prize (up to 80 characters).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:prize';
  END IF;
  IF v_details IS NOT NULL AND char_length(v_details) > 2000 THEN
    RAISE EXCEPTION 'Keep the details to 2,000 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:details';
  END IF;
  v_winners := storefront.giveaway_parse_int(p_winners, 'winners', 1, 20, 'Winners: a whole number from 1 to 20.');
  v_minutes := storefront.giveaway_parse_int(p_duration_minutes, 'duration', 5, 43200, 'Pick how long it runs: 5 minutes to 30 days.');
  v_claim := CASE WHEN btrim(coalesce(p_claim_minutes, '')) = '' THEN 30
                  ELSE storefront.giveaway_parse_int(p_claim_minutes, 'claim_minutes', 5, 1440, 'Claim window: 5 to 1,440 minutes.') END;
  v_ships := lower(btrim(coalesce(p_prize_ships, 'true'))) NOT IN ('false', 'f', '0', 'no');
  IF lower(btrim(coalesce(p_starts_at, ''))) IN ('', 'now') THEN
    v_start := v_now;
  ELSE
    v_start := storefront.giveaway_parse_ts(p_starts_at, 'starts_at');
    IF v_start < v_now - interval '2 minutes' THEN
      RAISE EXCEPTION 'That start time has passed. Start now or pick a later time.'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'field:starts_at';
    END IF;
    v_start := greatest(v_start, v_now);
  END IF;
  v_end := v_start + make_interval(mins => v_minutes);

  SELECT * INTO v_clash FROM storefront.giveaways x
  WHERE x.cancelled_at IS NULL AND tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(v_start, v_end, '[)')
  ORDER BY x.starts_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Another giveaway ("%") runs from % to %. One giveaway runs at a time.',
      v_clash.prize, storefront.giveaway_et(v_clash.starts_at), storefront.giveaway_et(v_clash.ends_at)
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:starts_at';
  END IF;

  BEGIN
    INSERT INTO storefront.giveaways AS x
      (prize, details, winners_count, claim_minutes, prize_ships, starts_at, ends_at, created_by)
    VALUES (v_prize, v_details, v_winners, v_claim, v_ships, v_start, v_end, v_actor)
    RETURNING x.id, extract(epoch FROM x.updated_at)::text INTO v_id, v_version;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'Another giveaway was just set up for that time. Reload and pick another window.'
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:starts_at';
  END;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaways', v_id::text, 'giveaway_created', v_actor, NULL,
          jsonb_build_object('prize', v_prize, 'winnersCount', v_winners, 'claimMinutes', v_claim,
                             'prizeShips', v_ships, 'startsAt', v_start, 'endsAt', v_end));

  RETURN QUERY SELECT v_id, v_version;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_create(text, text, text, text, text, text, text, text) FROM PUBLIC;

-- Before it starts everything can change. While it runs the prize, details,
-- winners, claim window and length can change (the start stays; the end
-- may not pass). Once it has ended nothing changes.
CREATE OR REPLACE FUNCTION storefront.giveaway_update(
  p_actor text, p_id text, p_expected_version text, p_prize text, p_details text, p_winners text,
  p_starts_at text, p_duration_minutes text, p_claim_minutes text, p_prize_ships text
)
RETURNS TABLE (id bigint, version text)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
DECLARE
  v_actor    text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_id       bigint;
  g          storefront.giveaways%ROWTYPE;
  v_now      timestamptz;
  v_prize    text := btrim(coalesce(p_prize, ''));
  v_details  text := nullif(btrim(coalesce(p_details, '')), '');
  v_winners  integer;
  v_minutes  integer;
  v_claim    integer;
  v_ships    boolean;
  v_start    timestamptz;
  v_end      timestamptz;
  v_clash    storefront.giveaways%ROWTYPE;
  v_version  text;
BEGIN
  v_id := storefront.giveaway_parse_int(p_id, 'id', 1, 2147483647, 'That giveaway no longer exists. Reload.');
  IF char_length(v_prize) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Name the prize (up to 80 characters).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:prize';
  END IF;
  IF v_details IS NOT NULL AND char_length(v_details) > 2000 THEN
    RAISE EXCEPTION 'Keep the details to 2,000 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:details';
  END IF;
  v_winners := storefront.giveaway_parse_int(p_winners, 'winners', 1, 20, 'Winners: a whole number from 1 to 20.');
  v_minutes := storefront.giveaway_parse_int(p_duration_minutes, 'duration', 5, 43200, 'Pick how long it runs: 5 minutes to 30 days.');
  v_claim := CASE WHEN btrim(coalesce(p_claim_minutes, '')) = '' THEN 30
                  ELSE storefront.giveaway_parse_int(p_claim_minutes, 'claim_minutes', 5, 1440, 'Claim window: 5 to 1,440 minutes.') END;
  v_ships := lower(btrim(coalesce(p_prize_ships, 'true'))) NOT IN ('false', 'f', '0', 'no');

  PERFORM pg_advisory_xact_lock(42040, hashtext(v_id::text));

  v_now := clock_timestamp();
  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That giveaway no longer exists. Reload.' USING ERRCODE = 'no_data_found';
  END IF;
  IF extract(epoch FROM g.updated_at)::text IS DISTINCT FROM btrim(coalesce(p_expected_version, '')) THEN
    RAISE EXCEPTION 'Someone changed this giveaway since you opened it. Reload and try again.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF g.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This giveaway was cancelled; it can''t be edited.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF g.drawn_at IS NOT NULL OR v_now >= g.ends_at THEN
    RAISE EXCEPTION 'This giveaway has ended, so it can''t be edited.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_now >= g.starts_at THEN
    v_start := g.starts_at;                 -- running: the start stays where it was
    v_end := v_start + make_interval(mins => v_minutes);
    IF v_end < v_now + interval '1 minute' THEN
      RAISE EXCEPTION 'That length would end it in the past. Use End now instead, or make it longer.'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'field:duration';
    END IF;
  ELSE
    IF lower(btrim(coalesce(p_starts_at, ''))) IN ('', 'now') THEN
      v_start := v_now;
    ELSE
      v_start := storefront.giveaway_parse_ts(p_starts_at, 'starts_at');
      IF v_start < v_now - interval '2 minutes' THEN
        RAISE EXCEPTION 'That start time has passed. Start now or pick a later time.'
          USING ERRCODE = 'invalid_parameter_value', HINT = 'field:starts_at';
      END IF;
      v_start := greatest(v_start, v_now);
    END IF;
    v_end := v_start + make_interval(mins => v_minutes);
  END IF;

  SELECT * INTO v_clash FROM storefront.giveaways x
  WHERE x.id <> v_id AND x.cancelled_at IS NULL
    AND tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(v_start, v_end, '[)')
  ORDER BY x.starts_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Another giveaway ("%") runs from % to %. One giveaway runs at a time.',
      v_clash.prize, storefront.giveaway_et(v_clash.starts_at), storefront.giveaway_et(v_clash.ends_at)
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:duration';
  END IF;

  BEGIN
    UPDATE storefront.giveaways x
    SET prize = v_prize, details = v_details, winners_count = v_winners, claim_minutes = v_claim,
        prize_ships = v_ships, starts_at = v_start, ends_at = v_end
    WHERE x.id = v_id
    RETURNING extract(epoch FROM x.updated_at)::text INTO v_version;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'Another giveaway was just set up for that time. Reload and pick another window.'
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:duration';
  END;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaways', v_id::text, 'giveaway_updated', v_actor,
          jsonb_build_object('prize', g.prize, 'winnersCount', g.winners_count, 'claimMinutes', g.claim_minutes,
                             'prizeShips', g.prize_ships, 'startsAt', g.starts_at, 'endsAt', g.ends_at),
          jsonb_build_object('prize', v_prize, 'winnersCount', v_winners, 'claimMinutes', v_claim,
                             'prizeShips', v_ships, 'startsAt', v_start, 'endsAt', v_end));

  RETURN QUERY SELECT v_id, v_version;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_update(text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- Stop a running giveaway now and draw its winners in the same call.
CREATE OR REPLACE FUNCTION storefront.giveaway_end_now(p_actor text, p_id text)
RETURNS TABLE (id bigint, drawn integer)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_id    bigint;
  g       storefront.giveaways%ROWTYPE;
  v_now   timestamptz;
  v_end   timestamptz;
  v_drawn integer;
BEGIN
  v_id := storefront.giveaway_parse_int(p_id, 'id', 1, 2147483647, 'That giveaway no longer exists. Reload.');

  PERFORM pg_advisory_xact_lock(42040, hashtext(v_id::text));

  v_now := clock_timestamp();
  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That giveaway no longer exists. Reload.' USING ERRCODE = 'no_data_found';
  END IF;
  IF g.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This giveaway was cancelled.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_now < g.starts_at THEN
    RAISE EXCEPTION 'It hasn''t started yet. Cancel it instead.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF g.drawn_at IS NOT NULL OR v_now >= g.ends_at THEN
    RAISE EXCEPTION 'It has already ended.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  v_end := greatest(v_now, g.starts_at + interval '1 millisecond');
  UPDATE storefront.giveaways x SET ends_at = v_end WHERE x.id = v_id;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaways', v_id::text, 'giveaway_ended_early', v_actor,
          jsonb_build_object('endsAt', g.ends_at), jsonb_build_object('endsAt', v_end));

  SELECT s.drawn INTO v_drawn FROM storefront.giveaway_settle(v_id, v_actor) s;
  RETURN QUERY SELECT v_id, coalesce(v_drawn, 0);
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_end_now(text, text) FROM PUBLIC;

-- Cancel before the draw (scheduled, running, or ended and not yet drawn).
CREATE OR REPLACE FUNCTION storefront.giveaway_cancel(p_actor text, p_id text, p_reason text)
RETURNS TABLE (id bigint)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
DECLARE
  v_actor  text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id     bigint;
  g        storefront.giveaways%ROWTYPE;
BEGIN
  v_id := storefront.giveaway_parse_int(p_id, 'id', 1, 2147483647, 'That giveaway no longer exists. Reload.');
  IF char_length(v_reason) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'Say why it is cancelled (3 to 300 characters).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:reason';
  END IF;

  PERFORM pg_advisory_xact_lock(42040, hashtext(v_id::text));

  SELECT * INTO g FROM storefront.giveaways x WHERE x.id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That giveaway no longer exists. Reload.' USING ERRCODE = 'no_data_found';
  END IF;
  IF g.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'It was already cancelled.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF g.drawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'Its winners are already drawn. Redraw a winner instead of cancelling.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE storefront.giveaways x SET cancelled_at = clock_timestamp(), cancel_reason = v_reason WHERE x.id = v_id;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaways', v_id::text, 'giveaway_cancelled', v_actor, NULL,
          jsonb_build_object('reason', v_reason));

  RETURN QUERY SELECT v_id;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_cancel(text, text, text) FROM PUBLIC;

-- The organizers' forced redraw: the winner (pending or claimed) forfeits
-- and the slot is drawn again from entrants nobody has drawn yet.
CREATE OR REPLACE FUNCTION storefront.giveaway_reroll(p_actor text, p_winner_id text, p_reason text)
RETURNS TABLE (giveaway_id bigint, slot integer, replaced boolean)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
DECLARE
  v_actor  text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_reason text := btrim(coalesce(p_reason, ''));
  v_wid    bigint;
  v_gid    bigint;
  w        storefront.giveaway_winners%ROWTYPE;
  v_ids    uuid[];
BEGIN
  v_wid := storefront.giveaway_parse_int(p_winner_id, 'winner', 1, 2147483647, 'That winner is no longer listed. Reload.');
  IF char_length(v_reason) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'Say why this winner is redrawn (3 to 300 characters).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:reason';
  END IF;
  SELECT x.giveaway_id INTO v_gid FROM storefront.giveaway_winners x WHERE x.id = v_wid;
  IF v_gid IS NULL THEN
    RAISE EXCEPTION 'That winner is no longer listed. Reload.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(42040, hashtext(v_gid::text));

  SELECT * INTO w FROM storefront.giveaway_winners x WHERE x.id = v_wid FOR UPDATE;
  IF w.forfeited_at IS NOT NULL THEN
    RAISE EXCEPTION 'That winner was already replaced. Reload.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE storefront.giveaway_winners x
  SET forfeited_at = clock_timestamp(), forfeit_reason = 'rerolled', forfeited_by = v_actor,
      forfeit_note = v_reason, ship_to = NULL
  WHERE x.id = v_wid;

  v_ids := storefront.giveaway_fill_slots(v_gid);

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.giveaways', v_gid::text, 'giveaway_rerolled', v_actor,
          jsonb_build_object('winnerId', w.id, 'slot', w.slot, 'wasClaimed', w.claimed_at IS NOT NULL),
          jsonb_build_object('reason', v_reason, 'drawn', to_jsonb(v_ids)));

  RETURN QUERY SELECT v_gid, w.slot, cardinality(v_ids) > 0;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.giveaway_reroll(text, text, text) FROM PUBLIC;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104300_giveaways.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104300_giveaways.sql');
