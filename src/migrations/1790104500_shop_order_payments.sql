-- A shop order's payment, shown on the order (Ian, 2026-11-10: "ST-2026-0019
-- … I see this order placed but I dont see the transaction details on the
-- order").
--
-- The shop order drawer (P2 Collective Orders → Shop orders, and the P2
-- Seller Portal's order drawer) was built for fulfilment only: neither app
-- could read storefront.payments, so a paid order showed "Paid" with no
-- transaction. This adds the read, once, in the seller-rules shape of
-- 1790103600: a core storefront.shop_list_payments(p_seller_id, order) that
-- P2 Collective Orders calls for the organizer-run shops, and a granted
-- portal_list_payments(p_email, order) wrapper that only resolves the shop
-- and delegates.
--
-- Every payment claim on that ONE order of that shop, live first: network,
-- what arrived (per token, e.g. "800 USDC"), status, the amount the order
-- asked for and what the chain showed in dollars (stablecoins only; a native
-- coin is listed under what arrived but not priced), the transaction hash
-- (the apps link it to the explorer),
-- the shop's own wallet it landed on, and the checker's note for a claim that
-- is still being checked or was rejected. Never the sender: that is the
-- buyer's wallet (anyone can still follow the hash to the explorer, but this
-- app does not hand it out). Read only; nothing here changes a payment.

DROP FUNCTION IF EXISTS storefront.portal_list_payments(text, text);
DROP FUNCTION IF EXISTS storefront.shop_list_payments(bigint, text);
CREATE FUNCTION storefront.shop_list_payments(p_seller_id bigint, p_order_id text)
RETURNS TABLE (id bigint, store_order_id bigint, rail text, received text, status text,
               amount_claimed_usd numeric, verified_usd numeric, tx_hash text, paid_to text,
               note text, created_at timestamptz, verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT p.id, p.store_order_id, p.rail::text,
         (SELECT string_agg(trim_scale(x.amount)::text || ' ' || x.token, ' + ' ORDER BY x.amount DESC, x.token)
            FROM (SELECT t->>'token' AS token, sum((t->>'amount')::numeric) AS amount
                    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.onchain->'transfers') = 'array' THEN p.onchain->'transfers' ELSE '[]'::jsonb END) t
                   WHERE jsonb_typeof(t) = 'object' AND COALESCE(t->>'token', '') <> '' AND jsonb_typeof(t->'amount') = 'number'
                   GROUP BY 1) x),
         p.status::text, p.amount_claimed_usd, p.verified_usd, p.tx_hash,
         CASE WHEN jsonb_typeof(p.onchain->'wallet') = 'string' THEN p.onchain->>'wallet' END,
         CASE WHEN p.status IN ('pending', 'rejected', 'mismatch') THEN p.verify_error END,
         p.created_at, p.verified_at
    FROM storefront.payments p
    JOIN storefront.store_orders o ON o.id = p.store_order_id
   WHERE p.store_order_id = storefront.shop_parse_id(p_order_id, 'order')
     AND o.seller_id = p_seller_id
   ORDER BY (p.status <> 'rejected') DESC, p.created_at DESC, p.id DESC
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_payments(bigint, text) FROM PUBLIC;

-- ── the portal's wrapper: resolve the shop, delegate, nothing else ──────────
CREATE FUNCTION storefront.portal_list_payments(p_email text, p_order_id text)
RETURNS TABLE (id bigint, store_order_id bigint, rail text, received text, status text,
               amount_claimed_usd numeric, verified_usd numeric, tx_hash text, paid_to text,
               note text, created_at timestamptz, verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_payments(storefront.portal_resolve_seller(p_email), p_order_id)
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.portal_list_payments(text, text) FROM PUBLIC;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_seller_portal') THEN
    GRANT EXECUTE ON FUNCTION storefront.portal_list_payments(text, text) TO p2_seller_portal;
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104500_shop_order_payments.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104500_shop_order_payments.sql');
