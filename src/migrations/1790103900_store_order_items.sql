-- A store order carries several lines from ONE shop.
--
-- Ian, 2026-11-08: "I would like to be able to add multiple items to a cart
-- per storefront. We are not ready yet to allow multiple storefront orders
-- in a single checkout" — one shop per checkout stays (each shop is paid to
-- its own wallet), but a member now puts several of that shop's listings in
-- one order. Until now storefront.store_orders held exactly one listing
-- (listing_id, listing_title_snapshot, qty, unit_price_usd, subtotal_usd).
--
-- What changes:
--  * storefront.store_order_items: one row per (order, listing) with the
--    title, quantity and prices snapshotted at placement. Every existing
--    order is backfilled with its one line. shipping_fee_usd, total_usd and
--    fee_usd stay on the order (one shipment, one fee).
--  * The order's old single-line columns become its SUMMARY, kept by the
--    trigger store_order_items_summarize for every writer: listing_id = the
--    first line's listing, listing_title_snapshot = the first title, with
--    " + N more" when there are more lines, qty = units over every line,
--    subtotal_usd = the lines' sum, unit_price_usd = subtotal / units (the
--    exact unit price of a one-line order, the blended price otherwise), and
--    the new item_count. Readers that still show "title × qty" (the P2
--    Collective Orders Shop orders page, the Seller Portal drawer) stay
--    truthful; a reader that packs a box reads the lines.
--  * Lines are frozen once the order leaves 'unpaid': money follows the
--    lines, so nothing changes them after a payment attaches (trigger
--    store_order_items_frozen). A line is never edited in the store either —
--    the buyer cancels and orders again.
--  * The shop readers: storefront.shop_order_items(p_seller_id, p_order_ids)
--    (owner-only core, the seller's own orders only) and the granted
--    storefront.portal_order_items(p_email, p_order_ids) wrapper, in the
--    1790103600 shape (resolve the shop, delegate).
--
-- The storefront app connects as the owner today (1790101500 is unapplied);
-- the grants below are conditional on that role existing, so this file
-- applies in either order.
--
-- Fully transactional, idempotent: probe inside BEGIN … ROLLBACK.

-- ── 1. the lines ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storefront.store_order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_order_id BIGINT NOT NULL REFERENCES storefront.store_orders(id) ON DELETE CASCADE,
  listing_id BIGINT NOT NULL REFERENCES storefront.store_listings(id),
  listing_title_snapshot TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_usd NUMERIC(12,2) NOT NULL CHECK (unit_price_usd >= 0),
  subtotal_usd NUMERIC(12,2) NOT NULL CHECK (subtotal_usd >= 0),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_order_id, listing_id)
);
CREATE INDEX IF NOT EXISTS store_order_items_listing_idx ON storefront.store_order_items (listing_id);
COMMENT ON TABLE storefront.store_order_items IS
  'The lines of a store order (1790103900): one row per listing bought, title and prices snapshotted at placement. All lines of an order belong to the order''s seller. Frozen once the order leaves unpaid.';

ALTER TABLE storefront.store_orders ADD COLUMN IF NOT EXISTS item_count INTEGER NOT NULL DEFAULT 1 CHECK (item_count > 0);

COMMENT ON COLUMN storefront.store_orders.listing_id IS
  'SUMMARY since 1790103900 (kept by trigger store_order_items_summarize): the first line''s listing. The lines are storefront.store_order_items.';
COMMENT ON COLUMN storefront.store_orders.listing_title_snapshot IS
  'SUMMARY since 1790103900: the first line''s title, with " + N more" when the order has more lines.';
COMMENT ON COLUMN storefront.store_orders.qty IS
  'SUMMARY since 1790103900: units over every line of the order.';
COMMENT ON COLUMN storefront.store_orders.unit_price_usd IS
  'SUMMARY since 1790103900: subtotal_usd / qty — the unit price of a one-line order, the blended price otherwise.';
COMMENT ON COLUMN storefront.store_orders.subtotal_usd IS
  'SUMMARY since 1790103900: the sum of the lines'' subtotal_usd.';
COMMENT ON COLUMN storefront.store_orders.item_count IS
  'SUMMARY since 1790103900: how many lines (distinct listings) the order has.';

-- ── 2. backfill: every existing order is its one line ──────────────────────
INSERT INTO storefront.store_order_items (store_order_id, listing_id, listing_title_snapshot, qty, unit_price_usd, subtotal_usd, sort, created_at)
SELECT o.id, o.listing_id, o.listing_title_snapshot, o.qty, o.unit_price_usd, o.subtotal_usd, 0, o.created_at
  FROM storefront.store_orders o
 WHERE NOT EXISTS (SELECT 1 FROM storefront.store_order_items i WHERE i.store_order_id = o.id);

