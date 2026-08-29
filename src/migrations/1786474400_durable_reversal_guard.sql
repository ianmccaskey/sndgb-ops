-- Review hardening on 1786474300: the digital->physical reversal guard
-- keyed on b44_pushed_at — the mutable retry stamp that the FORWARD flip
-- itself nulls during invalidation. Sequence flip-to-digital (stamps
-- cleared) -> flip-back-to-physical slipped the guard and could reopen
-- an order Base44 already shows as shipped, with no downgrade path.
--
-- The guard now keys on the DURABLE signal: the immutable audit history.
-- markShipmentPushed records 'shipment_pushed_upstream' with the pushed
-- payload, including status_set='shipped' when that push advanced the
-- upstream order. A reversal refuses whenever any such shipped-status
-- push exists for an order the flip would reopen — no later invalidation
-- can erase that history. set_product_digital re-created in full; only
-- the reversal guard's EXISTS changed vs 1786474300.
CREATE OR REPLACE FUNCTION set_product_digital(
  p_product_id bigint,
  p_digital boolean,
  p_expected_digital boolean,
  p_actor text
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
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
