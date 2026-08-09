-- The COA add-on turned out to be an ordinary catalog product (added as its
-- own campaign line with a GB price), so the bespoke coa_addon_* columns were
-- the wrong model — drop them. A COA line's real need is a MAXIMUM quantity
-- ("only 25 available"), which target_moq (a minimum) can't express. Replace
-- with a generic optional per-line cap usable on any product.
--   qty_cap NULL      → no cap (normal product)
--   qty_cap = N       → at most N units intended; UI flags sold-out when
--                       demand reaches N (visibility only — the actual sale
--                       is controlled in the ordering app, which this reads).
ALTER TABLE group_buy_products DROP COLUMN IF EXISTS coa_addon_price_usd;
ALTER TABLE group_buy_products DROP COLUMN IF EXISTS coa_addon_limit;
ALTER TABLE group_buy_products ADD COLUMN IF NOT EXISTS qty_cap INTEGER CHECK (qty_cap IS NULL OR qty_cap >= 0);
