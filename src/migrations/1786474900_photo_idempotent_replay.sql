-- add_shipment_photo v2: idempotent replay (Codex round 27, finding 2).
--
-- The client cannot distinguish "the INSERT committed but the response was
-- lost" from "the INSERT never happened" — and its durable retry stash
-- replays ambiguous failures. Without a server-side guard, a replay of a
-- committed upload inserts the same image twice, burning the 5-photo /
-- 5MB quota on duplicates until legitimate photos are refused.
--
-- Fix: under the same parent-row lock (fresh snapshot), a photo whose
-- image bytes already exist on this shipment (md5 equality; at most 5
-- rows to scan) short-circuits and returns the EXISTING row's id — no
-- second insert, no second audit row. Identical bytes are identical
-- evidence, so collapsing them is correct even for a deliberate
-- double-attach. Everything else is unchanged from 1786474800.

CREATE OR REPLACE FUNCTION add_shipment_photo(
  p_shipment_id bigint,
  p_image_data  text,
  p_thumb_data  text,
  p_actor       text
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
