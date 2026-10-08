-- A storefront order line may only carry a product of ITS order's campaign.
-- Same invariant class as 1790100100 (payment options): the storefront
-- validates this in the placement transaction, and now the database does
-- too, so no retry, bug or stray write can hang a campaign-B product on a
-- campaign-A order (which the import would resolve to a SKU and count as
-- campaign-A demand).
--
-- order_items gains the campaign explicitly (backfilled from its order) and
-- two composite FKs pin it to both the order and the campaign product.
ALTER TABLE storefront.orders
  ADD CONSTRAINT orders_id_gb_uniq UNIQUE (id, group_buy_id);

ALTER TABLE group_buy_products
  ADD CONSTRAINT group_buy_products_id_gb_uniq UNIQUE (id, group_buy_id);

ALTER TABLE storefront.order_items ADD COLUMN IF NOT EXISTS group_buy_id BIGINT;

UPDATE storefront.order_items oi
SET group_buy_id = o.group_buy_id
FROM storefront.orders o
WHERE o.id = oi.order_id AND oi.group_buy_id IS NULL;

ALTER TABLE storefront.order_items ALTER COLUMN group_buy_id SET NOT NULL;

ALTER TABLE storefront.order_items
  ADD CONSTRAINT order_items_order_same_campaign_fk
  FOREIGN KEY (order_id, group_buy_id) REFERENCES storefront.orders (id, group_buy_id) ON DELETE CASCADE;

ALTER TABLE storefront.order_items
  ADD CONSTRAINT order_items_product_same_campaign_fk
  FOREIGN KEY (group_buy_product_id, group_buy_id) REFERENCES group_buy_products (id, group_buy_id);
