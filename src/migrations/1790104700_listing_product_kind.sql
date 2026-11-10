-- A listing's product type: what the store's stage shows for it.
--
-- Ian, 2026-11-10: "I will need an additional render for non peptide
-- products in the store. Specifically K&K sells 3d printed items for
-- peptide storage." Asked where the switch lives, Ian chose per listing (the
-- seller picks it on the listing form; one shop may sell both kinds), and
-- for the new render a closed 3D-printed vial storage case.
--
--   product_kind  'vial'    peptides, bac water, anything sold in a vial:
--                           the shared gold vial loop (the default, and
--                           every row before this migration).
--                 'storage' 3D-printed cases and racks for vials: the
--                           storage case loop.
--
-- The type only picks the stage's render (p2collective-app
-- lib/store/hall-assets.ts PRODUCT_RENDERS); no price, cap, ship or
-- payment rule reads it. Text with a CHECK, not an enum, so a later type
-- widens the CHECK the way accents did (1790103300).
--
-- Writers: the storefront's /seller dashboard (lib/sellers/mutations.ts,
-- mirror rule in lib/sellers/rules.ts checkProductKind) and the P2 Seller
-- Portal through the new portal_create_listing / portal_update_listing
-- overloads below (mirror rule in src/lib/sellerRules.ts). The CHECK binds
-- every writer. House mirror rows (P², PRT) keep the default: house stock is
-- peptides. The 1790104200 overloads (no type) stay for the portal build
-- released before this one: they never touch product_kind, so an edit from
-- that build keeps the listing's type. Drop them once the released portal
-- calls the new ones.

ALTER TABLE storefront.store_listings
  ADD COLUMN IF NOT EXISTS product_kind text NOT NULL DEFAULT 'vial';

ALTER TABLE storefront.store_listings DROP CONSTRAINT IF EXISTS store_listings_product_kind;
ALTER TABLE storefront.store_listings ADD CONSTRAINT store_listings_product_kind
  CHECK (product_kind IN ('vial', 'storage'));

COMMENT ON COLUMN storefront.store_listings.product_kind IS
  'What the store''s stage shows for the listing: vial (peptides, bac water; the gold vial loop) or storage (3D-printed cases and racks; the storage case loop).';

