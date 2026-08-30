-- add_shipment_photo v9: sibling-shipment convergence is for automatic
-- replays ONLY (Codex round 42, finding 2).
--
-- v8's order-scoped dedupe returned the sibling's photo id for ANY add,
-- so a deliberate attach to box B whose bytes already rode box A was
-- acknowledged as success — the client cleared its recovery copy while
-- the evidence stayed on the other box, and the operator was misled.
-- Split by intent:
--   - TARGET-scoped same-content match: idempotent success for every
--     caller (the photo really is on the shipment being attached to).
--   - SIBLING match (same order, other non-voided shipment):
--       replay=true  -> converge: return the existing id. The automatic
--         replay of a stale resurrected entry reached the box the photo
--         actually committed to earlier; acknowledging it is the truth.
--       replay=false -> REFUSE (zero rows): a deliberate attach must not
--         be reported as success against the wrong box. The client's
--         refused path keeps the photo visible (recovered) and its
--         message names the duplicate-on-another-box cause; the operator
--         decides.
-- Locks (42001 order -> shipment row), strict JPEG gate, dual-hash
-- tombstone guard, and quota unchanged from v8.

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

  -- idempotent same-content match on the TARGET shipment: success for
  -- every caller
  SELECT sp.id INTO v_photo_id
  FROM shipment_photos sp
  WHERE sp.shipment_id = p_shipment_id
    AND encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex') = v_hash
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_photo_id;
    RETURN;
  END IF;

  -- same bytes on a SIBLING shipment of this order (stable under the
  -- order lock): converge for automatic replays, refuse deliberate adds
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
