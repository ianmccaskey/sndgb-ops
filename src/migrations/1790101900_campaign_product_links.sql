-- Per-campaign ordering-app product links (Ian, 2026-10-19: "commit the fix").
--
-- products.external_id held ONE base44 product id per product, but base44
-- keeps a separate Product record per group buy: Mixed Buy #5's R30 and
-- Elora & More's R30 are different ids. The ordering-app product sync
-- (saveProduct, ON CONFLICT sku_code) overwrote that single link with
-- whichever campaign was synced last, so syncing Elora & More (2026-10-13,
-- refreshed 10-15) moved R30, T60, Klow80, the three JM Pep Tins, COA - R30
-- and COA - T60 off Mixed Buy #5's records: 371 of its 617 orders stopped
-- mapping on pull, its shipment pushes stopped stamping those items'
-- shipped_date, and syncing Mixed Buy #5 again would have broken Elora &
-- More the same way. One link per (campaign, product) ends the seesaw.
--
-- Every reader now resolves the link through the order's OWN campaign
-- (order_items -> group_buy_products.group_buy_id). products.external_id
-- stays as a frozen legacy value; nothing reads it after this change.
--
-- Backfill = order evidence only. For each campaign, each base44 product
-- id its imported orders reference resolves to (a) the product that holds
-- that id today, else (b) the ONE product of that campaign whose SKU or
-- name matches a name those order lines used for the id (Klow/Klow80 and
-- COA - R30/COA - R30 HXTNT are renames of one base44 record). On
-- 2026-10-19 every campaign product had order evidence and the only
-- unlinked catalog products were August GB4 leftovers in no campaign. The
-- DO block refuses the whole migration unless every base44 order line in
-- every campaign resolves, every link's product belongs to its campaign,
-- and every product resolved from an order's base44 lines is already on
-- that local order.
--
-- Not money; no advisory lock. The two unique constraints arbitrate
-- concurrent syncs.

CREATE TABLE IF NOT EXISTS campaign_product_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_id bigint NOT NULL REFERENCES group_buys(id),
  product_id bigint NOT NULL REFERENCES products(id),
  external_id text NOT NULL CHECK (external_id <> '' AND external_id = btrim(external_id)),
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_product_links_ext_uniq UNIQUE (group_buy_id, external_id),
  CONSTRAINT campaign_product_links_product_uniq UNIQUE (group_buy_id, product_id)
);

CREATE INDEX IF NOT EXISTS campaign_product_links_product_idx
  ON campaign_product_links (product_id);

COMMENT ON TABLE campaign_product_links IS
  'Which ordering-app (base44) Product record stands for a local product IN ONE campaign. base44 keeps a separate Product per group buy, so the link is per campaign (1790101900).';
COMMENT ON COLUMN products.external_id IS
  'LEGACY, frozen 2026-10-19: one base44 id per product could only ever be right for one campaign. Read campaign_product_links instead (1790101900).';

-- Backfill: only into an empty table, so a re-run is a no-op and a
-- duplicate (campaign, product) or (campaign, id) raises instead of being
-- silently skipped.
INSERT INTO campaign_product_links (group_buy_id, product_id, external_id, linked_by)
WITH lines AS (
  SELECT DISTINCT o.group_buy_id AS gb, it->>'product_id' AS ext, btrim(it->>'product_name') AS pname
  FROM orders o
  CROSS JOIN LATERAL jsonb_array_elements(((o.raw_import->>'json')::jsonb)->'items') it
  WHERE o.raw_import->>'source' = 'base44'
    AND btrim(COALESCE(it->>'product_id', '')) <> ''
), ids AS (
  SELECT DISTINCT gb, ext FROM lines
), res AS (
  SELECT i.gb, i.ext,
         (SELECT p.id FROM products p WHERE p.external_id = i.ext) AS by_current,
         (SELECT array_agg(DISTINCT p.id)
            FROM lines l
            JOIN products p ON lower(p.sku_code) = lower(l.pname) OR lower(p.name) = lower(l.pname)
            JOIN group_buy_products gbp ON gbp.product_id = p.id AND gbp.group_buy_id = i.gb
           WHERE l.gb = i.gb AND l.ext = i.ext) AS by_name
  FROM ids i
)
SELECT res.gb,
       COALESCE(res.by_current, res.by_name[1]),
       res.ext,
       'migration 1790101900'
FROM res
WHERE NOT EXISTS (SELECT 1 FROM campaign_product_links)
  -- the current holder, unless the names those lines used point at a
  -- different campaign product; else exactly one name match. Anything
  -- else stays unlinked and the proof below refuses the migration.
  AND ((res.by_current IS NOT NULL AND (res.by_name IS NULL OR res.by_current = ANY (res.by_name)))
       OR (res.by_current IS NULL AND cardinality(res.by_name) = 1));

DO $$
DECLARE
  n_unresolved int;
  n_foreign int;
  n_missing int;
BEGIN
  -- 1. every product id on every imported base44 order line resolves in its campaign
  SELECT count(*) INTO n_unresolved
  FROM (
    SELECT DISTINCT o.group_buy_id AS gb, it->>'product_id' AS ext
    FROM orders o
    CROSS JOIN LATERAL jsonb_array_elements(((o.raw_import->>'json')::jsonb)->'items') it
    WHERE o.raw_import->>'source' = 'base44'
      AND btrim(COALESCE(it->>'product_id', '')) <> ''
  ) l
  WHERE NOT EXISTS (SELECT 1 FROM campaign_product_links c
                    WHERE c.group_buy_id = l.gb AND c.external_id = l.ext);

  -- 2. every link's product is a product of that campaign
  SELECT count(*) INTO n_foreign
  FROM campaign_product_links c
  WHERE NOT EXISTS (SELECT 1 FROM group_buy_products g
                    WHERE g.group_buy_id = c.group_buy_id AND g.product_id = c.product_id);

  -- 3. what the links say each order contains is already on the local order
  SELECT count(*) INTO n_missing
  FROM orders o
  CROSS JOIN LATERAL jsonb_array_elements(((o.raw_import->>'json')::jsonb)->'items') it
  JOIN campaign_product_links c ON c.group_buy_id = o.group_buy_id AND c.external_id = it->>'product_id'
  WHERE o.raw_import->>'source' = 'base44'
    AND NOT EXISTS (SELECT 1 FROM order_items oi
                    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
                    WHERE oi.order_id = o.id AND g.product_id = c.product_id);

  IF n_unresolved > 0 OR n_foreign > 0 OR n_missing > 0 THEN
    RAISE EXCEPTION 'campaign_product_links backfill refused: % unresolved base44 product id(s), % link(s) outside their campaign, % order line(s) resolving to a product the local order lacks',
      n_unresolved, n_foreign, n_missing;
  END IF;
END $$;
