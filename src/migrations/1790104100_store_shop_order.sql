-- Store hall order (Ian, 2026-11-09): P², PRT, Papa Porgy's Emporium,
-- Princess Paige's Pantry, ELPEPPYJOE BREWERY, Wisco Reserve, K&K 3D Designs.
--
-- The hall sorts houses first, then storefront.sellers.sort_order (nulls
-- last), then approval time, then id (p2collective-app
-- lib/store/hall-rules.ts compareStorefronts). Until now only the two houses
-- carried a sort_order, so member shops showed in approval order. This sets
-- every shop's place; a shop approved later has no sort_order and joins the
-- end of the hall by approval time until the organizers give it one.
--
-- Keyed by slug and refused whole if any of the seven is missing, so a renamed
-- or removed shop never leaves the order half applied.

DO $$
DECLARE
  n int;
BEGIN
  UPDATE storefront.sellers s
     SET sort_order = v.pos
    FROM (VALUES
      ('p2',                      0),
      ('prt',                     1),
      ('papa-porgy-s-emporium',   2),
      ('princess-paige-s-pantry', 3),
      ('elpeppyjoe-brewery',      4),
      ('wisco-reserve',           5),
      ('k-k-3d-designs',          6)
    ) AS v(slug, pos)
   WHERE s.slug = v.slug;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 7 THEN
    RAISE EXCEPTION 'store shop order: expected 7 shops by slug, found %', n;
  END IF;
END $$;
