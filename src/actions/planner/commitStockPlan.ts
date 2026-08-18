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
 * The whole commit lives in the commit_stock_plan() DATABASE FUNCTION
 * (migration 1786470600) so the campaign's stock_plans row is locked
 * FOR UPDATE in its OWN statement BEFORE the validation reads — each
 * statement in a VOLATILE function takes a fresh snapshot under READ
 * COMMITTED, so once the lock is granted the validation necessarily
 * sees every line whose inserting transaction committed first.
 * upsertStockPlanItem takes the same header row lock on every call
 * (INSERT ... ON CONFLICT DO UPDATE), so a concurrent line insert
 * either commits first and is SEEN (the stale confirmation refuses) or
 * waits behind the commit and lands strictly after it, visibly
 * uncommitted. No snapshot window remains.
 *
 * The commit is ANCHORED TO WHAT THE OPERATOR CONFIRMED (same philosophy
 * as the over-buy anchor): confirmed_items carries the exact 'id:kits'
 * list shown in the confirm dialog, and the function enforces FULL-SET
 * EQUALITY against the plan's current uncommitted lines — it commits
 * exactly that set, or NOTHING (zero rows). Any drift blocks the whole
 * batch: a confirmed line deleted, re-quantified, already committed, or
 * gone inactive/tiered no longer matches the confirmation, and an
 * uncommitted line NOT in the confirmation (added by the co-admin, or
 * omitted by a stale/forged caller) means the confirmation does not
 * cover the ENTIRE plan. Confirmed lines and their product rows are
 * locked FOR UPDATE inside the function (a racing second click, or a
 * concurrent tier conversion which locks the same gbp row in
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
      SELECT id
      FROM commit_stock_plan(
        {{params.group_buy_id}}::bigint,
        {{params.actor}},
        NULLIF({{params.confirmed_items}}::text, '')
      )
    `,
  });
}

export default commitStockPlan;
