-- The organizers can open the store to ONE member by hand.
--
-- Ian, 2026-11-27: "HOW CAN I MANUALLY TURN ON STORE ACCESS FOR THEM THEY
-- ARE HAVING ISSUES WITH TELEGRAM LINKING", then "Yes, build it". Until now
-- the store opened only to a member with a verified Telegram or Discord link
-- (storefront.customer_identities), and the Store switch of 1790103500 was a
-- veto, never a grant. Seven members were stuck because Telegram reported
-- the account they connected as outside the P² group, and a link row written
-- by hand would not hold: the storefront's six-hourly group sweep deletes any
-- Telegram link the Bot API places outside the group.
--
-- So the grant lives on the member's access row, apart from the links:
--   * store_granted_at / _by / store_grant_reason — set together or not at
--     all (CHECK), with a reason the team writes (≤ 500 characters). The
--     sweep never touches this table, so the grant holds until an organizer
--     takes it back.
--   * the storefront (lib/store/queries.ts storeAccess) opens the store to a
--     member with a link OR a grant; the Store switch (store = false) still
--     wins over both. It covers the STORE only: giveaways keep requiring a
--     verified link (the giveaway_* functions read customer_identities, not
--     this), and so does the seller dashboard.
--   * a member opened by hand has no handle, so their store orders carry
--     none (telegram_username / discord_username are NULL, as for a member
--     who disconnected after placing).
--
-- set_member_store_grant(member, open, reason, actor):
--   * open 'true' | 'false' (text: UI Bakery params arrive as text); anything
--     else, or an unknown member, changes nothing and returns no row.
--   * opening needs a reason: a blank one RAISEs a plain sentence
--     (invalid_parameter_value, HINT field:reason), as does one over 500.
--   * lock 42003 on the member id (the same lock as set_member_access, so the
--     two writers of this row queue behind each other), THEN read the row
--     FOR UPDATE: what follows sees every write committed before the lock.
--   * opening a member already opened by hand, or taking back a grant that
--     is not there, writes nothing and returns no row (the dialog re-reads).
--   * otherwise write the grant (a member with no row gets one with both
--     sections open, which is what "no row" already meant), stamp
--     updated_at / updated_by like the switches, audit old → new into
--     public.audit_log ('storefront.member_access', member_store_grant /
--     member_store_grant_revoked), and return the member's grant state.
-- Owner-only: P2 Collective Orders connects as the owner. The storefront
-- reads the columns (its role, when it exists, gets SELECT through
-- 1790101500's "ALL TABLES IN SCHEMA storefront") and never writes them;
-- the P2 Seller Portal role has no grant on this table or function.

ALTER TABLE storefront.member_access
  ADD COLUMN IF NOT EXISTS store_granted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS store_granted_by   TEXT,
  ADD COLUMN IF NOT EXISTS store_grant_reason TEXT;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'member_access_store_grant_whole'
      AND conrelid = 'storefront.member_access'::regclass
  ) THEN
    ALTER TABLE storefront.member_access
      ADD CONSTRAINT member_access_store_grant_whole CHECK (
        (store_granted_at IS NULL AND store_granted_by IS NULL AND store_grant_reason IS NULL)
        OR (store_granted_at IS NOT NULL
            AND btrim(coalesce(store_granted_by, '')) <> ''
            AND btrim(coalesce(store_grant_reason, '')) <> ''
            AND char_length(store_grant_reason) <= 500)
      );
  END IF;
END
$do$;

COMMENT ON COLUMN storefront.member_access.store_granted_at IS
  'Set: the organizers opened the store to this member by hand (no Telegram/Discord link needed). store = false still closes it. Giveaways and selling still need a link.';

CREATE OR REPLACE FUNCTION storefront.set_member_store_grant(
  p_member_id text, p_open text, p_reason text, p_actor text
)
RETURNS TABLE (
  member_id text,
  store_granted boolean,
  store_granted_at timestamptz,
  store_granted_by text,
  store_grant_reason text,
  changed boolean
)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_id         uuid;
  v_open_txt   text := lower(btrim(coalesce(p_open, '')));
  v_reason     text := btrim(coalesce(p_reason, ''));
  v_actor      text := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_old_at     timestamptz;
  v_old_by     text;
  v_old_reason text;
  v_now        timestamptz := now();
BEGIN
  IF v_open_txt NOT IN ('true', 'false') THEN
    RETURN;
  END IF;
  SELECT u.id INTO v_id FROM neon_auth."user" u WHERE u.id::text = lower(btrim(coalesce(p_member_id, '')));
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  IF v_open_txt = 'true' AND v_reason = '' THEN
    RAISE EXCEPTION 'Say why the store is being opened for this member.'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:reason';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Keep the reason to 500 characters.'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:reason';
  END IF;

  -- its own statement: everything below reads what was committed before the lock was granted
  PERFORM pg_advisory_xact_lock(42003, hashtext(v_id::text));

  SELECT ma.store_granted_at, ma.store_granted_by, ma.store_grant_reason
    INTO v_old_at, v_old_by, v_old_reason
  FROM storefront.member_access ma WHERE ma.auth_user_id = v_id FOR UPDATE;
  -- no row: no grant (the SELECT INTO leaves all three NULL)

  IF v_open_txt = 'true' THEN
    IF v_old_at IS NOT NULL THEN
      RETURN;   -- already opened by hand: nothing written, no row back
    END IF;
    INSERT INTO storefront.member_access
      (auth_user_id, store_granted_at, store_granted_by, store_grant_reason, updated_at, updated_by)
    VALUES (v_id, v_now, v_actor, v_reason, v_now, v_actor)
    ON CONFLICT (auth_user_id) DO UPDATE
      SET store_granted_at   = EXCLUDED.store_granted_at,
          store_granted_by   = EXCLUDED.store_granted_by,
          store_grant_reason = EXCLUDED.store_grant_reason,
          updated_at         = EXCLUDED.updated_at,
          updated_by         = EXCLUDED.updated_by;

    INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
    VALUES ('storefront.member_access', v_id::text, 'member_store_grant', v_actor,
            jsonb_build_object('store_granted', false),
            jsonb_build_object('store_granted', true, 'reason', v_reason));

    RETURN QUERY SELECT v_id::text, true, v_now, v_actor, v_reason, true;
  ELSE
    IF v_old_at IS NULL THEN
      RETURN;   -- no grant to take back
    END IF;
    UPDATE storefront.member_access ma
       SET store_granted_at = NULL, store_granted_by = NULL, store_grant_reason = NULL,
           updated_at = v_now, updated_by = v_actor
     WHERE ma.auth_user_id = v_id;

    INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
    VALUES ('storefront.member_access', v_id::text, 'member_store_grant_revoked', v_actor,
            jsonb_build_object('store_granted', true, 'granted_at', v_old_at, 'granted_by', v_old_by, 'reason', v_old_reason),
            jsonb_build_object('store_granted', false, 'reason', nullif(v_reason, '')));

    RETURN QUERY SELECT v_id::text, false, NULL::timestamptz, NULL::text, NULL::text, true;
  END IF;
END
$fn$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790105700_member_store_grant.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790105700_member_store_grant.sql');
