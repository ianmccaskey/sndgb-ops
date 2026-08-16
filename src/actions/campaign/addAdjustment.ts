import { action } from '@uibakery/data';

/**
 * Audited manual demand adjustment. qty is NUMERIC(10,2) — split-kit
 * corrections can be fractional (+/-0.5) — and the same write-boundary rule
 * as upsertOrderItem applies: at most two decimals, non-zero, refused
 * (no rows) rather than silently rounded by Postgres.
 *
 * beneficiary says whose units these are: 'both' (value comes out of total
 * profit before the split) or a profit_splits.party name (value comes out of
 * that person's payout). Validated against profit_splits here — party names
 * are data, not an enum.
 *
 * pricing 'cost' = an AT-COST sale to a customer outside the group buy:
 * kits join vendor demand but P&L waives their margin (net zero — the
 * customer pays vendor cost + per-kit freight, snapshotted as expected_usd,
 * the receivable). Guards for cost rows: qty POSITIVE (you can't un-sell at
 * cost), product NOT tiered (incremental vendor cost of a tiered line is
 * not qty × unit_cost, so exact P&L neutrality can't be guaranteed);
 * beneficiary is stored 'both' but excluded from all payout math by
 * pricing filters.
 */
function addAdjustment() {
  return action('addAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by, beneficiary, pricing, expected_usd)
      SELECT
        gbp.id,
        ({{params.qty}})::numeric,
        {{params.reason}},
        {{params.created_by}},
        CASE WHEN COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') = 'cost' THEN 'both' ELSE {{params.beneficiary}} END,
        COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb'),
        CASE WHEN COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') = 'cost'
             THEN ROUND(({{params.qty}})::numeric * (gbp.unit_cost_usd + gbp.freight_usd), 2)
             ELSE NULL END
      FROM group_buy_products gbp
      WHERE gbp.id = {{params.group_buy_product_id}}::bigint
        AND ({{params.qty}})::text ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
        AND ({{params.qty}})::numeric <> 0
        AND COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') IN ('gb', 'cost')
        AND (COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') = 'gb'
             -- at-cost rows: positive WHOLE kits on a flat-cost product only.
             -- Whole because a fractional at-cost qty would break neutrality:
             -- vendor cost/freight follow CEIL(final_count) while the waiver
             -- and receivable would use the raw fraction
             OR (({{params.qty}})::numeric > 0
                 AND ({{params.qty}})::numeric % 1 = 0
                 AND gbp.cost_tier_qty IS NULL))
        AND (COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') = 'cost'
             OR {{params.beneficiary}} = 'both'
             -- party must have a split in THE GROUP BUY BEING ADJUSTED —
             -- a party from another campaign would be aggregated by getPnl
             -- but deducted from no one's payout (phantom profit returns)
             OR EXISTS (
               SELECT 1
               FROM profit_splits ps
               WHERE ps.group_buy_id = gbp.group_buy_id
                 AND ps.party = {{params.beneficiary}}
             ))
      RETURNING id
    `,
  });
}

export default addAdjustment;
