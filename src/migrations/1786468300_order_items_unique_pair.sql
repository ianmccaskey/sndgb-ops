-- One line per product per order. A UI Bakery platform update began rejecting
-- replaceOrderItems' multi-row INSERT ("order_id must be unique,
-- group_buy_product_id must be unique"), which silently broke item AND payment
-- sync for re-imported orders (payments run after items and never executed).
-- The import now upserts one row per item against this unique pair; duplicate
-- SKU lines from the source are summed client-side before writing.

-- Preflight (replay safety): collapse any duplicate pairs — keep the earliest
-- row with the summed qty. Live DB verified: zero duplicate pairs exist.
UPDATE order_items oi SET qty = d.total_qty
FROM (
  SELECT order_id, group_buy_product_id, MIN(id) AS keep_id, SUM(qty) AS total_qty
  FROM order_items GROUP BY order_id, group_buy_product_id HAVING COUNT(*) > 1
) d
WHERE oi.id = d.keep_id;

DELETE FROM order_items oi
USING (
  SELECT order_id, group_buy_product_id, MIN(id) AS keep_id
  FROM order_items GROUP BY order_id, group_buy_product_id HAVING COUNT(*) > 1
) d
WHERE oi.order_id = d.order_id
  AND oi.group_buy_product_id = d.group_buy_product_id
  AND oi.id <> d.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS order_items_order_product_uniq
  ON order_items (order_id, group_buy_product_id);
