-- commit_stock_plan(): the stock-plan commit as a VOLATILE PL/pgSQL
-- function so the plan-header lock is acquired in its OWN statement
-- BEFORE the full-set validation reads. Under READ COMMITTED, each
-- statement inside a VOLATILE function takes a FRESH snapshot — so once
-- the FOR UPDATE on stock_plans is granted, the validation query
-- necessarily sees every line whose inserting transaction committed
-- before the lock was granted (lock conflict guarantees that
-- transaction had ended). This closes the single-statement snapshot
-- window entirely: a concurrent upsertStockPlanItem (which takes the
-- same header row lock via INSERT ... ON CONFLICT DO UPDATE) either
-- commits first and is SEEN (full-set drift refuses the stale
-- confirmation) or waits behind this lock and lands strictly after,
-- visibly uncommitted.
--
-- Semantics are identical to the previous inline statement: commit
-- EXACTLY the operator-confirmed 'id:kits' set — which must equal the
-- plan's entire uncommitted line set — or NOTHING (zero rows returned).
CREATE OR REPLACE FUNCTION commit_stock_plan(
  p_group_buy_id bigint,
  p_actor text,
  p_confirmed text
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_plan_id bigint;
BEGIN
  IF p_confirmed IS NULL OR p_confirmed = '' THEN
    RETURN;
  END IF;

  -- statement 1: LOCK FIRST. Everything below runs on fresh snapshots.
  SELECT sp.id INTO v_plan_id
  FROM stock_plans sp
  WHERE sp.group_buy_id = p_group_buy_id
  FOR UPDATE;

  IF v_plan_id IS NULL THEN
    RETURN;
  END IF;

  -- statement 2: validate + insert, now serialized behind the header lock
  RETURN QUERY
  WITH confirmed AS (
    SELECT split_part(x, ':', 1)::bigint AS item_id,
           split_part(x, ':', 2)::numeric AS kits
    FROM unnest(string_to_array(p_confirmed, ',')) AS x
  ), pending AS (
    SELECT i.id AS item_id, i.kits, gbp.id AS gbp_id, gbp.status, gbp.cost_tier_qty,
           gbp.unit_cost_usd, gbp.freight_usd, p.sku_code
    FROM stock_plan_items i
    JOIN group_buy_products gbp ON gbp.id = i.group_buy_product_id
    JOIN products p ON p.id = gbp.product_id
    WHERE i.plan_id = v_plan_id
      AND i.id IN (SELECT c.item_id FROM confirmed c)
      AND NOT EXISTS (SELECT 1 FROM admin_adjustments a WHERE a.stock_plan_item_id = i.id)
    FOR UPDATE OF i, gbp
  ), drift AS (
    -- any confirmed line gone / re-quantified / already committed /
    -- inactive / tiered blocks the whole batch
    SELECT 1 AS hit
    FROM confirmed c
    LEFT JOIN pending pd ON pd.item_id = c.item_id
    WHERE pd.item_id IS NULL
       OR pd.kits <> c.kits
       OR pd.status <> 'active'
       OR pd.cost_tier_qty IS NOT NULL
    UNION ALL
    -- FULL-SET EQUALITY: any uncommitted plan line NOT in the confirmed
    -- set blocks too — "the ENTIRE plan" is enforced here, post-lock
    SELECT 1
    FROM stock_plan_items i
    WHERE i.plan_id = v_plan_id
      AND i.id NOT IN (SELECT c.item_id FROM confirmed c)
      AND NOT EXISTS (SELECT 1 FROM admin_adjustments a WHERE a.stock_plan_item_id = i.id)
  ), ins AS (
    INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by, beneficiary, pricing, expected_usd, preordered, stock_plan_item_id)
    SELECT pd.gbp_id, pd.kits,
           'Stock plan commit: ' || pd.sku_code || ' x ' || pd.kits::text,
           p_actor, 'both', 'cost',
           ROUND(pd.kits * (pd.unit_cost_usd + pd.freight_usd), 2),
           false, pd.item_id
    FROM pending pd
    WHERE NOT EXISTS (SELECT 1 FROM drift)
    RETURNING admin_adjustments.id, admin_adjustments.group_buy_product_id,
              admin_adjustments.qty, admin_adjustments.expected_usd,
              admin_adjustments.stock_plan_item_id
  ), audit AS (
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    SELECT 'admin_adjustments', ins.id::text, 'stock_plan_committed', p_actor,
           jsonb_build_object('group_buy_product_id', ins.group_buy_product_id, 'qty', ins.qty,
                              'expected_usd', ins.expected_usd, 'stock_plan_item_id', ins.stock_plan_item_id)
    FROM ins
    RETURNING row_pk
  )
  SELECT ins.id FROM ins;
END $$;
