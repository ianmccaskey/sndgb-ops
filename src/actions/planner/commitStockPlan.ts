import { action } from '@uibakery/data';

/**
 * Commit the ENTIRE stock plan at once: every not-yet-committed allocation
 * line becomes an admin adjustment at vendor cost + freight, assigned to
 * 'both' and linked back to its plan line — the kits join vendor demand
 * (what we order from the vendor) and the snapshotted cost+freight pulls
 * from NET PROFIT PRE-SPLIT via v_group_buy_pnl's stock waiver (the full
 * retail value of the kits is waived; their booked cost side remains).
 * No receivable: nobody pays the group back for its own stock.
 *
 * The commit is ANCHORED TO WHAT THE OPERATOR CONFIRMED (same philosophy
 * as the over-buy anchor): confirmed_items carries the exact 'id:kits'
 * list shown in the confirm dialog, and the server enforces FULL-SET
 * EQUALITY against the plan's current uncommitted lines — it commits
 * exactly that set, or NOTHING. Any drift between the dialog and the
 * click blocks the whole batch (zero rows): a confirmed line deleted,
 * re-quantified, already committed, or gone inactive/tiered no longer
 * matches the confirmation, and an uncommitted line NOT in the
 * confirmation (added by the co-admin, or omitted by a stale/forged
 * caller) means the confirmation does not cover the ENTIRE plan — the
 * operator re-confirms against fresh data either way. Confirmed lines
 * and their product rows are locked FOR UPDATE (a racing second click,
 * or a concurrent tier conversion which locks the same gbp row in
 * upsertCampaignProduct, serializes; re-quantify's DO UPDATE waits on
 * the item lock and then refuses linked lines). The partial unique index
 * on stock_plan_item_id makes double-commit unrepresentable outright.
 *
 * Deliberately NO positive-demand guard (unlike addAdjustment's at-cost
 * sales, which piggyback on group demand): a stock commit IS the demand —
 * planning kits of a product nobody ordered is the point of the planner.
 * Whole positive kits are already guaranteed by stock_plan_items' CHECK.
 * Already-ORDERED lines commit too when unlinked: their over-buy payment
 * exists, and the adjustment makes demand and paid line up.
 *
 * FIRST-DEMAND products cost more than the snapshot, ON PURPOSE: when a
 * stock commit is what flips a product's final_count above zero, the
 * product's one-time testing_cost_usd starts being charged in
 * v_product_profit — real money the group pays BECAUSE of this decision,
 * so it hits net profit rather than being waived (hiding it would
 * overstate profit by real dollars). The Planner's confirm dialog flags
 * such lines before committing. Products that already have group demand
 * deduct exactly the snapshotted cost + freight.
 */
function commitStockPlan() {
  return action('commitStockPlan', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH confirmed AS (
        -- the exact lines the operator saw and confirmed: 'id:kits,id:kits'
        SELECT split_part(x, ':', 1)::bigint AS item_id,
               split_part(x, ':', 2)::numeric AS kits
        FROM unnest(string_to_array(NULLIF({{params.confirmed_items}}::text, ''), ',')) AS x
      ), pending AS (
        SELECT i.id AS item_id, i.kits, gbp.id AS gbp_id, gbp.status, gbp.cost_tier_qty,
               gbp.unit_cost_usd, gbp.freight_usd, p.sku_code
        FROM stock_plan_items i
        JOIN stock_plans sp ON sp.id = i.plan_id
          AND sp.group_buy_id = {{params.group_buy_id}}::bigint
        JOIN group_buy_products gbp ON gbp.id = i.group_buy_product_id
        JOIN products p ON p.id = gbp.product_id
        WHERE i.id IN (SELECT item_id FROM confirmed)
          AND NOT EXISTS (SELECT 1 FROM admin_adjustments a WHERE a.stock_plan_item_id = i.id)
        FOR UPDATE OF i, gbp
      ), drift AS (
        -- ANY confirmed line that is gone, already committed, re-quantified,
        -- or no longer an active flat-cost product blocks the whole batch:
        -- the confirmation no longer describes the plan
        SELECT 1
        FROM confirmed c
        LEFT JOIN pending p ON p.item_id = c.item_id
        WHERE p.item_id IS NULL
           OR p.kits <> c.kits
           OR p.status <> 'active'
           OR p.cost_tier_qty IS NOT NULL
        UNION ALL
        -- FULL-SET EQUALITY: an uncommitted plan line NOT in the confirmed
        -- set (added concurrently, or omitted by a stale/forged caller)
        -- also blocks — "commit the ENTIRE plan" is enforced server-side,
        -- never assumed from the client
        SELECT 1
        FROM stock_plan_items i
        JOIN stock_plans sp2 ON sp2.id = i.plan_id
          AND sp2.group_buy_id = {{params.group_buy_id}}::bigint
        WHERE i.id NOT IN (SELECT item_id FROM confirmed)
          AND NOT EXISTS (SELECT 1 FROM admin_adjustments a WHERE a.stock_plan_item_id = i.id)
      ), ins AS (
        INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by, beneficiary, pricing, expected_usd, preordered, stock_plan_item_id)
        SELECT pending.gbp_id, pending.kits,
               'Stock plan commit: ' || pending.sku_code || ' x ' || pending.kits::text,
               {{params.actor}}, 'both', 'cost',
               ROUND(pending.kits * (pending.unit_cost_usd + pending.freight_usd), 2),
               false, pending.item_id
        FROM pending
        WHERE NOT EXISTS (SELECT 1 FROM drift)
        RETURNING id, group_buy_product_id, qty, expected_usd, stock_plan_item_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'admin_adjustments', ins.id::text, 'stock_plan_committed', {{params.actor}},
             jsonb_build_object('group_buy_product_id', ins.group_buy_product_id, 'qty', ins.qty,
                                'expected_usd', ins.expected_usd, 'stock_plan_item_id', ins.stock_plan_item_id)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default commitStockPlan;
