-- A published storefront campaign must always have at least one active
-- payment option, or members are shown a campaign they cannot pay. The
-- actions refuse the obvious cases; this makes it the database's rule for
-- EVERY writer, and serializes it: the trigger locks the campaign_settings
-- row before looking, so two retirements of different options cannot both
-- see the other as active and commit a campaign with none.
CREATE OR REPLACE FUNCTION storefront.assert_published_has_active_option() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  gb BIGINT := COALESCE(NEW.group_buy_id, OLD.group_buy_id);
  pub BOOLEAN;
BEGIN
  SELECT cs.published INTO pub FROM storefront.campaign_settings cs WHERE cs.group_buy_id = gb FOR UPDATE;
  IF COALESCE(pub, false)
     AND NOT EXISTS (SELECT 1 FROM storefront.campaign_payment_options o WHERE o.group_buy_id = gb AND o.active) THEN
    RAISE EXCEPTION 'campaign % is published and would be left with no active payment option', gb
      USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_published_needs_active_option';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS published_needs_active_option ON storefront.campaign_payment_options;
CREATE CONSTRAINT TRIGGER published_needs_active_option
  AFTER INSERT OR UPDATE OF active, group_buy_id OR DELETE ON storefront.campaign_payment_options
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION storefront.assert_published_has_active_option();

DROP TRIGGER IF EXISTS published_needs_active_option ON storefront.campaign_settings;
CREATE CONSTRAINT TRIGGER published_needs_active_option
  AFTER INSERT OR UPDATE OF published ON storefront.campaign_settings
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION storefront.assert_published_has_active_option();
