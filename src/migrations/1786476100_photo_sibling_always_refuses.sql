-- add_shipment_photo v11: a sibling match REFUSES for every caller
-- (Codex round 51, finding 2).
--
-- v9 kept order-scoped convergence for replay=true: a replay whose
-- bytes matched a SIBLING shipment was acknowledged with the sibling's
-- id. But a timed-out DELIBERATE attach leaves its stash entry bound,
-- and a later automatic retry of that entry runs with replay semantics
-- — if the original request never committed and the bytes already ride
-- another live box, convergence would report success for a shipment the
-- operator never chose, and the client would clear its only recovery
-- copy. Rather than threading operator-intent flags through every
-- client path, the server closes the class outright: NO caller is ever
-- acknowledged against a shipment other than its target.
--   - TARGET-shipment same-bytes match: idempotent success (unchanged —
--     this is the truth for retries of committed uploads).
--   - SIBLING match (same order, other live shipment): REFUSE, always.
--     The client's refused paths turn the entry into a visible
--     "recovered" photo for the operator to resolve — no duplicate row,
--     no wrong-box ack, nothing invisible. (The round-41 degraded-
--     storage resurrection now ends as a visible recovered item instead
--     of a silent convergence — strictly safer.)
--   - Tombstone guard unchanged: replay=true refuses bytes the
--     shipment's delete tombstones contain; deliberate adds may always
--     re-attach.
--
-- (Finding 1 of the same round — that delete_shipment_photo skips the
-- order lock — is REFUTED: the LIVE function text, from 1786475800,
-- takes pg_advisory_xact_lock(42001, order) BEFORE the shipment row
-- lock; migrations are immutable history and the latest text wins.
-- 1786475600 is superseded. Sibling reads run under that same order
-- lock, so a sibling row cannot be mid-delete while an add reads it.)

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

  -- idempotent same-bytes match on the TARGET shipment: success for all
  SELECT sp.id INTO v_photo_id
  FROM shipment_photos sp
  WHERE sp.shipment_id = p_shipment_id
    AND encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex') = v_hash
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_photo_id;
    RETURN;
  END IF;

  -- same bytes on a SIBLING live shipment: REFUSE, every caller — no
  -- path may acknowledge a box the caller did not target
  IF EXISTS (
    SELECT 1
    FROM shipment_photos sp
    JOIN shipments s2 ON s2.id = sp.shipment_id
    WHERE s2.order_id = v_shipment.order_id
      AND s2.id <> p_shipment_id
      AND COALESCE(s2.refund_status, '') <> 'SUCCESS'
      AND encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex') = v_hash
  ) THEN
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
