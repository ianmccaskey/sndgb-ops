-- delete_shipment_draft: plpgsql port of the deleteShipmentDraft action
-- (Codex round 29, finding 1).
--
-- The single-statement version read its shipment_photos tombstone
-- snapshot on the statement snapshot, BEFORE the DELETE acquired the
-- shipments row lock. add_shipment_photo serializes on that row lock, so
-- a concurrent uploader could hold the lock, commit a new photo while
-- the delete statement waited, and have it cascade away with NO
-- tombstone — the delete's CTEs could not see rows committed during the
-- wait (the recurring READ COMMITTED statement-snapshot staleness that
-- moved set_product_digital and add_shipment_photo into plpgsql).
--
-- Here the lock order is 42001(order) -> shipments row FOR UPDATE (the
-- creators' order; add_shipment_photo takes only the row lock and never
-- 42001, so no inversion), and every read after the row lock runs on a
-- fresh statement snapshot: the gates are re-proved and the photo
-- tombstones are complete — every cascading photo leaves its md5
-- fingerprint, full thumbnail blob, creator, size, and age in audit.
--
-- Gates are unchanged from the action: refuse a finalized shipment,
-- refuse while the purchase lease is fresher than 10 minutes, refuse a
-- dispatched Shippo POST (purchase_attempted_at) until the
-- proof-of-absence walk stamped attempt_verified_no_label_at. Refusals
-- return zero rows.

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
  -- unlocked peek for the order id (never changes on a shipment row),
  -- so the advisory lock is taken before the row lock, creators' order
  SELECT s.order_id INTO v_order_id FROM shipments s WHERE s.id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(42001, v_order_id::int);

  -- fresh snapshot under the locks: re-prove every gate
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

  -- photo tombstones on the post-lock snapshot: nothing committed while
  -- we waited can cascade away silently
  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
  SELECT 'shipment_photos', sp.id::text, 'shipment_photo_deleted', p_actor,
         jsonb_build_object('shipment_id', sp.shipment_id,
                            'bytes', length(sp.image_data),
                            'image_md5', md5(sp.image_data),
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
