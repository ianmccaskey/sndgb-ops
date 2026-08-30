-- add_shipment_photo v10: the quota counts what is actually stored
-- (Codex round 48, finding 2).
--
-- The 5MB per-shipment cap summed only image_data, but every row also
-- stores a thumbnail (<=80KB by CHECK) — five worst-case thumbs could
-- push real storage ~400KB past the documented ceiling while the gate
-- reported "within quota". The byte accounting now includes thumb_data
-- for both existing rows and the incoming payload, so the enforced
-- bound equals the stored bound. Everything else is unchanged from v9.
--
-- (The same round claimed the 42001 advisory lock's order_id::int cast
-- is an overflow bug. REFUTED, recorded here: that cast is the
-- repo-wide 42001 convention — 43 occurrences across 38 files (every
-- order-serialized action and function) share it, so "fixing" it only
-- in the photo functions would SPLIT the lock domain and break the
-- serialization itself; a coordinated repo-wide key change is the only
-- correct form of that fix and is out of scope. The practical bound:
-- order ids are bigserial counting real customer orders — 618 orders,
-- max id 31,078 today — and an out-of-range id fails closed with an
-- error, never with silent corruption.)

CREATE OR REPLACE FUNCTION add_shipment_photo(
  p_shipment_id bigint,
  p_image_data  text,
  p_thumb_data  text,
  p_actor       text,
  p_replay      boolean
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id bigint;
  v_shipment shipments%ROWTYPE;
  v_hash     text;
  v_count    bigint;
  v_bytes    bigint;
  v_photo_id bigint;
BEGIN
  IF p_image_data IS NULL OR p_image_data NOT LIKE 'data:image/jpeg;base64,%'
     OR length(p_image_data) NOT BETWEEN 100 AND 1500000 THEN
    RETURN;
  END IF;
  IF p_thumb_data IS NULL OR p_thumb_data NOT LIKE 'data:image/jpeg;base64,%'
     OR length(p_thumb_data) NOT BETWEEN 100 AND 80000 THEN
    RETURN;
  END IF;
  v_hash := encode(sha256(convert_to(p_image_data, 'UTF8')), 'hex');

  SELECT s.order_id INTO v_order_id FROM shipments s WHERE s.id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(42001, v_order_id::int);

  SELECT * INTO v_shipment FROM shipments s
  WHERE s.id = p_shipment_id
  FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_shipment.refund_status, '') = 'SUCCESS' THEN
    RETURN;
  END IF;

  SELECT sp.id INTO v_photo_id
  FROM shipment_photos sp
  WHERE sp.shipment_id = p_shipment_id
    AND encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex') = v_hash
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_photo_id;
    RETURN;
  END IF;

  SELECT sp.id INTO v_photo_id
  FROM shipment_photos sp
  JOIN shipments s2 ON s2.id = sp.shipment_id
  WHERE s2.order_id = v_shipment.order_id
    AND s2.id <> p_shipment_id
    AND COALESCE(s2.refund_status, '') <> 'SUCCESS'
    AND encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex') = v_hash
  LIMIT 1;
  IF FOUND THEN
    IF p_replay THEN
      RETURN QUERY SELECT v_photo_id;
    END IF;
    RETURN;
  END IF;

  IF p_replay AND (
    EXISTS (
      SELECT 1 FROM audit_log a
      WHERE a.table_name = 'shipment_photos'
        AND a.action = 'shipment_photo_deleted'
        AND a.old_data->>'shipment_id' = p_shipment_id::text
        AND a.old_data->>'image_sha256' = v_hash
    )
    OR EXISTS (
      SELECT 1 FROM audit_log a
      WHERE a.table_name = 'shipment_photos'
        AND a.action = 'shipment_photo_deleted'
        AND a.old_data->>'shipment_id' = p_shipment_id::text
        AND a.old_data->>'image_md5' = md5(p_image_data)
    )
  ) THEN
    RETURN;
  END IF;

  -- quota on the POST-insert totals of EVERYTHING stored: full images
  -- AND thumbnails, existing plus incoming
  SELECT count(*), COALESCE(sum(length(sp.image_data) + length(sp.thumb_data)), 0)
  INTO v_count, v_bytes
  FROM shipment_photos sp WHERE sp.shipment_id = p_shipment_id;
  IF v_count + 1 > 5
     OR v_bytes + length(p_image_data) + length(p_thumb_data) > 5000000 THEN
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
