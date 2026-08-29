-- Review hardening on 1786474400: the flip's completion/reopen scans read
-- order items, direct-fulfillment state, and shipment coverage WITHOUT
-- joining the per-order 42001 write boundary every item/direct/shipment
-- writer serializes on — a concurrent qty edit, removal, routing flip,
-- or vendor-shipped stamp could land between the flip's scans and its
-- write, producing a missed invalidation or a missed reversal refusal.
--
-- set_product_digital now takes the 42001 lock for EVERY active order
-- containing a line of the product, in ascending order-id order, BEFORE
-- its 42007 product lock. This preserves one global lock hierarchy —
-- 42001 (ascending) -> 42007 (ascending) -> 42006 — matching the
-- shipment-creation fns (42001 first, then 42007) exactly, so no
-- inversion and no deadlock cycle. The scans then run with fresh
-- plpgsql-statement snapshots behind the same boundary as every
-- completion-input writer. (An order acquiring its FIRST line of this
-- product after the lock scan is not in the set, but such a line is
-- born under the new digital value and never had pre-flip state to
-- race.) Full fn text below, exactly as executed live.
CREATE OR REPLACE FUNCTION set_product_digital(
  p_product_id bigint,
  p_digital boolean,
  p_expected_digital boolean,
  p_actor text
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_oid bigint;
BEGIN
  -- per-order serialization FIRST (see header)
  FOR v_oid IN
    SELECT DISTINCT oi.order_id
    FROM order_items oi
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    JOIN orders o ON o.id = oi.order_id
    WHERE g.product_id = p_product_id
      AND o.status NOT IN ('cancelled', 'refunded')
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(42001, v_oid::int);
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_digital_' || p_product_id::text, 42007));

  PERFORM 1 FROM products p
  WHERE p.id = p_product_id AND p.digital = p_expected_digital
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_digital AND EXISTS (
    SELECT 1 FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id
      AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      AND sh.finalized_at IS NULL
    JOIN order_items oi ON oi.id = si.order_item_id
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    WHERE g.product_id = p_product_id
  ) THEN RETURN; END IF;

  IF NOT p_digital AND EXISTS (
    WITH reopen AS (
      SELECT DISTINCT oi.order_id
      FROM order_items oi
      JOIN group_buy_products g ON g.id = oi.group_buy_product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE g.product_id = p_product_id
        AND o.status NOT IN ('cancelled', 'refunded')
        AND oi.removed_at IS NULL
        AND ((NOT oi.direct_ship AND COALESCE(oi.qty_override, oi.qty) > COALESCE((
                SELECT sum(si.qty) FROM shipment_items si
                JOIN shipments sh ON sh.id = si.shipment_id
                WHERE si.order_item_id = oi.id AND sh.finalized_at IS NOT NULL
                  AND COALESCE(sh.refund_status, '') <> 'SUCCESS'), 0))
             OR (oi.direct_ship AND oi.direct_fulfilled_at IS NULL))
    )
    SELECT 1 FROM reopen r
    WHERE NOT EXISTS (
        SELECT 1 FROM order_items oj
        JOIN group_buy_products g2 ON g2.id = oj.group_buy_product_id
        JOIN products p2 ON p2.id = g2.product_id
        WHERE oj.order_id = r.order_id AND oj.removed_at IS NULL AND NOT oj.direct_ship
          AND NOT p2.digital
          AND COALESCE(oj.qty_override, oj.qty) > COALESCE((
            SELECT sum(si.qty) FROM shipment_items si
            JOIN shipments sh ON sh.id = si.shipment_id
            WHERE si.order_item_id = oj.id AND sh.finalized_at IS NOT NULL
              AND COALESCE(sh.refund_status, '') <> 'SUCCESS'), 0))
      AND NOT EXISTS (
        SELECT 1 FROM order_items oj2
        JOIN group_buy_products g3 ON g3.id = oj2.group_buy_product_id
        JOIN products p3 ON p3.id = g3.product_id
        WHERE oj2.order_id = r.order_id AND oj2.direct_ship AND oj2.removed_at IS NULL
          AND NOT p3.digital AND oj2.direct_fulfilled_at IS NULL)
      -- DURABLE upstream-completion signal: an audited push that set
      -- status='shipped' (immutable history — a later retry-surface
      -- invalidation cannot clear it)
      AND EXISTS (
        SELECT 1 FROM audit_log al
        WHERE al.table_name = 'shipments'
          AND al.action = 'shipment_pushed_upstream'
          AND (al.new_data->>'order_id')::bigint = r.order_id
          AND al.new_data->'pushed'->>'status_set' = 'shipped')
  ) THEN RETURN; END IF;

  UPDATE products p SET digital = p_digital WHERE p.id = p_product_id;

  IF p_digital THEN
    WITH cand AS (
      SELECT DISTINCT oi.order_id
      FROM order_items oi
      JOIN group_buy_products g ON g.id = oi.group_buy_product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE g.product_id = p_product_id
        AND o.status NOT IN ('cancelled', 'refunded')
        AND oi.removed_at IS NULL
        AND ((NOT oi.direct_ship AND COALESCE(oi.qty_override, oi.qty) > COALESCE((
                SELECT sum(si.qty) FROM shipment_items si
                JOIN shipments sh ON sh.id = si.shipment_id
                WHERE si.order_item_id = oi.id
                  AND COALESCE(sh.refund_status, '') <> 'SUCCESS'), 0))
             OR (oi.direct_ship AND oi.direct_fulfilled_at IS NULL))
    ),
    nowdone AS (
      SELECT c.order_id FROM cand c
      WHERE NOT EXISTS (
        SELECT 1 FROM order_items oj
        JOIN group_buy_products g2 ON g2.id = oj.group_buy_product_id
        JOIN products p2 ON p2.id = g2.product_id
        WHERE oj.order_id = c.order_id AND oj.removed_at IS NULL AND NOT oj.direct_ship
          AND NOT p2.digital
          AND COALESCE(oj.qty_override, oj.qty) > COALESCE((
            SELECT sum(si.qty) FROM shipment_items si
            JOIN shipments sh ON sh.id = si.shipment_id
            WHERE si.order_item_id = oj.id AND sh.finalized_at IS NOT NULL
              AND COALESCE(sh.refund_status, '') <> 'SUCCESS'), 0))
        AND NOT EXISTS (
          SELECT 1 FROM order_items oj2
          JOIN group_buy_products g3 ON g3.id = oj2.group_buy_product_id
          JOIN products p3 ON p3.id = g3.product_id
          WHERE oj2.order_id = c.order_id AND oj2.direct_ship AND oj2.removed_at IS NULL
            AND NOT p3.digital AND oj2.direct_fulfilled_at IS NULL)
    ),
    resurfaced AS (
      UPDATE shipments s SET b44_pushed_at = NULL, push_epoch = s.push_epoch + 1
      FROM nowdone n
      WHERE s.order_id = n.order_id
        AND s.finalized_at IS NOT NULL
        AND COALESCE(s.refund_status, '') <> 'SUCCESS'
      RETURNING s.id, s.order_id
    )
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    SELECT 'shipments', r.id::text, 'shipment_push_invalidated', p_actor,
           jsonb_build_object('order_id', r.order_id,
                              'reason', 'product reclassified digital changed order completeness - re-push required',
                              'product_id', p_product_id)
    FROM resurfaced r;
  END IF;

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
  SELECT 'products', p.id::text, 'product_digital_set', p_actor,
         jsonb_build_object('digital', p_expected_digital),
         jsonb_build_object('sku_code', p.sku_code, 'digital', p.digital)
  FROM products p WHERE p.id = p_product_id;

  RETURN QUERY SELECT p_product_id::text;
END
$fn$;
