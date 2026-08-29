-- Review hardening on 1786474100, two findings:
--
-- (1) The flip-to-digital reconciliation seeded candidates from
--     NON-direct lines only, so an order whose LAST outstanding work was
--     a vendor-direct line of the flipped product completed silently
--     with no re-push surface. Candidates now include any ACTIVE line of
--     the product with OPEN work — remaining packable qty (non-direct)
--     OR unfulfilled direct — and the completion test decides.
--
-- (2) The reverse flip (digital -> physical) could REOPEN an order whose
--     completion was already pushed upstream as 'shipped', with no
--     repair path: the push module only writes status on fully shipped
--     orders and deliberately leaves partials untouched (the ordering
--     app's partial-status vocabulary is unconfirmed), so the stale
--     upstream 'shipped' would be permanent. The flip now REFUSES when
--     any active order (a) currently reads fully shipped, (b) would gain
--     open work from the flip (a line of this product not covered by
--     finalized boxes, or an unfulfilled direct line), and (c) has at
--     least one finalized pushed shipment (the proxy for "its completion
--     reached the ordering app"). Recourse: void/refund one of that
--     order's shipments first (un-completing it locally), or keep the
--     product digital. A downgrade push can be added once the partial
--     status vocabulary is confirmed.
-- set_product_digital() re-created in full below.
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

  -- flipping TO digital refuses only while a DRAFT box is being packed
  -- with this product; finalized shipments are history and never block
  IF p_digital AND EXISTS (
    SELECT 1 FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id
      AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      AND sh.finalized_at IS NULL
    JOIN order_items oi ON oi.id = si.order_item_id
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    WHERE g.product_id = p_product_id
  ) THEN RETURN; END IF;

  -- flipping BACK to physical refuses when it would REOPEN an order whose
  -- completion was already pushed upstream (see header)
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
      AND EXISTS (
        SELECT 1 FROM shipments s2
        WHERE s2.order_id = r.order_id AND s2.finalized_at IS NOT NULL
          AND COALESCE(s2.refund_status, '') <> 'SUCCESS'
          AND s2.b44_pushed_at IS NOT NULL)
  ) THEN RETURN; END IF;

  UPDATE products p SET digital = p_digital WHERE p.id = p_product_id;

  IF p_digital THEN
    WITH cand AS (
      -- open orders with OPEN work on the flipped product: remaining
      -- packable qty OR an unfulfilled direct line
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
      UPDATE shipments s SET b44_pushed_at = NULL
      WHERE s.id IN (
        SELECT max(s2.id) FROM shipments s2
        JOIN nowdone n ON n.order_id = s2.order_id
        WHERE s2.finalized_at IS NOT NULL
          AND COALESCE(s2.refund_status, '') <> 'SUCCESS'
          AND s2.b44_pushed_at IS NOT NULL
        GROUP BY s2.order_id)
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
