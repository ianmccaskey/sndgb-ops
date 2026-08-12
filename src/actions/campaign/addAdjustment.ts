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
 */
function addAdjustment() {
  return action('addAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by, beneficiary)
      SELECT
        {{params.group_buy_product_id}}::bigint,
        ({{params.qty}})::numeric,
        {{params.reason}},
        {{params.created_by}},
        {{params.beneficiary}}
      WHERE ({{params.qty}})::text ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
        AND ({{params.qty}})::numeric <> 0
        AND ({{params.beneficiary}} = 'both'
             -- party must have a split in THE GROUP BUY BEING ADJUSTED —
             -- a party from another campaign would be aggregated by getPnl
             -- but deducted from no one's payout (phantom profit returns)
             OR EXISTS (
               SELECT 1
               FROM group_buy_products gbp
               JOIN profit_splits ps ON ps.group_buy_id = gbp.group_buy_id
               WHERE gbp.id = {{params.group_buy_product_id}}::bigint
                 AND ps.party = {{params.beneficiary}}
             ))
      RETURNING id
    `,
  });
}

export default addAdjustment;
