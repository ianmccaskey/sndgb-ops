-- The seller's "minimum order" refusal no longer cites a store cap.
--
-- Ian, 2026-11-17: "I would like the max 10 items removed from all. It
-- should be able to be increased to the max number of inventory." The
-- storefront took at most 10 of a listing per order; it now takes whatever
-- is in stock (a member seller's own max_per_order still holds). Nothing in
-- this database enforced that cap — it lived in the storefront's rules — but
-- storefront.shop_check_listing_terms explained the 1..10 bound on a
-- listing's MINIMUM with "The store takes up to 10 of a listing per order",
-- which is no longer true. The bound itself stays (the CHECK
-- store_listings min_per_order BETWEEN 1 AND 10 from 1790104200 binds every
-- writer); only the sentence changes, here and in the two apps that carry
-- the same check (the storefront's lib/sellers/rules.ts, the P2 Seller
-- Portal's src/lib/sellerRules.ts).
--
-- CREATE OR REPLACE with the identical signature: ownership, the REVOKE
-- from PUBLIC and every caller (shop_create_listing / shop_update_listing)
-- are untouched. Transactional, idempotent.

CREATE OR REPLACE FUNCTION storefront.shop_check_listing_terms(p_min_qty text, p_free_ship_qty text, p_shipping_fee numeric,
                                                               OUT min_per_order int, OUT free_shipping_min_qty int)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE v_min text := btrim(COALESCE(p_min_qty, '')); v_free text := btrim(COALESCE(p_free_ship_qty, ''));
BEGIN
  IF v_min = '' THEN
    min_per_order := 1;
  ELSIF v_min !~ '^[0-9]{1,3}$' OR v_min::int < 1 OR v_min::int > 10 THEN
    RAISE EXCEPTION 'Minimum order is a whole number from 1 to 10.'
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

COMMENT ON COLUMN storefront.store_listings.free_shipping_min_qty IS
  'Items in the whole order (every line of the shop''s order) at which this listing''s shipping fee is waived; NULL = none. The order pays the highest fee among lines not waived. A house mirror row carries its house''s count too: PRT''s 2-kit-minimum products list with its $15 under-minimum fee and a count of 2 (storefront lib/prtstore/rules.ts, 2026-11-17).';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790105400_listing_minimum_message.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790105400_listing_minimum_message.sql');
