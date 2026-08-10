import { action } from '@uibakery/data';

/**
 * Audited manual demand adjustment. qty is NUMERIC(10,2) — split-kit
 * corrections can be fractional (+/-0.5) — and the same write-boundary rule
 * as upsertOrderItem applies: at most two decimals, non-zero, refused
 * (no rows) rather than silently rounded by Postgres.
 */
function addAdjustment() {
  return action('addAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by)
      SELECT
        {{params.group_buy_product_id}}::bigint,
        ({{params.qty}})::numeric,
        {{params.reason}},
        {{params.created_by}}
      WHERE ({{params.qty}})::text ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
        AND ({{params.qty}})::numeric <> 0
      RETURNING id
    `,
  });
}

export default addAdjustment;
