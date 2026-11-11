-- A COA report may be a BLEND's: the blend's total mass and purity as before,
-- and each component's own mass and purity.
--
-- Ian, 2026-11-10: "I need to change the COA method to allow for blends ...
-- There are 4 components to the KLOW each with their own mass and purity."
-- His example, Accumark MEYX-R5XF (batch Klow80-1026): Blend Total Quantity
-- 88.421 mg, Blend Purity 99.85%; KPV 11.41 mg / 99.43%, GHK-Cu 57.569 mg /
-- 99.96%, BPC-157 9.923 mg / 99.639%, TB500 (Thymosin Beta 4) 9.519 mg /
-- 99.94%; endotoxin < LOQ, conforms.
--
--   components  NULL for a single-substance report. For a blend, a JSON array
--               of 2–12 objects {"name", "mass_mg", "purity_pct"} in the
--               report's order: the name as the report prints it (1–60
--               characters, trimmed, no control characters, unique within the
--               report ignoring case); mass_mg above 0 and purity_pct 0–100,
--               both JSON numbers with at most three decimals. Both figures
--               are required per component, as they are for the report
--               (1790104000: a COA states mass and purity at the least).
--               Every writer is held to that by the CHECK
--               coa_reports_components (storefront.coa_components_valid).
--
-- The report's own mass_mg / purity_pct stay REQUIRED and are the BLEND's
-- figures (the lab's total quantity and blend purity), so the library's
-- summary line keeps its meaning and the components are listed under it.
-- Nothing adds the components up into the total: a lab may state a total it
-- measured on its own, and a report is filed as it reads.
--
-- mass_mg and purity_pct take a third decimal (NUMERIC(11,3) / (6,3): the
-- same whole digits as before, so no stored value can fail the cast): the
-- lab states 57.569 mg and 99.639%. No view depends on either column.
--
-- Written only by the Ops COA Reports actions (add/updateStorefrontCoaReport),
-- which check the components before the insert and refuse with zero rows; the
-- version digest the list, update and delete actions share covers the column.
-- The storefront reads it (lib/coa/queries.ts there) and never writes it.

ALTER TABLE storefront.coa_reports
  ALTER COLUMN mass_mg    TYPE NUMERIC(11,3),
  ALTER COLUMN purity_pct TYPE NUMERIC(6,3);

ALTER TABLE storefront.coa_reports
  ADD COLUMN IF NOT EXISTS components JSONB;

CREATE OR REPLACE FUNCTION storefront.coa_components_valid(p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  e    jsonb;
  n    text;
  m    numeric;
  u    numeric;
  seen text[] := ARRAY[]::text[];
BEGIN
  IF p IS NULL THEN
    RETURN true;  -- a single-substance report
  END IF;
  IF jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) NOT BETWEEN 2 AND 12 THEN
    RETURN false;
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p) AS t(x) LOOP
    -- exactly the three keys, each of its own JSON type
    IF jsonb_typeof(e) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 3
       OR jsonb_typeof(e -> 'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e -> 'mass_mg') IS DISTINCT FROM 'number'
       OR jsonb_typeof(e -> 'purity_pct') IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    n := e ->> 'name';
    m := (e ->> 'mass_mg')::numeric;
    u := (e ->> 'purity_pct')::numeric;
    IF n <> btrim(n) OR length(n) NOT BETWEEN 1 AND 60 OR n ~ '[[:cntrl:]]'
       OR lower(n) = ANY (seen)
       OR m <= 0 OR m >= 100000000 OR round(m, 3) <> m
       OR u < 0 OR u > 100 OR round(u, 3) <> u THEN
      RETURN false;
    END IF;
    seen := seen || lower(n);
  END LOOP;
  RETURN true;
END $$;

COMMENT ON FUNCTION storefront.coa_components_valid(jsonb) IS
  'CHECK for coa_reports.components: NULL, or 2-12 {name, mass_mg, purity_pct} with unique names, mass > 0 and purity 0-100 at most three decimals (1790104900).';

ALTER TABLE storefront.coa_reports DROP CONSTRAINT IF EXISTS coa_reports_components;
ALTER TABLE storefront.coa_reports ADD CONSTRAINT coa_reports_components
  CHECK (storefront.coa_components_valid(components));

COMMENT ON COLUMN storefront.coa_reports.components IS
  'A blend''s components as the report lists them: [{name, mass_mg, purity_pct}], 2-12; NULL = a single-substance report. mass_mg / purity_pct on the row stay the blend''s total and purity.';
COMMENT ON COLUMN storefront.coa_reports.mass_mg IS
  'Tested mass in mg, as the lab measured it (a blend: its total quantity). Required with purity_pct (coa_reports_mass_and_purity).';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104900_coa_report_blend.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104900_coa_report_blend.sql');
