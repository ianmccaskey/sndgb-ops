import { action } from '@uibakery/data';

/**
 * Edit an order's admin / shipping / insurance / tip fees as OVERRIDES.
 * Blank clears an override (back to the ordering app's value); a value wins
 * over whatever imports say, forever — pulls refresh the base columns and
 * never touch these. Reconciliation bills the per-fee delta, so an edit
 * shifts what the customer owes by exactly the difference.
 *
 * All four params are validated string-style (2 decimals max, >= 0) like
 * every quantity boundary; any invalid value refuses the whole edit (zero
 * rows) — fees are money, partial application would be silent corruption.
 * NULLIF-before-cast is load-bearing on every param (plan-time '' casts).
 *
 * Takes the 42001 per-order lock (fee deltas feed due, so this serializes
 * with write-off caps) and auto-clears a standing write-off when the
 * effective fee total actually changes, audited.
 */
function setOrderFees() {
  return action('setOrderFees', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), prev AS (
        SELECT o.id,
               COALESCE(o.admin_fee_override_usd, o.admin_fee_usd)
             + COALESCE(o.shipping_fee_override_usd, o.shipping_fee_usd)
             + COALESCE(o.shipping_insurance_override_usd, o.shipping_insurance_usd)
             + COALESCE(o.tip_override_usd, o.tip_usd) AS eff_fees
        FROM lck, orders o
        WHERE o.id = {{params.order_id}}::bigint
      ), upd AS (
        UPDATE orders o SET
          admin_fee_override_usd = NULLIF({{params.admin_fee}}::text, '')::numeric,
          shipping_fee_override_usd = NULLIF({{params.shipping_fee}}::text, '')::numeric,
          shipping_insurance_override_usd = NULLIF({{params.insurance}}::text, '')::numeric,
          tip_override_usd = NULLIF({{params.tip}}::text, '')::numeric
        FROM lck
        WHERE o.id = {{params.order_id}}::bigint
          -- recon hides cancelled/refunded orders — a fee edit there would
          -- be dormant billing, same rule as local items
          AND o.status NOT IN ('cancelled', 'refunded')
          AND ({{params.admin_fee}}::text = '' OR {{params.admin_fee}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$')
          AND ({{params.shipping_fee}}::text = '' OR {{params.shipping_fee}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$')
          AND ({{params.insurance}}::text = '' OR {{params.insurance}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$')
          AND ({{params.tip}}::text = '' OR {{params.tip}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$')
        RETURNING o.id,
               COALESCE(o.admin_fee_override_usd, o.admin_fee_usd)
             + COALESCE(o.shipping_fee_override_usd, o.shipping_fee_usd)
             + COALESCE(o.shipping_insurance_override_usd, o.shipping_insurance_usd)
             + COALESCE(o.tip_override_usd, o.tip_usd) AS eff_fees,
               o.admin_fee_override_usd, o.shipping_fee_override_usd,
               o.shipping_insurance_override_usd, o.tip_override_usd
      ), wo_clear AS (
        -- the effective fee total moved → due moved → a standing write-off
        -- was computed against stale reality: auto-clear, audited
        DELETE FROM order_writeoffs w
        USING upd, prev
        WHERE w.order_id = {{params.order_id}}::bigint
          AND prev.id = upd.id
          AND prev.eff_fees IS DISTINCT FROM upd.eff_fees
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'fee_edit')
        FROM wo_clear
        RETURNING row_pk
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'orders', upd.id::text, 'order_fees_set', {{params.actor}},
               jsonb_build_object('admin_fee_override', upd.admin_fee_override_usd,
                                  'shipping_fee_override', upd.shipping_fee_override_usd,
                                  'insurance_override', upd.shipping_insurance_override_usd,
                                  'tip_override', upd.tip_override_usd,
                                  'old_effective_fees', (SELECT eff_fees FROM prev),
                                  'new_effective_fees', upd.eff_fees)
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default setOrderFees;
