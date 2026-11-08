-- One switch at a time, under the member's lock, with a fresh read.
--
-- Codex review of the first P2 Collective Orders writer (2026-11-08): it
-- upserted BOTH flags from the dialog's last-loaded state, so two admins
-- flipping different switches could silently undo each other, and its
-- "old" values came from the statement's snapshot, which can predate a
-- write it waited on. Same shape as record_vendor_payment_batch
-- (1790102200): plpgsql, so the advisory lock is its own statement and the
-- read that follows sees everything committed before the lock was granted.
--
-- set_member_access(member, section, open, actor):
--   * section 'group_buys' | 'store', open 'true' | 'false' (text: UI Bakery
--     params arrive as text); anything else, or an unknown member, changes
--     nothing and returns no row.
--   * lock 42003 on the member id (what the first writer used), then read
--     the member's row FOR UPDATE — or the defaults (true, true) when there
--     is none — then set the ONE flag asked for, keeping the other as it
--     is NOW, not as the admin's screen showed it.
--   * a flip that changes nothing returns no row and writes nothing (so
--     "open" on a member with no row is a no-op, not a row of defaults).
--   * otherwise upsert, audit old → new into public.audit_log
--     ('storefront.member_access', member_access, with the section named),
--     and return the member's whole state.
-- Owner-only: P2 Collective Orders connects as the owner. The storefront
-- role never calls it (it only reads the table).

CREATE OR REPLACE FUNCTION storefront.set_member_access(
  p_member_id text, p_section text, p_open text, p_actor text
)
RETURNS TABLE (member_id text, group_buys boolean, store boolean, changed boolean)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_id        uuid;
  v_section   text    := lower(btrim(coalesce(p_section, '')));
  v_open_txt  text    := lower(btrim(coalesce(p_open, '')));
  v_actor     text    := coalesce(nullif(btrim(p_actor), ''), 'admin');
  v_open      boolean;
  v_old_gb    boolean;
  v_old_store boolean;
  v_new_gb    boolean;
  v_new_store boolean;
BEGIN
  IF v_section NOT IN ('group_buys', 'store') OR v_open_txt NOT IN ('true', 'false') THEN
    RETURN;
  END IF;
  SELECT u.id INTO v_id FROM neon_auth."user" u WHERE u.id::text = lower(btrim(coalesce(p_member_id, '')));
  IF v_id IS NULL THEN
    RETURN;
  END IF;

  -- its own statement: everything below reads what was committed before the lock was granted
  PERFORM pg_advisory_xact_lock(42003, hashtext(v_id::text));

  SELECT ma.group_buys, ma.store INTO v_old_gb, v_old_store
  FROM storefront.member_access ma WHERE ma.auth_user_id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    v_old_gb := true; v_old_store := true;
  END IF;

  v_open      := (v_open_txt = 'true');
  v_new_gb    := CASE WHEN v_section = 'group_buys' THEN v_open ELSE v_old_gb END;
  v_new_store := CASE WHEN v_section = 'store'      THEN v_open ELSE v_old_store END;
  IF v_new_gb = v_old_gb AND v_new_store = v_old_store THEN
    RETURN;   -- already so: nothing written, no row back
  END IF;

  INSERT INTO storefront.member_access (auth_user_id, group_buys, store, updated_at, updated_by)
  VALUES (v_id, v_new_gb, v_new_store, now(), v_actor)
  ON CONFLICT (auth_user_id) DO UPDATE
    SET group_buys = EXCLUDED.group_buys, store = EXCLUDED.store,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.member_access', v_id::text, 'member_access', v_actor,
          jsonb_build_object('group_buys', v_old_gb, 'store', v_old_store),
          jsonb_build_object('group_buys', v_new_gb, 'store', v_new_store, 'section', v_section));

  RETURN QUERY SELECT v_id::text, v_new_gb, v_new_store, true;
END
$fn$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103700_set_member_access.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103700_set_member_access.sql');
