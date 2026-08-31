-- set_transfer_origin(): serialized origin rewrites (Codex round 1 on
-- the address-groups feature — the plain SQL action's EXISTS checks
-- could race two admins into an A->B / B->C two-hop chain the fns'
-- one-level COALESCE resolution never sees). Locks every row the
-- invariant touches in id order, then validates on FRESH statements
-- (READ COMMITTED per-statement snapshots), then updates + audits.
-- '' / NULL origin clears (the address becomes its own origin).
CREATE OR REPLACE FUNCTION public.set_transfer_origin(p_address_id bigint, p_origin_id bigint, p_actor text)
RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_row receive_addresses%ROWTYPE;
BEGIN
  -- lock EVERY row the one-level invariant touches, in id order (no
  -- deadlock cycles); any conflicting rewrite shares a pivot row, so
  -- the later transaction blocks here and re-validates on FRESH
  -- statements below — an A->B / B->C race can no longer commit a
  -- two-hop chain
  PERFORM 1 FROM receive_addresses ra
  WHERE ra.id = p_address_id
     OR ra.id = p_origin_id
     OR ra.transfer_origin_id = p_address_id
     OR (p_origin_id IS NOT NULL AND ra.transfer_origin_id = p_origin_id)
  ORDER BY ra.id
  FOR UPDATE;

  SELECT * INTO v_row FROM receive_addresses WHERE receive_addresses.id = p_address_id AND active;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_origin_id IS NOT NULL THEN
    IF p_origin_id = p_address_id THEN RETURN; END IF;
    PERFORM 1 FROM receive_addresses o
    WHERE o.id = p_origin_id AND o.active AND o.transfer_origin_id IS NULL;
    IF NOT FOUND THEN RETURN; END IF;
    -- an address other rows route through cannot be re-pointed
    PERFORM 1 FROM receive_addresses m WHERE m.transfer_origin_id = p_address_id;
    IF FOUND THEN RETURN; END IF;
  END IF;

  UPDATE receive_addresses SET transfer_origin_id = p_origin_id WHERE receive_addresses.id = p_address_id;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('receive_addresses', p_address_id::text, 'transfer_origin_set', p_actor,
          jsonb_build_object('label', v_row.label, 'transfer_origin_id', p_origin_id));

  RETURN QUERY SELECT p_address_id::text;
END
$fn$;
