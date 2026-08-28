import { action } from '@uibakery/data';

/**
 * Commit a planned allocation: record the REAL vendor payment and stamp the
 * plan line ORDERED in ONE transaction — the plan can never say "ordered"
 * without the payment existing, and a double-click / concurrent operator /
 * retry can never insert a second payment (the item row is locked FOR
 * UPDATE and re-checked unordered BEFORE anything is inserted).
 *
 * The amount is computed SERVER-SIDE from the plan line's kits x the
 * product's live (unit_cost + freight) — never client-supplied. Kit-cap
 * semantics mirror addVendorPayment exactly: paying for more kits than the
 * product is still owed refuses unless the operator confirmed the over-buy,
 * ANCHORED to the owed figure they confirmed against (a concurrent recorder
 * shrinking owed invalidates a stale confirmation). Takes the same 42002
 * vendor+campaign advisory lock as addVendorPayment so cap reads serialize
 * with every other payment writer. Freight rides inside the line amount by
 * design: floats are outside demand, and the vendor freight ledger is
 * demand-capped. Both the payment and the stamp are audited, cross-linked.
 */
function orderStockPlanItem() {
  return action('orderStockPlanItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH itm AS (
        -- row-lock the plan line FIRST: a concurrent commit of the same
        -- line blocks here and then sees ordered_at set (zero rows)
        SELECT i.id, i.kits, i.group_buy_product_id, gbp.vendor_id, gbp.group_buy_id,
               ROUND(i.kits * (gbp.unit_cost_usd + gbp.freight_usd), 2) AS amount_usd,
               p.sku_code
        FROM stock_plan_items i
        JOIN stock_plans sp ON sp.id = i.plan_id AND sp.group_buy_id = {{params.group_buy_id}}::bigint
        -- commit-time eligibility RE-CHECK: the product must STILL be active
        -- and flat-cost — a tier conversion or cancellation between planning
        -- and commit must refuse, not price a real payment off a stale formula
        JOIN group_buy_products gbp ON gbp.id = i.group_buy_product_id
          AND gbp.status = 'active'
          AND gbp.cost_tier_qty IS NULL
        JOIN products p ON p.id = gbp.product_id
        WHERE i.id = {{params.item_id}}::bigint
          AND i.ordered_at IS NULL
        -- lock the PRODUCT row too: the payment amount is priced from
        -- gbp.unit_cost/freight, so a concurrent campaign-product edit
        -- must serialize with this commit — never a stale price
        FOR UPDATE OF i, gbp
      ), lck AS (
        SELECT pg_advisory_xact_lock(42002, hashtext(itm.vendor_id::text || ':' || itm.group_buy_id::text)) AS locked
        FROM itm
      ), cur AS (
        -- kits still owed, read AFTER the advisory lock (same as addVendorPayment)
        SELECT itm.id AS item_id,
               m.ordered_kits - COALESCE((
                 SELECT SUM(COALESCE(vp2.kits_qty, 0))
                 FROM vendor_payments vp2
                 WHERE vp2.group_buy_product_id = itm.group_buy_product_id
               ), 0) AS kits_remaining
        FROM lck, itm
        JOIN v_moq_progress m ON m.group_buy_product_id = itm.group_buy_product_id
      ), pay AS (
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, stock_plan_item_id)
        SELECT itm.vendor_id, itm.group_buy_id, {{params.paid_on}}::date, itm.amount_usd,
               NULLIF({{params.wallet_id}}::text, '')::bigint,
               NULLIF({{params.method}}::text, ''),
               NULLIF({{params.receipt_ref}}::text, ''),
               'stock plan: ' || itm.sku_code || ' x ' || itm.kits::text || ' personal stock (cost+freight)',
               itm.kits, NULL, itm.group_buy_product_id,
               -- the payment<->plan link is DATA (unique per line):
               -- deleteVendorPayment un-stamps the line atomically on removal
               itm.id
        FROM itm
        JOIN cur ON cur.item_id = itm.id
        WHERE (
          ({{params.allow_over}}::text = 'true'
           AND NULLIF({{params.confirmed_owed}}::text, '') IS NOT NULL
           AND cur.kits_remaining >= NULLIF({{params.confirmed_owed}}::text, '')::numeric)
          OR itm.kits <= cur.kits_remaining
        )
        -- the funding wallet is REQUIRED and must be a real, ACTIVE wallet —
        -- payment provenance feeds rail reconciliation, so a stale or
        -- tampered wallet id refuses instead of mis-attributing real money
        AND EXISTS (
          SELECT 1 FROM wallets w
          WHERE w.id = NULLIF({{params.wallet_id}}::text, '')::bigint
            AND w.active
        )
        RETURNING id, vendor_id, amount_usd, kits_qty, group_buy_product_id
      ), stamp AS (
        UPDATE stock_plan_items i
        SET ordered_at = now(), ordered_by = {{params.actor}}::text, ordered_value_usd = pay.amount_usd
        FROM pay, itm
        WHERE i.id = itm.id
        RETURNING i.id, i.ordered_value_usd
      ), pay_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', pay.id::text, 'insert', {{params.actor}},
               jsonb_build_object('vendor_id', pay.vendor_id, 'amount_usd', pay.amount_usd,
                                  'kits_qty', pay.kits_qty, 'freight_usd', NULL,
                                  'group_buy_product_id', pay.group_buy_product_id,
                                  'over_owed_override', {{params.allow_over}}::text = 'true',
                                  'confirmed_owed', NULLIF({{params.confirmed_owed}}::text, '')::numeric,
                                  'owed_at_insert', (SELECT kits_remaining FROM cur),
                                  'stock_plan_item_id', (SELECT id FROM itm))
        FROM pay
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'stock_plan_items', stamp.id::text, 'stock_plan_item_ordered', {{params.actor}},
             jsonb_build_object('vendor_payment_id', (SELECT id FROM pay),
                                'ordered_value_usd', stamp.ordered_value_usd)
      FROM stamp
      RETURNING row_pk AS id
    `,
  });
}

export default orderStockPlanItem;
