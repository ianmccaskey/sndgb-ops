-- A campaign runs on ONE ordering platform. A campaign set up for the
-- storefront (a storefront.campaign_settings row) imports from there and its
-- Import page hides the base44 pull; a campaign linked to the base44 ordering
-- app (group_buys.external_id) imports from base44. Mixing them would hide
-- one source's orders behind the other's import mode for a campaign still
-- being fulfilled. The actions refuse the obvious cases; this makes it the
-- database's rule for EVERY writer, in both directions:
--   * setting up a campaign that is base44-linked or already holds orders
--     from another source is refused;
--   * linking a storefront campaign to base44 is refused;
--   * inserting (or re-sourcing) a non-storefront order into a storefront
--     campaign is refused.
-- Serialized on the group_buys row: the setup path takes it FOR UPDATE, an
-- order insert FOR SHARE, a link is an UPDATE of that row — so two writers
-- cannot each pass the check and commit a mixed campaign.
CREATE OR REPLACE FUNCTION public.assert_campaign_one_platform() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  linked BOOLEAN;
BEGIN
  IF TG_TABLE_SCHEMA = 'storefront' AND TG_TABLE_NAME = 'campaign_settings' THEN
    SELECT g.external_id IS NOT NULL INTO linked FROM public.group_buys g WHERE g.id = NEW.group_buy_id FOR UPDATE;
    IF COALESCE(linked, false) THEN
      RAISE EXCEPTION 'campaign % is linked to the base44 ordering app and cannot be set up for the storefront', NEW.group_buy_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_one_platform';
    END IF;
    IF EXISTS (SELECT 1 FROM public.orders o WHERE o.group_buy_id = NEW.group_buy_id AND COALESCE(o.raw_import->>'source', '') <> 'storefront') THEN
      RAISE EXCEPTION 'campaign % already holds orders from another source and cannot be set up for the storefront', NEW.group_buy_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_one_platform';
    END IF;
  ELSIF TG_TABLE_NAME = 'group_buys' THEN
    IF NEW.external_id IS NOT NULL AND EXISTS (SELECT 1 FROM storefront.campaign_settings cs WHERE cs.group_buy_id = NEW.id) THEN
      RAISE EXCEPTION 'campaign % is set up for the storefront and cannot be linked to the base44 ordering app', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_one_platform';
    END IF;
  ELSIF TG_TABLE_NAME = 'orders' THEN
    IF COALESCE(NEW.raw_import->>'source', '') <> 'storefront' THEN
      PERFORM 1 FROM public.group_buys g WHERE g.id = NEW.group_buy_id FOR SHARE;
      IF EXISTS (SELECT 1 FROM storefront.campaign_settings cs WHERE cs.group_buy_id = NEW.group_buy_id) THEN
        RAISE EXCEPTION 'campaign % is a storefront campaign; order % (source %) cannot be imported from another platform', NEW.group_buy_id, NEW.order_number, COALESCE(NEW.raw_import->>'source', 'none')
          USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_one_platform';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS campaign_one_platform ON storefront.campaign_settings;
CREATE CONSTRAINT TRIGGER campaign_one_platform
  AFTER INSERT ON storefront.campaign_settings
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.assert_campaign_one_platform();

DROP TRIGGER IF EXISTS campaign_one_platform ON public.group_buys;
CREATE CONSTRAINT TRIGGER campaign_one_platform
  AFTER UPDATE OF external_id ON public.group_buys
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.assert_campaign_one_platform();

DROP TRIGGER IF EXISTS campaign_one_platform ON public.orders;
CREATE CONSTRAINT TRIGGER campaign_one_platform
  AFTER INSERT OR UPDATE OF raw_import, group_buy_id ON public.orders
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.assert_campaign_one_platform();
