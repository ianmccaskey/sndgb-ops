-- stock=true is P&L-classifying, so its PRODUCT-side eligibility is
-- enforced at the database write boundary too (the CHECK constraints in
-- 1786470800 cover the row's own taxonomy; this trigger covers the
-- referenced product): group stock may only be written against an
-- ACTIVE, FLAT-COST product — the same rules the planner re-validates
-- before creating stock rows. Deactivating or tiering a product LATER
-- does not retro-fail existing rows (the trigger fires on adjustment
-- writes only); upsertCampaignProduct already refuses tier conversion
-- while cost rows exist.
CREATE OR REPLACE FUNCTION enforce_stock_adjustment_product()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_tier numeric;
BEGIN
  IF NEW.stock THEN
    SELECT gbp.status::text, gbp.cost_tier_qty INTO v_status, v_tier
    FROM group_buy_products gbp
    WHERE gbp.id = NEW.group_buy_product_id;
    IF v_status IS DISTINCT FROM 'active' OR v_tier IS NOT NULL THEN
      RAISE EXCEPTION 'group stock requires an active flat-cost product (status %, tier qty %)', v_status, v_tier
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_adjustments_stock_product_check
BEFORE INSERT OR UPDATE OF stock, group_buy_product_id ON admin_adjustments
FOR EACH ROW EXECUTE FUNCTION enforce_stock_adjustment_product();
