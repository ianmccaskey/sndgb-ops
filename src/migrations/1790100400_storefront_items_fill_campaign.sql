-- 1790100200 made storefront.order_items.group_buy_id NOT NULL. The storefront
-- writes it, but a writer deployed before that change (or any future caller
-- that omits it) must not turn checkout into a partial failure: derive the
-- campaign from the parent order when it is omitted. The composite FKs from
-- 1790100200 still prove the product belongs to that campaign.
CREATE OR REPLACE FUNCTION storefront.order_items_fill_campaign() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_buy_id IS NULL THEN
    SELECT o.group_buy_id INTO NEW.group_buy_id FROM storefront.orders o WHERE o.id = NEW.order_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS order_items_fill_campaign ON storefront.order_items;
CREATE TRIGGER order_items_fill_campaign
  BEFORE INSERT OR UPDATE OF order_id, group_buy_id ON storefront.order_items
  FOR EACH ROW EXECUTE FUNCTION storefront.order_items_fill_campaign();
