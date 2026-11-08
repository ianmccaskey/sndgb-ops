-- A second house shop in the store: PRT, fed from its own app.
--
-- Ian, 2026-11-08. The hall sold ONE house shop (P², stock and sales orders
-- in the P² Orders app database) and the schema said so: the unique index
-- sellers_one_house allowed a single kind = 'house' row. PRT's actively sold
-- products now list in the same store, and a paid PRT store order is written
-- into the PRT Operations app database ("Peptide Ops DB") as a confirmed
-- sales order with Ian and Paige as its reps at 50/50 — PRT orders are
-- fulfilled in the PRT app, not in P2 Collective Orders (this supersedes
-- the 1790103600 header's wording for PRT).
--
-- What changes:
--  * sellers.house_source names the database behind a house shop ('p2' |
--    'prt'); individuals carry NULL. One house per source (partial unique
--    index), replacing the one-house index. The CHECK keeps kind and source
--    in step.
--  * store_listings.p2_product_id and store_orders.p2_sales_order_id /
--    p2_sales_order_number keep their names (the seller-portal functions and
--    the running storefront read them) but now mean "the house database's
--    id", the house being the row's seller. A PRT order's ids stay NULL
--    until the storefront writes it at payment time.
--  * store_listings (seller_id, p2_product_id) is unique: the storefront
--    keeps one mirror row per house product under its own lock, and the
--    index makes a duplicate impossible rather than merely unlikely.
--  * The PRT seller row is seeded SUSPENDED: the shop opens when the
--    organizers approve it (status 'approved', approved_at, approved_by)
--    after the end-to-end check. managed_in_ops is added here too (the same
--    definition as 1790103600) so this file applies in either order.
--
-- Fully transactional, idempotent: probe inside BEGIN … ROLLBACK.

-- ── 1. managed_in_ops (same as 1790103600; whichever runs first wins) ─────
ALTER TABLE storefront.sellers ADD COLUMN IF NOT EXISTS managed_in_ops boolean NOT NULL DEFAULT false;

-- ── 2. house_source ──────────────────────────────────────────────────────
ALTER TABLE storefront.sellers ADD COLUMN IF NOT EXISTS house_source text;
COMMENT ON COLUMN storefront.sellers.house_source IS
  'House shops only: which database holds the shop''s stock and receives its paid orders — p2 = P² Orders app (P2 Ops DB), prt = PRT Operations app (Peptide Ops DB). NULL for individual sellers.';

-- the one house row today is P²
UPDATE storefront.sellers
   SET house_source = 'p2', managed_in_ops = true
 WHERE kind = 'house' AND house_source IS NULL;

DO $mig$
BEGIN
  ALTER TABLE storefront.sellers ADD CONSTRAINT sellers_house_source
    CHECK ((kind = 'house') = (house_source IS NOT NULL)
           AND (house_source IS NULL OR house_source IN ('p2', 'prt')));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$mig$;

-- one house per source replaces one house in total
CREATE UNIQUE INDEX IF NOT EXISTS sellers_one_per_house_source
  ON storefront.sellers (house_source) WHERE kind = 'house';
DROP INDEX IF EXISTS storefront.sellers_one_house;

-- ── 3. one mirror listing per (house, product) ───────────────────────────
DO $mig$
DECLARE v_dups int;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT 1 FROM storefront.store_listings
    WHERE p2_product_id IS NOT NULL
    GROUP BY seller_id, p2_product_id HAVING count(*) > 1
  ) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION '1790103800: % duplicate house mirror listing(s) (seller_id, p2_product_id); merge them before applying', v_dups;
  END IF;
END
$mig$;
CREATE UNIQUE INDEX IF NOT EXISTS store_listings_house_product_uniq
  ON storefront.store_listings (seller_id, p2_product_id) WHERE p2_product_id IS NOT NULL;

COMMENT ON COLUMN storefront.store_listings.p2_product_id IS
  'House listings: products.id in the HOUSE database named by the seller''s house_source (P² Orders DB or PRT Peptide Ops DB; no cross-database FK). NULL for an individual seller''s listing.';
COMMENT ON COLUMN storefront.store_orders.p2_sales_order_id IS
  'House orders: sales_orders.id in the house database named by the seller''s house_source. P² writes it at placement (a quote); PRT writes it once the payment verified, so it is NULL until then.';
COMMENT ON COLUMN storefront.store_orders.p2_sales_order_number IS
  'House orders: the house database''s order number (ORD-YYYY-NNNN) for the row in p2_sales_order_id.';

-- the worker's shipping read-back rotates through a house's paid orders by
-- this stamp (oldest check first, never-checked first), so a long tail of
-- unchanged orders can never starve a newer one
ALTER TABLE storefront.store_orders ADD COLUMN IF NOT EXISTS house_ship_checked_at timestamptz;
COMMENT ON COLUMN storefront.store_orders.house_ship_checked_at IS
  'When the storefront worker last read this house order''s fulfilment from its house database (lib/store/shipments.ts); NULL = never. Drives the sweep''s rotation.';
CREATE INDEX IF NOT EXISTS store_orders_house_ship_sweep_idx
  ON storefront.store_orders (seller_id, house_ship_checked_at NULLS FIRST)
  WHERE status IN ('paid', 'shipped') AND p2_sales_order_id IS NOT NULL AND delivered_at IS NULL;

-- ── 4. seed PRT, closed until approved ───────────────────────────────────
INSERT INTO storefront.sellers (slug, display_name, kind, house_source, fee_pct, status, accent, sort_order, managed_in_ops)
VALUES ('prt', 'PRT', 'house', 'prt', 0, 'suspended', 'red', 1, true)
ON CONFLICT (slug) DO NOTHING;

-- the slug must now be THE PRT house: a member seller who took 'prt' first would
-- make ON CONFLICT skip the seed silently, and approving that row would never
-- open the shop (Codex, 2026-11-08). A re-run after the organizers approved
-- the house passes and leaves its status alone.
DO $mig$
DECLARE v_kind text; v_source text;
BEGIN
  SELECT s.kind::text, s.house_source INTO v_kind, v_source FROM storefront.sellers s WHERE s.slug = 'prt';
  IF v_kind IS DISTINCT FROM 'house' OR v_source IS DISTINCT FROM 'prt' THEN
    RAISE EXCEPTION '1790103800: slug ''prt'' is held by a % seller (house_source %), not the PRT house; rename that seller first', coalesce(v_kind, 'missing'), coalesce(v_source, 'none');
  END IF;
END
$mig$;

UPDATE storefront.sellers SET sort_order = 0 WHERE slug = 'p2' AND kind = 'house' AND sort_order IS NULL;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103800_second_house.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103800_second_house.sql');
