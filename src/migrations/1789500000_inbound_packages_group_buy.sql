-- Campaign scoping for Receiving (Ian, 2026-09-20): the Flash Buy's first
-- inbound box showed up in Mixed Buy #5's receiving view — packages had no
-- campaign. Each physical vendor box belongs to exactly one buy, so stamp
-- it: created from the selected campaign, filtered everywhere it's listed.
ALTER TABLE inbound_packages ADD COLUMN IF NOT EXISTS group_buy_id bigint REFERENCES group_buys(id);

-- Backfill: campaign product sets are disjoint today (R60/T10 exist only in
-- the Flash Buy), so a package containing a Flash Buy product is a Flash
-- Buy box; everything else predates the Flash Buy's receiving = MB5.
-- Verified against live data before running: exactly one package (T10 x50,
-- 2026-09-20) classifies as Flash Buy.
UPDATE inbound_packages p SET group_buy_id = 3
WHERE p.group_buy_id IS NULL
  AND EXISTS (SELECT 1 FROM inbound_package_items i
              JOIN group_buy_products g ON g.product_id = i.product_id AND g.group_buy_id = 3
              WHERE i.package_id = p.id);
UPDATE inbound_packages SET group_buy_id = 1 WHERE group_buy_id IS NULL;

-- NOT NULL after the verified-complete backfill: the package list filters
-- by campaign, so a NULL-stamped row would be invisible in EVERY campaign
-- — silently hidden physical inventory, the worst failure mode available.
ALTER TABLE inbound_packages ALTER COLUMN group_buy_id SET NOT NULL;
