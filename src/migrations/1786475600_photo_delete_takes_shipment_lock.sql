-- delete_shipment_photo v2: contend on the parent shipment row lock
-- (Codex round 36).
--
-- The v1 delete removed the shipment_photos row without touching the
-- shipments row, while add_shipment_photo serializes only on
-- shipments ... FOR UPDATE. Interleaving: a delete transaction removes
-- the row (uncommitted); a concurrent replay, holding the shipment
-- lock, still SEES the pre-delete version under MVCC, returns the old
-- id as an idempotent success, the client releases its stashed retry
-- copy — then the delete commits. Photo gone, retry copy gone.
--
-- Fix: the delete locks the parent shipments row FOR UPDATE first —
-- the same lock domain as add_shipment_photo and delete_shipment_draft
-- — so add and delete serialize. Either order is now correct:
--   add first  -> replay attaches/acks, delete then removes it with a
--                 tombstone (a deliberate operator delete of an
--                 attached photo — exactly the normal flow);
--   delete first -> the add's post-lock statement runs on a fresh
--                 snapshot (plpgsql, READ COMMITTED), misses the row,
--                 falls through to the tombstone check, and the replay
--                 REFUSES — the client keeps its copy as recovered.
-- The concurrent interleaving is enforced by construction (identical
-- row-lock + fresh-snapshot argument as rounds 26/29); sequential
-- behavior re-proven on a branch.

CREATE OR REPLACE FUNCTION delete_shipment_photo(
  p_photo_id    bigint,
  p_shipment_id bigint,
  p_actor       text
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_shipment shipments%ROWTYPE;
  v_photo    shipment_photos%ROWTYPE;
BEGIN
  -- serialize with add_shipment_photo (and the draft-delete cascade)
  SELECT * INTO v_shipment FROM shipments s
  WHERE s.id = p_shipment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  DELETE FROM shipment_photos sp
  WHERE sp.id = p_photo_id
    AND sp.shipment_id = p_shipment_id
  RETURNING sp.* INTO v_photo;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
  VALUES ('shipment_photos', v_photo.id::text, 'shipment_photo_deleted', p_actor,
          jsonb_build_object('shipment_id', v_photo.shipment_id,
                             'bytes', length(v_photo.image_data),
                             'image_sha256', encode(sha256(convert_to(v_photo.image_data, 'UTF8')), 'hex'),
                             'thumb_data', v_photo.thumb_data,
                             'taken_by', v_photo.created_by,
                             'taken_at', v_photo.created_at));

  RETURN QUERY SELECT v_photo.id;
END;
$$;
