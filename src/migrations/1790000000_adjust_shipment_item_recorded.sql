-- Fix mis-recorded shipment contents in-app (Ian, 2026-09-30): "I need a
-- way to fix a shipped order where items were recorded shipped that
-- wasnt." Precedent: 2026-MB5-303 shipped with a LOBSTER R30 line that
-- never went in the box — the fix was manual DB surgery (delete the
-- shipment_item, clear b44_pushed_at, re-push). This function is that
-- surgery as a guarded, audited operation on ONE line of a FINALIZED
-- shipment: set a recorded qty (0 removes the line, absent lines can be
-- added), under the same discipline as every other item mutation.
--
-- Guards (all on fresh post-lock snapshots):
--  * 42001 advisory lock on the order (the recon/item-mutation lock
--    convention) -> shipments row FOR UPDATE -> order_items row FOR
--    UPDATE.
--  * Finalized shipments only (drafts are edited by delete-and-requote),
--    never a refund-SUCCESS voided one (its items are already out of all
--    math; editing a void would be revisionism).
--  * INCREASES are capped by the same remaining formula the draft path
--    proves: effective (COALESCE(qty_override, qty), 0 when removed)
--    minus ALL non-voided attribution including drafts. Reductions and
--    removals are always allowed - they only return qty to remaining.
--  * No additions to removed or digital lines; reason required; scale
--    max 2 decimals; no-op (new = old) refused so the UI can say so.
--  * b44_pushed_at is CLEARED so the shipment re-offers "Push upstream"
--    with the corrected contents note. The push NEVER downgrades an
--    upstream shipped/terminal status by design - the caller's UI says
--    so, loudly, so the operator fixes upstream status by hand when the
--    correction un-completes an order.
--  * Refusals return zero rows. Audited with old/new qty + reason.
CREATE OR REPLACE FUNCTION adjust_shipment_item_recorded(
  p_shipment_id bigint,
  p_order_item_id bigint,
  p_new_qty numeric,
  p_reason text,
  p_actor text
) RETURNS TABLE (
  o_shipment_id bigint,
  o_order_item_id bigint,
  o_old_qty numeric,
  o_new_qty numeric,
  o_sku_code text,
  o_items_left int
) LANGUAGE plpgsql AS $$
DECLARE
  v_order_id bigint;
  v_carrier text;
  v_tracking text;
  v_old numeric;
  v_effective numeric;
  v_attributed numeric;
  v_removed boolean;
  v_digital boolean;
  v_sku text;
BEGIN
  IF p_new_qty IS NULL OR p_new_qty < 0 OR p_new_qty <> round(p_new_qty, 2) THEN
    RETURN;
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN;
  END IF;

  SELECT s.order_id INTO v_order_id FROM shipments s WHERE s.id = p_shipment_id;
  IF v_order_id IS NULL THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(42001, v_order_id::int);

  -- fresh post-lock shipment gate
  SELECT s.carrier, s.tracking_number INTO v_carrier, v_tracking
  FROM shipments s
  WHERE s.id = p_shipment_id
    AND s.finalized_at IS NOT NULL
    AND COALESCE(s.refund_status, '') <> 'SUCCESS'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- the order line, row-locked, with what the cap needs
  SELECT CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END,
         oi.removed_at IS NOT NULL,
         p.digital, p.sku_code
    INTO v_effective, v_removed, v_digital, v_sku
  FROM order_items oi
  JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
  JOIN products p ON p.id = gbp.product_id
  WHERE oi.id = p_order_item_id AND oi.order_id = v_order_id
  FOR UPDATE OF oi;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(si.qty, 0) INTO v_old
  FROM shipment_items si
  WHERE si.shipment_id = p_shipment_id AND si.order_item_id = p_order_item_id;
  v_old := COALESCE(v_old, 0);
  IF p_new_qty = v_old THEN RETURN; END IF;

  IF p_new_qty > v_old THEN
    -- additions/increases re-prove remaining exactly as getPackableItems
    -- computes it (attributed INCLUDES this row's current qty, so the
    -- allowed delta is remaining as displayed)
    IF v_removed OR v_digital THEN RETURN; END IF;
    SELECT COALESCE(sum(si.qty), 0) INTO v_attributed
    FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id
    WHERE si.order_item_id = p_order_item_id
      AND COALESCE(sh.refund_status, '') <> 'SUCCESS';
    IF (p_new_qty - v_old) > GREATEST(v_effective - v_attributed, 0) THEN
      RETURN;
    END IF;
  END IF;

  IF p_new_qty = 0 THEN
    DELETE FROM shipment_items si
    WHERE si.shipment_id = p_shipment_id AND si.order_item_id = p_order_item_id;
  ELSE
    INSERT INTO shipment_items (shipment_id, order_item_id, qty)
    VALUES (p_shipment_id, p_order_item_id, p_new_qty)
    ON CONFLICT (shipment_id, order_item_id) DO UPDATE SET qty = EXCLUDED.qty;
  END IF;

  -- the recorded contents changed -> the upstream push is stale
  UPDATE shipments s SET b44_pushed_at = NULL WHERE s.id = p_shipment_id;

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES (
    'shipment_items',
    p_shipment_id || ':' || p_order_item_id,
    'shipment_item_recorded_adjust',
    p_actor,
    jsonb_build_object('qty', v_old, 'order_id', v_order_id, 'sku', v_sku,
                       'carrier', v_carrier, 'tracking_number', v_tracking),
    jsonb_build_object('qty', p_new_qty, 'reason', btrim(p_reason))
  );

  RETURN QUERY
  SELECT p_shipment_id, p_order_item_id, v_old, p_new_qty, v_sku,
         (SELECT count(*)::int FROM shipment_items si2 WHERE si2.shipment_id = p_shipment_id);
END;
$$;
