-- Partial functional index for the photo replay tombstone check (Codex
-- round 32/33 performance finding).
--
-- add_shipment_photo's replay guard queries audit_log by table_name +
-- action + JSONB-extracted shipment_id/image_md5 WHILE HOLDING the
-- parent shipment's row lock. audit_log only indexes (table_name,
-- row_pk), so that lookup was a scan that would grow with audit history
-- and serialize other photo attaches behind it. This partial index
-- covers exactly the tombstone predicate — tiny (only
-- shipment_photo_deleted rows) and matched by the fn's constant
-- equalities, so the locked window stays O(log n) forever.

CREATE INDEX IF NOT EXISTS audit_photo_tombstone_idx
  ON audit_log ((old_data->>'shipment_id'), (old_data->>'image_md5'))
  WHERE table_name = 'shipment_photos' AND action = 'shipment_photo_deleted';
