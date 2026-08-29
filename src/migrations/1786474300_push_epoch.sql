-- Review hardening on 1786474200: an in-flight push could restamp
-- b44_pushed_at AFTER a digital flip invalidated it — the push's
-- just-in-time packable read predates the flip, its upstream write
-- leaves status unchanged, and its late markShipmentPushed stamp erases
-- the flip's amber retry surface, leaving Base44 stale and invisible.
-- (The sub-case where the shipment was never pushed yet — so the flip
-- had nothing to null — races identically.)
--
-- Fix: shipments.push_epoch, a CAS token for the stamp. The flip bumps
-- the epoch on EVERY finalized non-voided shipment of each order it
-- completes (pushed or not) while nulling any b44_pushed_at;
-- markShipmentPushed now stamps only when the caller presents the epoch
-- its push started from — a flip landing mid-push makes the stamp
-- refuse, the badge stays, and the retry re-reads post-flip state.
ALTER TABLE shipments ADD COLUMN push_epoch integer NOT NULL DEFAULT 0;

-- set_product_digital re-created in full: the resurfaced branch now
-- bumps push_epoch on all finalized non-voided shipments of completed
-- orders (previously it only nulled the newest pushed one).
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
      AND EXISTS (
        SELECT 1 FROM shipments s2
        WHERE s2.order_id = r.order_id AND s2.finalized_at IS NOT NULL
          AND COALESCE(s2.refund_status, '') <> 'SUCCESS'
          AND s2.b44_pushed_at IS NOT NULL)
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
      -- ALL finalized non-voided shipments of completed orders: null any
      -- stamp AND bump the epoch, so an in-flight push holding the old
      -- epoch cannot restamp over this invalidation
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
