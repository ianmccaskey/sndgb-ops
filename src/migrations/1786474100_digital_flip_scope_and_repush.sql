-- Review hardening on 1786474000, two findings:
--
-- (1) The digital=true refusal was a permanent one-way lock: it blocked
--     on ANY non-voided shipment attribution, including finalized
--     history — a SKU that ever shipped physically could never be
--     reclassified. Narrowed to the actual stranding hazard: only
--     UNFINALIZED (draft) non-voided attribution refuses — a box being
--     packed right now would be hidden mid-flight. Finalized boxes are
--     completed work; hiding a reclassified product's REMAINING lines is
--     the feature.
--
-- (2) Deterministic reconciliation when a flip changes completeness: an
--     order whose last remaining PHYSICAL work was on the flipped
--     product becomes fully shipped locally with no shipment mutation to
--     trigger an upstream push — Base44 would silently keep the stale
--     status. On flip-to-digital, the fn now finds every order that the
--     flip completes (no other physical line with remaining finalized
--     work, no outstanding non-digital direct line, and at least one
--     pushed finalized shipment) and clears b44_pushed_at on ONE
--     finalized shipment per such order (the newest), audited as
--     shipment_push_invalidated — the existing amber "not pushed" badge
--     + Push upstream retry then carry the status correction through the
--     verified push path. set_product_digital re-created in full.
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
  -- with this product (in-flight attribution would be hidden mid-pack);
  -- finalized shipments are history and never block a reclassification
  IF p_digital AND EXISTS (
    SELECT 1 FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id
      AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      AND sh.finalized_at IS NULL
    JOIN order_items oi ON oi.id = si.order_item_id
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    WHERE g.product_id = p_product_id
  ) THEN RETURN; END IF;

  UPDATE products p SET digital = p_digital WHERE p.id = p_product_id;

  -- reconciliation: orders this flip COMPLETES get one pushed shipment
  -- re-opened so the upstream status correction is visible and retryable
  IF p_digital THEN
    WITH cand AS (
      -- open orders that had remaining work on the flipped product
      SELECT DISTINCT oi.order_id
      FROM order_items oi
      JOIN group_buy_products g ON g.id = oi.group_buy_product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE g.product_id = p_product_id
        AND o.status NOT IN ('cancelled', 'refunded')
        AND oi.removed_at IS NULL AND NOT oi.direct_ship
        AND COALESCE(oi.qty_override, oi.qty) > COALESCE((
          SELECT sum(si.qty) FROM shipment_items si
          JOIN shipments sh ON sh.id = si.shipment_id
          WHERE si.order_item_id = oi.id
            AND COALESCE(sh.refund_status, '') <> 'SUCCESS'), 0)
    ),
    nowdone AS (
      -- ...and are now fully shipped: every OTHER physical line covered by
      -- finalized boxes, no outstanding non-digital direct line
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
