-- Evidence identity moves from md5 to SHA-256 (Codex round 34,
-- finding 2).
--
-- md5 was the identity for three evidentiary behaviors: duplicate
-- suppression, replay-refusal after deletion, and the tombstone
-- fingerprint proving what was removed. md5 is collision-broken, and
-- the payload is client-supplied (any data:image/%), so a crafted
-- collision could alias two different images — a false idempotent
-- match, or a replay refusal against the wrong evidence, with the audit
-- trail still presenting the hash as proof. SHA-256 everywhere instead:
--   - add_shipment_photo (5-arg) dup check + replay-tombstone check
--   - delete_shipment_draft per-photo tombstones (image_sha256)
--   - the tombstone index, rebuilt on the new key
-- deleteShipmentPhoto's action SQL switches in the same commit. The
-- 4-arg compat overload forwards unchanged. Verified before applying:
-- ZERO shipment_photos rows and ZERO shipment_photo_* audit rows exist
-- in prod (every prior run was on disposable branches), so no legacy
-- md5 tombstones need migrating and the field rename is clean.
-- sha256() is a Postgres built-in (v11+); image_data is text, hashed as
-- encode(sha256(convert_to(<text>, 'UTF8')), 'hex').

DROP INDEX IF EXISTS audit_photo_tombstone_idx;
CREATE INDEX IF NOT EXISTS audit_photo_tombstone_idx
  ON audit_log ((old_data->>'shipment_id'), (old_data->>'image_sha256'))
  WHERE table_name = 'shipment_photos' AND action = 'shipment_photo_deleted';

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
  v_hash     text;
  v_count    bigint;
  v_bytes    bigint;
  v_photo_id bigint;
BEGIN
  IF p_image_data IS NULL OR p_image_data NOT LIKE 'data:image/%'
     OR length(p_image_data) NOT BETWEEN 100 AND 1500000 THEN
    RETURN;
  END IF;
  IF p_thumb_data IS NULL OR p_thumb_data NOT LIKE 'data:image/%'
     OR length(p_thumb_data) NOT BETWEEN 100 AND 80000 THEN
    RETURN;
  END IF;
  v_hash := encode(sha256(convert_to(p_image_data, 'UTF8')), 'hex');

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
    AND encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex') = v_hash
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
      AND a.old_data->>'image_sha256' = v_hash
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

CREATE OR REPLACE FUNCTION delete_shipment_draft(
  p_shipment_id bigint,
  p_actor       text
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id bigint;
  v_shipment shipments%ROWTYPE;
  v_items    jsonb;
  v_photos   bigint;
BEGIN
  SELECT s.order_id INTO v_order_id FROM shipments s WHERE s.id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(42001, v_order_id::int);

  SELECT * INTO v_shipment FROM shipments s
  WHERE s.id = p_shipment_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_shipment.finalized_at IS NOT NULL
     OR (v_shipment.purchase_started_at IS NOT NULL
         AND v_shipment.purchase_started_at >= now() - interval '10 minutes')
     OR (v_shipment.purchase_attempted_at IS NOT NULL
         AND v_shipment.attempt_verified_no_label_at IS NULL) THEN
    RETURN;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('order_item_id', i.order_item_id, 'qty', i.qty)), '[]'::jsonb)
  INTO v_items
  FROM shipment_items i WHERE i.shipment_id = p_shipment_id;

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
  SELECT 'shipment_photos', sp.id::text, 'shipment_photo_deleted', p_actor,
         jsonb_build_object('shipment_id', sp.shipment_id,
                            'bytes', length(sp.image_data),
                            'image_sha256', encode(sha256(convert_to(sp.image_data, 'UTF8')), 'hex'),
                            'thumb_data', sp.thumb_data,
                            'taken_at', sp.created_at, 'taken_by', sp.created_by,
                            'reason', 'draft_deleted')
  FROM shipment_photos sp WHERE sp.shipment_id = p_shipment_id;
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  DELETE FROM shipments s WHERE s.id = p_shipment_id;

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
  VALUES ('shipments', p_shipment_id::text, 'shipment_draft_deleted', p_actor,
          jsonb_build_object('order_id', v_shipment.order_id,
                             'shippo_rate_id', v_shipment.shippo_rate_id,
                             'rate_amount', v_shipment.rate_amount,
                             'items', v_items,
                             'photos_deleted', v_photos));

  RETURN QUERY SELECT p_shipment_id;
END;
$$;
