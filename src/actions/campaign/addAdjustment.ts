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
 * pricing 'cost' = an AT-COST purchase at vendor cost + per-kit freight
 * (snapshotted as expected_usd): kits join vendor demand but P&L waives
 * their margin (net zero). WHO pays is the beneficiary:
 *   - 'both'  = an OUTSIDE CUSTOMER — expected_usd is a receivable
 *     (awaiting / mark-received lifecycle);
 *   - a party = PERSONAL STOCK — expected_usd deducts from that party's
 *     profit payout (no receivable; the wallet outflow is recouped from
 *     their share). Party validated against the campaign's profit splits.
 * Guards for cost rows: qty POSITIVE (you can't un-sell at cost), product
 * NOT tiered (incremental vendor cost of a tiered line is not qty ×
 * unit_cost, so exact P&L neutrality can't be guaranteed).
 *
 * preordered 'true' (cost rows only) = the vendor order was ALREADY placed
 * and paid from the wallet: the kits contribute NOTHING to demand
 * (v_moq_progress excludes them) and NOTHING to P&L (no waiver needed);
 * only the receivable exists. The positive-demand guard doesn't apply —
 * there is no demand or testing-cost effect to protect.
 */
function addAdjustment() {
  return action('addAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by, beneficiary, pricing, expected_usd, preordered)
      SELECT
        gbp.id,
        ({{params.qty}})::numeric,
        {{params.reason}},
        {{params.created_by}},
        {{params.beneficiary}},
        COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb'),
        CASE WHEN COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') = 'cost'
             THEN ROUND(({{params.qty}})::numeric * (gbp.unit_cost_usd + gbp.freight_usd), 2)
             ELSE NULL END,
        COALESCE(NULLIF({{params.preordered}}::text, ''), 'false') = 'true'
      FROM group_buy_products gbp
      WHERE gbp.id = {{params.group_buy_product_id}}::bigint
        AND ({{params.qty}})::text ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
        AND ({{params.qty}})::numeric <> 0
        AND COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') IN ('gb', 'cost')
        -- preordered is an at-cost concept only
        AND (COALESCE(NULLIF({{params.preordered}}::text, ''), 'false') = 'false'
             OR COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') = 'cost')
        AND (COALESCE(NULLIF({{params.pricing}}::text, ''), 'gb') = 'gb'
             -- at-cost rows: positive WHOLE kits on a flat-cost product only.
             -- Whole because a fractional at-cost qty would break neutrality:
             -- vendor cost/freight follow CEIL(final_count) while the waiver
             -- and receivable would use the raw fraction
             OR (({{params.qty}})::numeric > 0
                 AND ({{params.qty}})::numeric % 1 = 0
                 AND gbp.cost_tier_qty IS NULL
                 -- non-preordered rows: the product must ALREADY have positive
                 -- demand — an at-cost row that flips final_count positive
                 -- would drag the flat testing cost into P&L while the waiver
                 -- covers only per-kit margin. PREORDERED rows skip this:
                 -- they touch neither demand nor P&L, only the receivable.
                 AND (COALESCE(NULLIF({{params.preordered}}::text, ''), 'false') = 'true'
                      OR (SELECT m.final_count FROM v_moq_progress m
                          WHERE m.group_buy_product_id = gbp.id) > 0)))
        -- ANY row with a party beneficiary (gb-priced or at-cost personal
        -- stock) must name a split party in THE GROUP BUY BEING ADJUSTED —
        -- otherwise its value would be deducted from no one's payout
        AND ({{params.beneficiary}} = 'both'
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
