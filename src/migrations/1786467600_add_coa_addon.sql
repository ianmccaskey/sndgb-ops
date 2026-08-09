-- Per-product COA (Certificate of Analysis) add-on: an optional extra a
-- customer can buy for a product, with its own price and a hard availability
-- cap (e.g. $70, 25 available). Configured per campaign product.
--   coa_addon_price_usd = 0  → no add-on offered for this product
--   coa_addon_limit           → how many add-on slots exist (0 = none)
ALTER TABLE group_buy_products
  ADD COLUMN IF NOT EXISTS coa_addon_price_usd NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (coa_addon_price_usd >= 0),
  ADD COLUMN IF NOT EXISTS coa_addon_limit INTEGER NOT NULL DEFAULT 0 CHECK (coa_addon_limit >= 0);
