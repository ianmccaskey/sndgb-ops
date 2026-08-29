-- add_shipment_photo v6: strict JPEG data-URL gate (Codex round 37,
-- finding 2).
--
-- The old gate accepted any 'data:image/%', so a stale or hand-crafted
-- caller could store SVG/XML or other non-raster payloads that the
-- admin surfaces then inject verbatim into <img src>. The client
-- (src/lib/imageCapture.ts) produces exactly canvas.toDataURL(
-- 'image/jpeg', q) for BOTH the full image and the thumbnail, so the
-- boundary now requires the literal prefix 'data:image/jpeg;base64,'
-- on both payloads. Nothing else changes from v5 (dual-hash replay
-- guard, quota, locks).
--
-- Note on the sha256() dependency raised in the same round: sha256(
-- bytea) is a PostgreSQL CORE function (pg_catalog, since v11), not a
-- pgcrypto function. Verified on this project's live DB (PostgreSQL
-- 18): installed extensions are only plpgsql + citext, and
-- pg_proc/pg_namespace place sha256 in pg_catalog. Any fresh rebuild
-- on PG >= 11 has it unconditionally; no extension prerequisite
-- exists, and this comment records that invariant.

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
  -- strict raster gate: exactly what the client encoder emits
  IF p_image_data IS NULL OR p_image_data NOT LIKE 'data:image/jpeg;base64,%'
     OR length(p_image_data) NOT BETWEEN 100 AND 1500000 THEN
    RETURN;
  END IF;
  IF p_thumb_data IS NULL OR p_thumb_data NOT LIKE 'data:image/jpeg;base64,%'
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

  SELECT sp.id INTO v_photo_id
  FROM shipment_photos sp
  WHERE sp.shipment_id = p_shipment_id
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
