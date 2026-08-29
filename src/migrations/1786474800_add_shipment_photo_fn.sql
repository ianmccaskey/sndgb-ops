-- add_shipment_photo: serialize photo attaches per shipment and enforce the
-- quota on the POST-insert totals.
--
-- Why a plpgsql function (Codex round 26, finding 1): the single-statement
-- INSERT..SELECT gate in addShipmentPhoto checked only the PRE-insert
-- count/sum, so a shipment just under the cap still accepted one more
-- photo — and two concurrent uploads could both pass the gate against the
-- same statement snapshot and overshoot together. A row lock alone cannot
-- fix the second problem inside one statement: under READ COMMITTED the
-- statement's snapshot predates the lock wait, so the resumed statement
-- cannot see the row the other uploader committed (the same EvalPlanQual
-- staleness that forced set_product_digital into plpgsql). In plpgsql each
-- statement takes a fresh snapshot, so the quota read AFTER the lock is
-- acquired sees everything committed while we waited.
--
-- Serialization: FOR UPDATE on the parent shipments row. No advisory lock
-- class is needed — a photo attach touches exactly one shipment, takes no
-- other locks, and so cannot participate in the 42001/42007/42006
-- hierarchy's orderings. refund_status is re-proved under the same lock.
--
-- Refusals return zero rows (the contract addShipmentPhoto's callers
-- already handle); the caps are 5 photos and 5,000,000 chars of aggregate
-- image_data per shipment INCLUDING the incoming photo.

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
