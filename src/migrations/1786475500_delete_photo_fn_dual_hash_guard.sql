-- Photo deletion moves into the database; the replay guard recognizes
-- both tombstone hash generations (Codex round 35, finding 2).
--
-- The tombstone format and the replay guard that consumes it must never
-- skew: deleteShipmentPhoto was app-side SQL, so a stale tab could write
-- an md5-era tombstone while the DB's guard consulted only image_sha256
-- — an explicitly deleted photo could then be resurrected by an
-- automatic replay. No RELEASED client ever wrote any tombstone (the
-- feature is unreleased, and prod held zero photo audit rows when
-- 1786475400 renamed the field), but the class is real, so:
--   1. delete_shipment_photo is now a DB function — the tombstone it
--      writes changes atomically with the guard forever after.
--   2. add_shipment_photo v5's replay guard accepts image_sha256 OR the
--      legacy image_md5 key, each served by its own partial index, so
--      even a tombstone written by a stale md5-era dev tab still blocks
--      replays until that generation is drained.

CREATE INDEX IF NOT EXISTS audit_photo_tombstone_md5_idx
  ON audit_log ((old_data->>'shipment_id'), (old_data->>'image_md5'))
  WHERE table_name = 'shipment_photos' AND action = 'shipment_photo_deleted';

-- Remove a package photo (retake of a blurry shot, wrong box). Allowed
-- in any shipment state — the two-admin trust model — but the audit row
-- is a TOMBSTONE: SHA-256 fingerprint of the full image, the complete
-- thumbnail blob, creator, size, age. p_shipment_id is the integrity
-- guard: the delete refuses unless the photo belongs to that shipment.
CREATE OR REPLACE FUNCTION delete_shipment_photo(
  p_photo_id    bigint,
  p_shipment_id bigint,
  p_actor       text
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_photo shipment_photos%ROWTYPE;
BEGIN
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

  -- an AUTOMATIC replay must not resurrect explicitly deleted evidence;
  -- both tombstone generations count, each on its own partial index
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
