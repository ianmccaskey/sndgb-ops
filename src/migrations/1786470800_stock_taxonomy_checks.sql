-- The stock flag is P&L-classifying, so the taxonomy is enforced AT THE
-- DATABASE, not just in the actions: stock=true is only meaningful as an
-- at-cost, non-preordered row assigned to 'both' (group stock), and a
-- planner-linked row must always be stock (a linked row classified as a
-- customer receivable would suppress the net-profit deduction).
ALTER TABLE admin_adjustments ADD CONSTRAINT admin_adjustments_stock_taxonomy
  CHECK (NOT stock OR (pricing = 'cost' AND beneficiary = 'both' AND NOT preordered));
ALTER TABLE admin_adjustments ADD CONSTRAINT admin_adjustments_plan_link_is_stock
  CHECK (stock_plan_item_id IS NULL OR stock);
