-- Complete the stock-row contract at the DB boundary: quantities and the
-- snapshot are part of the taxonomy, not just the happy-path action's
-- guards. A stock row must carry POSITIVE WHOLE kits (fractional or
-- negative stock would corrupt v_moq_progress demand and the stock
-- waiver math) and a non-null expected_usd (the net-profit deduction IS
-- that snapshot — a null would silently deduct nothing).
ALTER TABLE admin_adjustments DROP CONSTRAINT admin_adjustments_stock_taxonomy;
ALTER TABLE admin_adjustments ADD CONSTRAINT admin_adjustments_stock_taxonomy
  CHECK (NOT stock OR (pricing = 'cost' AND beneficiary = 'both' AND NOT preordered
                       AND qty > 0 AND qty % 1 = 0 AND expected_usd IS NOT NULL));
