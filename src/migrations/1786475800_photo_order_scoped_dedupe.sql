-- Order-scoped photo dedupe + order-wide serialization (Codex round 41).
--
-- The degraded-storage failure mode: localStorage rejects every write,
-- so the client's bind-before-upload and post-success removal live only
-- in page memory. After a reload, the stale PERSISTED entry reappears in
-- its old unbound state, and the next box on the same order would
-- consume it — attaching an already-attached image to a second shipment.
-- The client cannot fix this (nothing can be persisted in that mode), so
-- the server closes it:
--
-- 1. The idempotent same-content short-circuit widens from the target
--    shipment to ALL non-voided shipments of the SAME ORDER: identical
--    image bytes anywhere on the order return the EXISTING photo's id.
--    A byte-identical JPEG cannot honestly depict the contents of two
--    different boxes, so collapsing is correct even for a deliberate
--    double-attach (the round-27 identical-bytes argument, order-wide).
--    A stale resurrected stash entry therefore converges to "already
--    attached" no matter which shipment consumes it — no duplicate row,
--    no wrong-box evidence, on any client storage state.
-- 2. Both photo mutators now take pg_advisory_xact_lock(42001, order)
--    BEFORE the shipment row lock (the draft-delete's existing order:
--    42001 -> row), so the cross-shipment dedupe read is stable — a
--    sibling shipment's photo cannot be mid-delete while the add
--    acknowledges it (the round-36 dangle, closed order-wide).
--    Everything else (strict JPEG gate, dual-hash tombstone guard,
--    post-insert quota, tombstone content) is unchanged.

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

  -- unlocked peek for the order id (immutable on a shipment row), so the
  -- advisory lock precedes the row lock — the creators' order
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

  -- idempotent replay, ORDER-scoped: this exact image already rides on
  -- some live shipment of this order
  SELECT sp.id INTO v_photo_id
  FROM shipment_photos sp
  JOIN shipments s2 ON s2.id = sp.shipment_id
  WHERE s2.order_id = v_shipment.order_id
    AND COALESCE(s2.refund_status, '') <> 'SUCCESS'
    AND encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex') = v_hash
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_photo_id;
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

CREATE OR REPLACE FUNCTION delete_shipment_photo(
  p_photo_id    bigint,
  p_shipment_id bigint,
  p_actor       text
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id bigint;
  v_shipment shipments%ROWTYPE;
  v_photo    shipment_photos%ROWTYPE;
BEGIN
  SELECT s.order_id INTO v_order_id FROM shipments s WHERE s.id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(42001, v_order_id::int);

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
