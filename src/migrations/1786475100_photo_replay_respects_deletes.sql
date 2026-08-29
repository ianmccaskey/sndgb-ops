-- add_shipment_photo v3: automatic replays cannot resurrect deleted
-- evidence (Codex round 30, finding 2).
--
-- The client's durable retry stash replays ambiguous upload failures on
-- the next dialog open. If an operator explicitly deleted that photo in
-- between, the old same-content short-circuit no longer matched (the row
-- is gone) and the replay re-inserted the image the operator removed —
-- silent state reversal, quota consumed, audit muddied.
--
-- Fix: a new p_replay flag distinguishes the AUTOMATIC replay path from
-- deliberate operator adds. Under the same parent-row lock, a replay is
-- refused when the delete tombstones (audit_log shipment_photo_deleted
-- rows, written by deleteShipmentPhoto and delete_shipment_draft) show
-- this exact image (md5) was explicitly removed from this shipment. A
-- deliberate re-add (p_replay = false) skips the tombstone check — the
-- operator can always re-attach on purpose. Check order matters: the
-- existing-row short-circuit runs FIRST, so a replay of a still-present
-- photo stays idempotent; the tombstone check only decides when the row
-- is absent.
--
-- The 4-arg signature is dropped (a 5th DEFAULT would make 4-arg calls
-- ambiguous); the wrapper action always passes all five.

DROP FUNCTION IF EXISTS add_shipment_photo(bigint, text, text, text);

CREATE OR REPLACE FUNCTION add_shipment_photo(
  p_shipment_id bigint,
  p_image_data  text,
  p_thumb_data  text,
  p_actor       text,
  p_replay      boolean
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_shipment shipments%ROWTYPE;
  v_count    bigint;
  v_bytes    bigint;
  v_photo_id bigint;
BEGIN
  -- payload shape gates (cheap, no lock needed)
  IF p_image_data IS NULL OR p_image_data NOT LIKE 'data:image/%'
     OR length(p_image_data) NOT BETWEEN 100 AND 1500000 THEN
    RETURN;
  END IF;
  IF p_thumb_data IS NULL OR p_thumb_data NOT LIKE 'data:image/%'
     OR length(p_thumb_data) NOT BETWEEN 100 AND 80000 THEN
    RETURN;
  END IF;

  -- serialize per shipment; re-prove existence + not refund-voided under lock
  SELECT * INTO v_shipment FROM shipments s
  WHERE s.id = p_shipment_id
  FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_shipment.refund_status, '') = 'SUCCESS' THEN
    RETURN;
  END IF;

  -- idempotent replay: this exact image already rides on this shipment
  SELECT sp.id INTO v_photo_id
  FROM shipment_photos sp
  WHERE sp.shipment_id = p_shipment_id
    AND md5(sp.image_data) = md5(p_image_data)
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_photo_id;
    RETURN;
  END IF;

  -- an AUTOMATIC replay must not resurrect explicitly deleted evidence
  IF p_replay AND EXISTS (
    SELECT 1 FROM audit_log a
    WHERE a.table_name = 'shipment_photos'
      AND a.action = 'shipment_photo_deleted'
      AND a.old_data->>'shipment_id' = p_shipment_id::text
      AND a.old_data->>'image_md5' = md5(p_image_data)
  ) THEN
    RETURN;
  END IF;

  -- fresh snapshot after the lock wait: quota on the POST-insert totals
  SELECT count(*), COALESCE(sum(length(sp.image_data)), 0)
  INTO v_count, v_bytes
  FROM shipment_photos sp WHERE sp.shipment_id = p_shipment_id;
  IF v_count + 1 > 5 OR v_bytes + length(p_image_data) > 5000000 THEN
    RETURN;
  END IF;

  INSERT INTO shipment_photos (shipment_id, image_data, thumb_data, created_by)
  VALUES (p_shipment_id, p_image_data, p_thumb_data, p_actor)
  RETURNING shipment_photos.id INTO v_photo_id;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('shipment_photos', v_photo_id::text, 'shipment_photo_added', p_actor,
          jsonb_build_object('shipment_id', p_shipment_id,
                             'bytes', length(p_image_data)));

  RETURN QUERY SELECT v_photo_id;
END;
$$;
