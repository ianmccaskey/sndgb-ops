import { action } from '@uibakery/data';

/**
 * A PRE-ORDERED at-cost sale fell through (customer bailed) but the kits
 * were already bought and paid for from the wallet: reallocate them to the
 * GROUP BUY — in ONE transaction, delete the adjustment (the receivable
 * expectation) and record the kit-attributed vendor payment so those kits
 * count against what the campaign still needs to buy from the vendor.
 *
 * The payment amount is the adjustment's snapshotted expected_usd — exactly
 * the cost+freight the wallet put out for those kits. Same money-write
 * discipline as orderStockPlanItem: the adjustment row is locked FOR UPDATE
 * and re-validated BEFORE anything is inserted (a double-click or concurrent
 * operator inserts zero payments); the 42002 vendor+campaign advisory lock
 * serializes the kit-cap read with every other payment writer; paying for
 * more kits than still owed needs the operator-confirmed over-buy anchor;
 * the funding wallet must exist and be active. Only UNRECEIVED preordered
 * OUTSIDE-CUSTOMER rows qualify — a received sale has the customer's money
 * and is locked, and PERSONAL stock rows (party beneficiary) have no
 * receivable to fall through: they settle against the party's payout, so
 * reallocating one here would silently erase that deduction while mutating
 * the campaign's vendor-paid ledger. Personal rows are refused (zero rows);
 * the recovery path for a personal row is explicit delete.
 */
function reallocateAtCostAdjustment() {
  return action('reallocateAtCostAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH adj AS (
        SELECT a.id, a.qty, a.expected_usd, a.reason, a.group_buy_product_id,
               gbp.vendor_id, gbp.group_buy_id, p.sku_code
        FROM admin_adjustments a
        JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
        JOIN products p ON p.id = gbp.product_id
        WHERE a.id = {{params.adjustment_id}}::bigint
          AND a.pricing = 'cost'
          -- personal stock (party beneficiary) settles against the party's
          -- payout and group stock against net profit — neither has a
          -- receivable to reallocate (stock rows are never preordered, so
          -- the belt below is unreachable today, but the semantics hold)
          AND a.beneficiary = 'both'
          AND NOT a.stock
          AND a.preordered
          AND a.received_at IS NULL
        FOR UPDATE OF a
      ), lck AS (
        SELECT pg_advisory_xact_lock(42002, hashtext(adj.vendor_id::text || ':' || adj.group_buy_id::text)) AS locked
        FROM adj
      ), cur AS (
        SELECT adj.id AS adj_id,
               m.ordered_kits - COALESCE((
                 SELECT SUM(COALESCE(vp2.kits_qty, 0))
                 FROM vendor_payments vp2
                 WHERE vp2.group_buy_product_id = adj.group_buy_product_id
               ), 0) AS kits_remaining
        FROM lck, adj
        JOIN v_moq_progress m ON m.group_buy_product_id = adj.group_buy_product_id
      ), pay AS (
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id)
        SELECT adj.vendor_id, adj.group_buy_id, {{params.paid_on}}::date, adj.expected_usd,
               NULLIF({{params.wallet_id}}::text, '')::bigint,
               NULLIF({{params.method}}::text, ''),
               NULLIF({{params.receipt_ref}}::text, ''),
               'reallocated to GB from fell-through at-cost sale: ' || adj.sku_code || ' x ' || adj.qty::text || ' (' || adj.reason || ')',
               adj.qty, NULL, adj.group_buy_product_id
        FROM adj
        JOIN cur ON cur.adj_id = adj.id
        WHERE (
          ({{params.allow_over}}::text = 'true'
           AND NULLIF({{params.confirmed_owed}}::text, '') IS NOT NULL
           AND cur.kits_remaining >= NULLIF({{params.confirmed_owed}}::text, '')::numeric)
          OR adj.qty <= cur.kits_remaining
        )
        AND EXISTS (
          SELECT 1 FROM wallets w
          WHERE w.id = NULLIF({{params.wallet_id}}::text, '')::bigint
            AND w.active
        )
        RETURNING id, vendor_id, amount_usd, kits_qty, group_buy_product_id
      ), del AS (
        -- the receivable expectation leaves ONLY together with the payment
        DELETE FROM admin_adjustments a
        USING adj, pay
        WHERE a.id = adj.id
        RETURNING a.id, a.qty, a.expected_usd, a.reason
      ), pay_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', pay.id::text, 'insert', {{params.actor}}::text,
               jsonb_build_object('vendor_id', pay.vendor_id, 'amount_usd', pay.amount_usd,
                                  'kits_qty', pay.kits_qty, 'freight_usd', NULL,
                                  'group_buy_product_id', pay.group_buy_product_id,
                                  'over_owed_override', {{params.allow_over}}::text = 'true',
                                  'confirmed_owed', NULLIF({{params.confirmed_owed}}::text, '')::numeric,
                                  'owed_at_insert', (SELECT kits_remaining FROM cur),
                                  'reallocated_from_adjustment_id', (SELECT id FROM adj))
        FROM pay
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'admin_adjustments', del.id::text, 'at_cost_reallocated_to_gb', {{params.actor}}::text,
             jsonb_build_object('qty', del.qty, 'expected_usd', del.expected_usd, 'reason', del.reason,
                                'vendor_payment_id', (SELECT id FROM pay))
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default reallocateAtCostAdjustment;
