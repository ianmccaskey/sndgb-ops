-- 1790101100's constraint triggers guard every FUTURE write, but a trigger
-- never looks at rows that already exist. This block makes the invariant
-- hold for the data on disk too: it refuses to apply (and so refuses to let
-- the ledger record it) while any campaign is on two platforms at once —
-- storefront settings on a base44-linked campaign, storefront settings on a
-- campaign holding orders from another source, or (the same thing seen from
-- the orders side) a non-storefront order sitting in a storefront campaign.
-- Idempotent: on a clean database it is a no-op and can be re-run.
DO $$
DECLARE
  linked INT;
  mixed INT;
  detail TEXT;
BEGIN
  SELECT COUNT(*) INTO linked
  FROM storefront.campaign_settings cs
  JOIN public.group_buys g ON g.id = cs.group_buy_id
  WHERE g.external_id IS NOT NULL;

  SELECT COUNT(*) INTO mixed
  FROM storefront.campaign_settings cs
  WHERE EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.group_buy_id = cs.group_buy_id
      AND COALESCE(o.raw_import->>'source', '') <> 'storefront'
  );

  IF linked > 0 OR mixed > 0 THEN
    SELECT string_agg(format('campaign %s (%s)', g.id, g.name), ', ') INTO detail
    FROM public.group_buys g
    WHERE EXISTS (SELECT 1 FROM storefront.campaign_settings cs WHERE cs.group_buy_id = g.id)
      AND (g.external_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM public.orders o WHERE o.group_buy_id = g.id AND COALESCE(o.raw_import->>'source', '') <> 'storefront'));
    RAISE EXCEPTION 'one platform per campaign: % campaign(s) are both storefront and base44/other-source — % — resolve by hand (unlink, or remove the storefront settings) before applying',
      linked + mixed, detail
      USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_one_platform';
  END IF;
END $$;