-- ── 3. the order's summary follows its lines ───────────────────────────────
CREATE OR REPLACE FUNCTION storefront.store_order_items_summarize() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_order bigint := COALESCE(NEW.store_order_id, OLD.store_order_id);
BEGIN
  UPDATE storefront.store_orders o
     SET listing_id = s.first_listing,
         listing_title_snapshot = CASE WHEN s.n > 1 THEN s.first_title || ' + ' || (s.n - 1) || ' more' ELSE s.first_title END,
         qty = s.units,
         subtotal_usd = s.subtotal,
         unit_price_usd = round(s.subtotal / s.units, 2),
         item_count = s.n
    FROM (SELECT count(*)::int AS n, sum(i.qty)::int AS units, sum(i.subtotal_usd) AS subtotal,
                 (array_agg(i.listing_id ORDER BY i.sort, i.id))[1] AS first_listing,
                 (array_agg(i.listing_title_snapshot ORDER BY i.sort, i.id))[1] AS first_title
            FROM storefront.store_order_items i WHERE i.store_order_id = v_order) s
   WHERE o.id = v_order AND s.n > 0;
  RETURN NULL;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.store_order_items_summarize() FROM PUBLIC;

-- lines change only while nothing has been paid toward them
CREATE OR REPLACE FUNCTION storefront.store_order_items_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_order bigint := COALESCE(NEW.store_order_id, OLD.store_order_id); v_status text;
BEGIN
  SELECT o.status::text INTO v_status FROM storefront.store_orders o WHERE o.id = v_order;
  IF v_status IS NULL THEN
    RETURN NULL; -- the order is being deleted (ON DELETE CASCADE): nothing to protect
  END IF;
  IF v_status <> 'unpaid' THEN
    RAISE EXCEPTION 'The lines of store order % cannot change once it is %.', v_order, v_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.store_order_id <> OLD.store_order_id THEN
    RAISE EXCEPTION 'A store order line cannot move to another order.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.store_order_items_frozen() FROM PUBLIC;

DROP TRIGGER IF EXISTS store_order_items_frozen ON storefront.store_order_items;
CREATE TRIGGER store_order_items_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON storefront.store_order_items
  FOR EACH ROW EXECUTE FUNCTION storefront.store_order_items_frozen();

DROP TRIGGER IF EXISTS store_order_items_summarize ON storefront.store_order_items;
CREATE TRIGGER store_order_items_summarize
  AFTER INSERT OR UPDATE OR DELETE ON storefront.store_order_items
  FOR EACH ROW EXECUTE FUNCTION storefront.store_order_items_summarize();

-- ── 4. the shop readers ────────────────────────────────────────────────────
DROP TYPE IF EXISTS storefront.shop_order_item_row CASCADE;
CREATE TYPE storefront.shop_order_item_row AS (
    id bigint, store_order_id bigint, listing_id bigint, listing_title text, qty int,
    unit_price_usd numeric, subtotal_usd numeric, sort int);

-- the lines of the shop's own orders named in p_order_ids (comma-separated,
-- up to 200); an id of another shop's order simply returns no rows
CREATE FUNCTION storefront.shop_order_items(p_seller_id bigint, p_order_ids text) RETURNS SETOF storefront.shop_order_item_row
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_ids bigint[]; v_raw text;
BEGIN
  v_raw := btrim(COALESCE(p_order_ids, ''));
  IF v_raw = '' THEN
    RAISE EXCEPTION 'Which orders? Pass their ids.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:order_ids';
  END IF;
  IF v_raw !~ '^[1-9][0-9]{0,17}(\s*,\s*[1-9][0-9]{0,17}){0,199}$' THEN
    RAISE EXCEPTION 'Order ids must be whole numbers, comma-separated, 200 at most.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:order_ids';
  END IF;
  SELECT array_agg(DISTINCT btrim(x)::bigint) INTO v_ids FROM regexp_split_to_table(v_raw, ',') x;
  RETURN QUERY
    SELECT i.id, i.store_order_id, i.listing_id, i.listing_title_snapshot, i.qty, i.unit_price_usd, i.subtotal_usd, i.sort
      FROM storefront.store_order_items i
      JOIN storefront.store_orders o ON o.id = i.store_order_id
     WHERE o.seller_id = p_seller_id AND o.id = ANY (v_ids)
     ORDER BY i.store_order_id DESC, i.sort, i.id;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_order_items(bigint, text) FROM PUBLIC;

CREATE FUNCTION storefront.portal_order_items(p_email text, p_order_ids text) RETURNS SETOF storefront.shop_order_item_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
    SELECT * FROM storefront.shop_order_items(storefront.portal_resolve_seller(p_email), p_order_ids)
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.portal_order_items(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront.portal_order_items(text, text) TO p2_seller_portal;

-- ── 5. the storefront's least-privilege role, if it exists ─────────────────
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_storefront') THEN
    GRANT SELECT, INSERT ON storefront.store_order_items TO p2_storefront;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA storefront TO p2_storefront;
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103900_store_order_items.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103900_store_order_items.sql');
