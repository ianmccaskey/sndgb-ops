-- A listing's minimum order, and free shipping by the order's item count.
--
-- Ian, 2026-11-09: "I need a few more options for sellers setting up their
-- listings — MOQ or shipping (1 item is $10 shipping, 2 is free shipping for
-- example), Enforced MOQ". Asked whether one of a listing plus one other item
-- from the same shop counts toward "free at 2", Ian chose: count the whole
-- order.
--
--   min_per_order          the fewest units of THIS listing one order takes,
--                          1..10 (the store takes at most 10 of a listing per
--                          order, lib/store/rules.ts MAX_QTY_PER_ORDER). Stock
--                          under the minimum reads sold out to buyers (the
--                          hall, the listing page, and effective_status below);
--                          the stored status keeps following stock > 0.
--   free_shipping_min_qty  the number of items in the WHOLE order (every line
--                          of that shop's order counts) at which this
--                          listing's shipping fee is waived; NULL = no free
--                          shipping by count. 2..50, and above min_per_order
--                          (at or under it every order would ship free: that
--                          is shipping 0). Cleared when the fee is 0.
--
-- An order's shipping stays ONE fee: the highest fee among its lines that
-- are not waived (lib/store/cart-rules.ts cartTotals / orderTotals, the same
-- figure on the cart and at placement). House listings (P², PRT) take their
-- minimum from their own app and have no free-shipping count; their mirror
-- rows keep the defaults.
--
-- Writers: the storefront's /seller dashboard (lib/sellers/mutations.ts,
-- same limits and messages in lib/sellers/rules.ts) and the P2 Seller Portal
-- through the new portal_create_listing / portal_update_listing overloads
-- below. The CHECKs bind every writer. The 1790103600 overloads (no terms)
-- stay for the portal build released before this one: they never touch the
-- two columns, so a listing's terms survive an edit from that build. Drop
-- them once the released portal calls the new ones.
--
-- New functions return RETURNS TABLE, not a 1790103600 composite type, so a
-- re-apply of that file (DROP TYPE … CASCADE) can't take them with it.

ALTER TABLE storefront.store_listings
  ADD COLUMN IF NOT EXISTS min_per_order int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS free_shipping_min_qty int;

ALTER TABLE storefront.store_listings DROP CONSTRAINT IF EXISTS store_listings_min_per_order;
ALTER TABLE storefront.store_listings ADD CONSTRAINT store_listings_min_per_order
  CHECK (min_per_order BETWEEN 1 AND 10 AND (max_per_order IS NULL OR max_per_order < 1 OR max_per_order >= min_per_order));

ALTER TABLE storefront.store_listings DROP CONSTRAINT IF EXISTS store_listings_free_shipping_min_qty;
ALTER TABLE storefront.store_listings ADD CONSTRAINT store_listings_free_shipping_min_qty
  CHECK (free_shipping_min_qty IS NULL OR (free_shipping_min_qty BETWEEN 2 AND 50 AND free_shipping_min_qty > min_per_order));

COMMENT ON COLUMN storefront.store_listings.min_per_order IS
  'Fewest units of this listing one order takes (1..10). Stock under it reads sold out to buyers.';
COMMENT ON COLUMN storefront.store_listings.free_shipping_min_qty IS
  'Items in the whole order (every line of the shop''s order) at which this listing''s shipping fee is waived; NULL = none. The order pays the highest fee among lines not waived.';

-- ── the two terms, with the storefront's limits and messages ────────────────
DROP FUNCTION IF EXISTS storefront.shop_check_listing_terms(text, text, numeric);
CREATE FUNCTION storefront.shop_check_listing_terms(p_min_qty text, p_free_ship_qty text, p_shipping_fee numeric,
                                                    OUT min_per_order int, OUT free_shipping_min_qty int)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE v_min text := btrim(COALESCE(p_min_qty, '')); v_free text := btrim(COALESCE(p_free_ship_qty, ''));