-- ── the type, with the storefront's message ─────────────────────────────────
-- Blank is a vial (the default). Anything else outside the list refuses.
DROP FUNCTION IF EXISTS storefront.shop_check_listing_kind(text);
CREATE FUNCTION storefront.shop_check_listing_kind(p_kind text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE v text := lower(btrim(COALESCE(p_kind, '')));
BEGIN
  IF v = '' THEN
    RETURN 'vial';
  ELSIF v IN ('vial', 'storage') THEN
    RETURN v;
  END IF;
  RAISE EXCEPTION 'Pick what this is: a vial, or 3D-printed storage.'
    USING ERRCODE = 'invalid_parameter_value', HINT = 'field:productKind';
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_check_listing_kind(text) FROM PUBLIC;

-- ── create, with the type ────────────────────────────────────────────────────
-- Every field is checked before anything is written (the listing, its terms,
-- then the type); the 1790104200 overload saves the listing and its terms
-- (same refusals, wallet rule, audits); a storage listing then gets its
-- type in the same call, audited as 'listing_kind_set'.
DROP FUNCTION IF EXISTS storefront.shop_create_listing(bigint, text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_create_listing(p_seller_id bigint, p_actor text, p_title text, p_mass_label text, p_description_md text,
                                               p_price_usd text, p_shipping_usd text, p_qty text, p_status text,
                                               p_min_qty text, p_free_ship_qty text, p_product_kind text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v record; t record; k text; r record;
BEGIN
  SELECT * INTO v FROM storefront.shop_check_listing(p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status);
  SELECT * INTO t FROM storefront.shop_check_listing_terms(p_min_qty, p_free_ship_qty, v.shipping_fee_usd);
  k := storefront.shop_check_listing_kind(p_product_kind);
  SELECT * INTO r FROM storefront.shop_create_listing(p_seller_id, p_actor, p_title, p_mass_label, p_description_md, p_price_usd,
                                                      p_shipping_usd, p_qty, p_status, p_min_qty, p_free_ship_qty);
  IF k <> 'vial' THEN
    UPDATE storefront.store_listings l SET product_kind = k
     WHERE l.id = r.listing_id AND l.seller_id = p_seller_id;
    PERFORM storefront.shop_audit('storefront.store_listings', r.listing_id, 'listing_kind_set', p_actor, NULL,
      jsonb_build_object('productKind', k));
  END IF;
  RETURN QUERY SELECT r.listing_id, r.status, r.qty_available, r.message;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_create_listing(bigint, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- ── update, with the type ────────────────────────────────────────────────────
-- The type is checked before the 1790104200 overload runs (it locks the
-- seller and the listing, refuses not-yours and organizer-managed rows,
-- compare-and-sets stock, writes the terms); the type is written under that
-- row lock and audited only when it changed.
DROP FUNCTION IF EXISTS storefront.shop_update_listing(bigint, text, text, text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_update_listing(p_seller_id bigint, p_actor text, p_listing_id text, p_title text, p_mass_label text,
                                               p_description_md text, p_price_usd text, p_shipping_usd text, p_qty text,
                                               p_expected_qty text, p_status text, p_min_qty text, p_free_ship_qty text,
                                               p_product_kind text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE k text; r record; o text;
BEGIN
  k := storefront.shop_check_listing_kind(p_product_kind);
  SELECT * INTO r FROM storefront.shop_update_listing(p_seller_id, p_actor, p_listing_id, p_title, p_mass_label, p_description_md,
                                                      p_price_usd, p_shipping_usd, p_qty, p_expected_qty, p_status,
                                                      p_min_qty, p_free_ship_qty);
  SELECT l.product_kind INTO o
    FROM storefront.store_listings l WHERE l.id = r.listing_id AND l.seller_id = p_seller_id;
  IF o IS DISTINCT FROM k THEN
    UPDATE storefront.store_listings l SET product_kind = k
     WHERE l.id = r.listing_id AND l.seller_id = p_seller_id;
    PERFORM storefront.shop_audit('storefront.store_listings', r.listing_id, 'listing_kind_set', p_actor,
      jsonb_build_object('productKind', o), jsonb_build_object('productKind', k));
  END IF;
  RETURN QUERY SELECT r.listing_id, r.status, r.qty_available, r.message;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_update_listing(bigint, text, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- ── the listings page reads the type ─────────────────────────────────────────
-- 1790104200's columns, then product_kind at the end (a reader selecting
-- named columns keeps working).
DROP FUNCTION IF EXISTS storefront.portal_list_listings(text);
DROP FUNCTION IF EXISTS storefront.shop_list_listings(bigint);
CREATE FUNCTION storefront.shop_list_listings(p_seller_id bigint)
RETURNS TABLE (id bigint, title text, description_md text, mass_label text, price_usd numeric, shipping_fee_usd numeric,
               qty_available int, max_per_order int, status text, effective_status text, organizer_managed boolean,
               created_at timestamptz, updated_at timestamptz, min_per_order int, free_shipping_min_qty int,
               product_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT l.id, l.title, l.description_md, l.mass_label, l.price_usd, l.shipping_fee_usd,
         COALESCE(l.qty_available, 0), l.max_per_order, l.status::text, e.effective,
         l.p2_product_id IS NOT NULL, l.created_at, l.updated_at, l.min_per_order, l.free_shipping_min_qty,
         l.product_kind
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
               created_at timestamptz, updated_at timestamptz, min_per_order int, free_shipping_min_qty int,
               product_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_listings(storefront.portal_resolve_seller(p_email))
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_create_listing(text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_create_listing(p_email text, p_title text, p_mass_label text, p_description_md text, p_price_usd text,
                                                 p_shipping_usd text, p_qty text, p_status text, p_min_qty text, p_free_ship_qty text,
                                                 p_product_kind text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_create_listing(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_title, p_mass_label,
                                               p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status, p_min_qty, p_free_ship_qty,
                                               p_product_kind)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_update_listing(text, text, text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_update_listing(p_email text, p_listing_id text, p_title text, p_mass_label text, p_description_md text,
                                                 p_price_usd text, p_shipping_usd text, p_qty text, p_expected_qty text, p_status text,
                                                 p_min_qty text, p_free_ship_qty text, p_product_kind text)
RETURNS TABLE (listing_id bigint, status text, qty_available int, message text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_update_listing(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_listing_id, p_title,
                                               p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_expected_qty, p_status,
                                               p_min_qty, p_free_ship_qty, p_product_kind)
$fn$;

REVOKE EXECUTE ON FUNCTION storefront.portal_list_listings(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.portal_create_listing(text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.portal_update_listing(text, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_seller_portal') THEN
    GRANT EXECUTE ON FUNCTION storefront.portal_list_listings(text) TO p2_seller_portal;
    GRANT EXECUTE ON FUNCTION storefront.portal_create_listing(text, text, text, text, text, text, text, text, text, text, text) TO p2_seller_portal;
    GRANT EXECUTE ON FUNCTION storefront.portal_update_listing(text, text, text, text, text, text, text, text, text, text, text, text, text) TO p2_seller_portal;
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104700_listing_product_kind.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104700_listing_product_kind.sql');
