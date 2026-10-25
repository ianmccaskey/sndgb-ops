-- COA products are digital, with no freight and no testing cost of their own.
--
-- Ian, 2026-10-25: "any product that is a COA will ALWAYS be digital by
-- nature. A COA is a digital copy of a lab report. They will not have
-- freight or their own testing cost. Apply this to these and any previous
-- campaign products for COAs."
--
-- Until now the flag was set by hand after the fact: the ordering-app
-- product sync (saveProduct) creates "COA - <sku>" rows with the column
-- default digital=false, so every new campaign shipped three or four
-- physical COAs that then sat in fulfillment packing math until someone
-- noticed (Elora & More: COA - Fox-04 DRI 10, COA - Reta 15, COA - VIP10,
-- COA - Wolverine 10mg (5/5); Surprise-Last Chance would have repeated it).
-- One COA line in Mixed Buy #5 (COA - LOBSTER R30) also carried a 225
-- testing cost, which the per-unit P&L spread over its sales.
--
-- A COA is recognised by its SKU: "COA" followed by a space, a hyphen or
-- the end of the string, case-insensitive (every COA row is "COA - <sku>").
--
--  * products: a COA row is digital on INSERT whatever the writer passed
--    (the sync passes nothing), and an UPDATE that would turn a digital
--    COA physical is refused — set_product_digital() surfaces that as an
--    error on the Products page instead of a silent "not changed".
--  * group_buy_products: a COA line with testing cost, product freight or
--    direct-ship freight is refused on INSERT and UPDATE, so the campaign
--    form shows the reason (upsertCampaignProduct raises into cError).
--
-- Backfill is idempotent and audited (actor 'migration 1790102000'); on
-- 2026-10-25 the live rows had already been fixed through the audited
-- paths in-session, so it touched nothing. The guard from 1786474000
-- (no digital product may hold live shipment attribution) is re-asserted
-- before any COA is flipped.

CREATE OR REPLACE FUNCTION is_coa_sku(p_sku text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT p_sku ~* '^coa(\s|-|$)'
$fn$;

COMMENT ON FUNCTION is_coa_sku(text) IS
  'A certificate-of-analysis product: SKU "COA" followed by space, hyphen or end (1790102000). Always digital; its campaign lines carry no freight or testing cost.';

-- guard: a COA about to be flipped must not already sit in a live box
DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
    JOIN order_items oi ON oi.id = si.order_item_id
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    JOIN products p ON p.id = g.product_id
    WHERE is_coa_sku(p.sku_code) AND NOT p.digital
  ) THEN
    RAISE EXCEPTION 'a physical COA product holds live shipment attribution - void those shipments before applying 1790102000';
  END IF;
END
$chk$;

-- backfill products (audited like set_product_digital)
WITH flipped AS (
  UPDATE products p SET digital = true
  WHERE is_coa_sku(p.sku_code) AND NOT p.digital
  RETURNING p.id, p.sku_code
)
INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
SELECT 'products', f.id::text, 'product_digital_set', 'migration 1790102000',
       jsonb_build_object('digital', false),
       jsonb_build_object('sku_code', f.sku_code, 'digital', true)
FROM flipped f;

-- backfill lines
WITH cleared AS (
  UPDATE group_buy_products g
     SET testing_cost_usd = 0, freight_usd = 0, direct_freight_usd = 0
    FROM products p
   WHERE p.id = g.product_id AND is_coa_sku(p.sku_code)
     AND (g.testing_cost_usd <> 0 OR g.freight_usd <> 0 OR g.direct_freight_usd <> 0)
  RETURNING g.id, p.sku_code,
            (SELECT jsonb_build_object('testing_cost_usd', o.testing_cost_usd, 'freight_usd', o.freight_usd, 'direct_freight_usd', o.direct_freight_usd)
               FROM group_buy_products o WHERE o.id = g.id) AS old_vals
)
INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
SELECT 'group_buy_products', c.id::text, 'campaign_product_coa_costs_cleared', 'migration 1790102000',
       c.old_vals,
       jsonb_build_object('sku_code', c.sku_code, 'testing_cost_usd', 0, 'freight_usd', 0, 'direct_freight_usd', 0)
FROM cleared c;

-- products: COA rows are digital
CREATE OR REPLACE FUNCTION products_coa_is_digital() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF is_coa_sku(NEW.sku_code) AND NOT NEW.digital THEN
    IF TG_OP = 'UPDATE' AND OLD.digital THEN
      RAISE EXCEPTION 'COA products are always digital: % cannot be made physical', NEW.sku_code
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.digital := true;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS products_coa_is_digital ON products;
CREATE TRIGGER products_coa_is_digital
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_coa_is_digital();

-- campaign lines: no testing cost or freight on a COA
CREATE OR REPLACE FUNCTION gbp_coa_no_costs() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_sku text;
BEGIN
  IF NEW.testing_cost_usd <> 0 OR NEW.freight_usd <> 0 OR NEW.direct_freight_usd <> 0 THEN
    SELECT p.sku_code INTO v_sku FROM products p
     WHERE p.id = NEW.product_id AND is_coa_sku(p.sku_code);
    IF FOUND THEN
      RAISE EXCEPTION 'COA lines carry no testing cost or freight: % is a certificate, not a kit', v_sku
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS gbp_coa_no_costs ON group_buy_products;
CREATE TRIGGER gbp_coa_no_costs
  BEFORE INSERT OR UPDATE ON group_buy_products
  FOR EACH ROW EXECUTE FUNCTION gbp_coa_no_costs();

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102000_coa_products_digital.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102000_coa_products_digital.sql');
