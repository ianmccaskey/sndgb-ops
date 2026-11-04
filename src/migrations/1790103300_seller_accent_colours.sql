-- Shop accents beyond the gold family.
--
-- Ian, 2026-11-03: every storefront in the hall gets its own colour on the
-- shared product loop and its rings — pink for Paige's, blue for Papa
-- Porgy's, green for Wisco Reserve, red for PRT, gold for P². The storefront
-- tints one gold render per shop (lib/store/hall-rules.ts renderTint), so
-- the seller's accent is the only thing that changes. The 1790101600 CHECK
-- allowed the gold family only; this widens it. set_seller_branding is
-- unchanged (it relies on the CHECK).

DO $mig$
BEGIN
  ALTER TABLE storefront.sellers DROP CONSTRAINT IF EXISTS sellers_accent_known;
  ALTER TABLE storefront.sellers ADD CONSTRAINT sellers_accent_known
    CHECK (accent IS NULL OR accent IN ('gold','gold_bright','gold_deep','foil','parchment','pink','blue','green','red'));
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103300_seller_accent_colours.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103300_seller_accent_colours.sql');
