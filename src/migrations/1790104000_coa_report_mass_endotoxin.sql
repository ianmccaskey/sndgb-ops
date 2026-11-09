-- A COA report states the tested mass and the purity, and the endotoxin
-- screening when the lab ran one.
--
-- Ian, 2026-11-09: "all COA need mass and purity at minimum. Also Endotoxin
-- screening as well if available." The COA library on p2collective.app
-- summarises every report as tested mass + purity (+ endotoxin); a campaign
-- report could only carry the purity, so its summary was half a line.
--
--   mass_mg    the mass the lab measured, in mg (the figure a member compares
--              with the label). Positive, two decimals.
--   endotoxin  'pass' | 'fail' when the lab screened for endotoxin; NULL when
--              it did not (or the report doesn't say). An outcome, not a
--              number: labs report it against a limit ("< 25 EU/vial"), and a
--              bare value would be read as a measurement.
--
-- Mass and purity are REQUIRED on every report from here on
-- (coa_reports_mass_and_purity): a report without them is not what members
-- are shown as a COA. The table is empty today (COA Reports has been used for
-- no campaign yet), so the constraint validates against nothing; the guard
-- below refuses to apply over rows that would break it rather than fail in
-- the middle. Written only by the Ops COA Reports actions
-- (add/updateStorefrontCoaReport), which check both before the insert and say
-- why on a refusal; the storefront reads the columns (lib/coa/queries.ts
-- there) and never writes them.

DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad FROM storefront.coa_reports WHERE purity_pct IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION '% COA report(s) have no purity on file; add it on COA Reports (or delete the report) before applying 1790104000', bad;
  END IF;
  -- rows that predate mass_mg cannot have one: the table must be empty for the NOT-NULL rule to hold
  SELECT count(*) INTO bad FROM storefront.coa_reports;
  IF bad > 0 AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storefront' AND table_name = 'coa_reports' AND column_name = 'mass_mg'
  ) THEN
    RAISE EXCEPTION '% COA report(s) exist without a tested mass; this migration expects an empty table (see its header)', bad;
  END IF;
END $$;

ALTER TABLE storefront.coa_reports
  ADD COLUMN IF NOT EXISTS mass_mg   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS endotoxin TEXT;

ALTER TABLE storefront.coa_reports DROP CONSTRAINT IF EXISTS coa_reports_mass_positive;
ALTER TABLE storefront.coa_reports ADD CONSTRAINT coa_reports_mass_positive
  CHECK (mass_mg IS NULL OR mass_mg > 0);

ALTER TABLE storefront.coa_reports DROP CONSTRAINT IF EXISTS coa_reports_endotoxin;
ALTER TABLE storefront.coa_reports ADD CONSTRAINT coa_reports_endotoxin
  CHECK (endotoxin IS NULL OR endotoxin IN ('pass', 'fail'));

ALTER TABLE storefront.coa_reports DROP CONSTRAINT IF EXISTS coa_reports_mass_and_purity;
ALTER TABLE storefront.coa_reports ADD CONSTRAINT coa_reports_mass_and_purity
  CHECK (mass_mg IS NOT NULL AND purity_pct IS NOT NULL);

COMMENT ON COLUMN storefront.coa_reports.mass_mg IS
  'Tested mass in mg, as the lab measured it. Required with purity_pct (coa_reports_mass_and_purity).';
COMMENT ON COLUMN storefront.coa_reports.endotoxin IS
  'Endotoxin screening outcome: pass | fail; NULL = not screened or not stated.';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104000_coa_report_mass_endotoxin.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104000_coa_report_mass_endotoxin.sql');