BEGIN
  IF v_min = '' THEN
    min_per_order := 1;
  ELSIF v_min !~ '^[0-9]{1,3}$' OR v_min::int < 1 OR v_min::int > 10 THEN
    RAISE EXCEPTION 'Minimum order is a whole number from 1 to 10. The store takes up to 10 of a listing per order.'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:minQty';
  ELSE
    min_per_order := v_min::int;
  END IF;

  IF v_free = '' OR COALESCE(p_shipping_fee, 0) = 0 THEN
    -- blank, or shipping is already free: no count to reach
    free_shipping_min_qty := NULL;
  ELSIF v_free !~ '^[0-9]{1,3}$' OR v_free::int < 2 OR v_free::int > 50 THEN
    RAISE EXCEPTION 'Free shipping starts at a whole number of items from 2 to 50. Leave it blank for none.'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:freeShipQty';
  ELSIF v_free::int <= min_per_order THEN
    RAISE EXCEPTION 'Every order has at least % of this, so it would always ship free. Set shipping to 0, or make free shipping start above %.', min_per_order, min_per_order
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:freeShipQty';
  ELSE
    free_shipping_min_qty := v_free::int;
  END IF;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_check_listing_terms(text, text, numeric) FROM PUBLIC;

-- ── create, with terms ───────────────────────────────────────────────────────
-- The listing is saved by the 1790103600 core (same refusals, wallet rule,
-- audit 'listing_created'); the terms are checked first against the form's
-- shipping fee and written in the same call, audited as 'listing_terms_set'.
DROP FUNCTION IF EXISTS storefront.shop_create_listing(bigint, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_create_listing(p_seller_id bigint, p_actor text, p_title text, p_mass_label text, p_description_md text,
                                               p_price_usd text, p_shipping_usd text, p_qty text, p_status text,
                                               p_min_qty text, p_free_ship_qty text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v record; t record; r record;
BEGIN
  SELECT * INTO v FROM storefront.shop_check_listing(p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status);
  SELECT * INTO t FROM storefront.shop_check_listing_terms(p_min_qty, p_free_ship_qty, v.shipping_fee_usd);
  SELECT * INTO r FROM storefront.shop_create_listing(p_seller_id, p_actor, p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status);
  IF t.min_per_order <> 1 OR t.free_shipping_min_qty IS NOT NULL THEN
    UPDATE storefront.store_listings l
       SET min_per_order = t.min_per_order, free_shipping_min_qty = t.free_shipping_min_qty
     WHERE l.id = r.listing_id AND l.seller_id = p_seller_id;
    PERFORM storefront.shop_audit('storefront.store_listings', r.listing_id, 'listing_terms_set', p_actor, NULL,
      jsonb_build_object('minPerOrder', t.min_per_order, 'freeShippingMinQty', t.free_shipping_min_qty));
  END IF;
  RETURN QUERY SELECT r.listing_id, r.status, r.qty_available, r.message;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_create_listing(bigint, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- ── update, with terms ───────────────────────────────────────────────────────
-- The 1790103600 core locks the seller and the listing (refusing not-yours
-- and organizer-managed rows), compare-and-sets stock and audits
-- 'listing_updated'; the terms are written under that row lock and audited
-- only when they changed.
DROP FUNCTION IF EXISTS storefront.shop_update_listing(bigint, text, text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_update_listing(p_seller_id bigint, p_actor text, p_listing_id text, p_title text, p_mass_label text,
                                               p_description_md text, p_price_usd text, p_shipping_usd text, p_qty text,
                                               p_expected_qty text, p_status text, p_min_qty text, p_free_ship_qty text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v record; t record; r record; o record;
BEGIN
  SELECT * INTO v FROM storefront.shop_check_listing(p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status);
  SELECT * INTO t FROM storefront.shop_check_listing_terms(p_min_qty, p_free_ship_qty, v.shipping_fee_usd);
  SELECT * INTO r FROM storefront.shop_update_listing(p_seller_id, p_actor, p_listing_id, p_title, p_mass_label, p_description_md,
                                                      p_price_usd, p_shipping_usd, p_qty, p_expected_qty, p_status);
  SELECT l.min_per_order, l.free_shipping_min_qty INTO o
    FROM storefront.store_listings l WHERE l.id = r.listing_id AND l.seller_id = p_seller_id;
  IF o.min_per_order IS DISTINCT FROM t.min_per_order OR o.free_shipping_min_qty IS DISTINCT FROM t.free_shipping_min_qty THEN
    UPDATE storefront.store_listings l
       SET min_per_order = t.min_per_order, free_shipping_min_qty = t.free_shipping_min_qty
     WHERE l.id = r.listing_id AND l.seller_id = p_seller_id;
    PERFORM storefront.shop_audit('storefront.store_listings', r.listing_id, 'listing_terms_set', p_actor,
      jsonb_build_object('minPerOrder', o.min_per_order, 'freeShippingMinQty', o.free_shipping_min_qty),
      jsonb_build_object('minPerOrder', t.min_per_order, 'freeShippingMinQty', t.free_shipping_min_qty));
  END IF;
  RETURN QUERY SELECT r.listing_id, r.status, r.qty_available, r.message;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_update_listing(bigint, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- ── the listings page reads the terms; under the minimum reads sold out ─────
-- The columns of 1790103600's shop_listing_row, then the two terms at the
-- end (a reader selecting named columns keeps working).
DROP FUNCTION IF EXISTS storefront.portal_list_listings(text);
DROP FUNCTION IF EXISTS storefront.shop_list_listings(bigint);
CREATE FUNCTION storefront.shop_list_listings(p_seller_id bigint)
RETURNS TABLE (id bigint, title text, description_md text, mass_label text, price_usd numeric, shipping_fee_usd numeric,
               qty_available int, max_per_order int, status text, effective_status text, organizer_managed boolean,
               created_at timestamptz, updated_at timestamptz, min_per_order int, free_shipping_min_qty int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT l.id, l.title, l.description_md, l.mass_label, l.price_usd, l.shipping_fee_usd,
         COALESCE(l.qty_available, 0), l.max_per_order, l.status::text, e.effective,
         l.p2_product_id IS NOT NULL, l.created_at, l.updated_at, l.min_per_order, l.free_shipping_min_qty
    FROM storefront.store_listings l
    CROSS JOIN LATERAL (
      SELECT CASE WHEN l.status = 'active' AND COALESCE(l.qty_available, 0) < GREATEST(l.min_per_order, 1)
                  THEN 'sold_out' ELSE l.status::text END AS effective
    ) e
   WHERE l.seller_id = p_seller_id
   ORDER BY CASE e.effective WHEN 'active' THEN 0 WHEN 'sold_out' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
            l.updated_at DESC, l.id DESC
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_listings(bigint) FROM PUBLIC;

-- ── the portal's wrappers: resolve the shop, delegate, nothing else ─────────
CREATE FUNCTION storefront.portal_list_listings(p_email text)
RETURNS TABLE (id bigint, title text, description_md text, mass_label text, price_usd numeric, shipping_fee_usd numeric,
               qty_available int, max_per_order int, status text, effective_status text, organizer_managed boolean,
               created_at timestamptz, updated_at timestamptz, min_per_order int, free_shipping_min_qty int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_listings(storefront.portal_resolve_seller(p_email))
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_create_listing(text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_create_listing(p_email text, p_title text, p_mass_label text, p_description_md text, p_price_usd text,
                                                 p_shipping_usd text, p_qty text, p_status text, p_min_qty text, p_free_ship_qty text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_create_listing(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_title, p_mass_label,
                                               p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status, p_min_qty, p_free_ship_qty)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_update_listing(text, text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_update_listing(p_email text, p_listing_id text, p_title text, p_mass_label text, p_description_md text,
                                                 p_price_usd text, p_shipping_usd text, p_qty text, p_expected_qty text, p_status text,
                                                 p_min_qty text, p_free_ship_qty text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_update_listing(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_listing_id, p_title,
                                               p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_expected_qty, p_status,
                                               p_min_qty, p_free_ship_qty)
$fn$;

REVOKE EXECUTE ON FUNCTION storefront.portal_list_listings(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.portal_create_listing(text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.portal_update_listing(text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_seller_portal') THEN
    GRANT EXECUTE ON FUNCTION storefront.portal_list_listings(text) TO p2_seller_portal;
    GRANT EXECUTE ON FUNCTION storefront.portal_create_listing(text, text, text, text, text, text, text, text, text, text) TO p2_seller_portal;
    GRANT EXECUTE ON FUNCTION storefront.portal_update_listing(text, text, text, text, text, text, text, text, text, text, text, text) TO p2_seller_portal;
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104200_listing_minimum_free_shipping.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104200_listing_minimum_free_shipping.sql');
