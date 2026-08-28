import { action } from '@uibakery/data';

/**
 * Mark an at-cost adjustment's customer payment as received. Informational
 * only — no P&L or recon impact (the sale is already margin-neutral); this
 * just closes the receivable so the Products page stops showing it as
 * awaiting. One-way: the recovery path for a mistaken click is
 * deleteAdjustment + re-add. Zero rows = refused (not an at-cost row, or
 * already received).
 */
function markAdjustmentReceived() {
  return action('markAdjustmentReceived', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE admin_adjustments a
        SET received_at = now(), received_by = {{params.actor}}::text
        FROM group_buy_products gbp
        WHERE a.id = {{params.adjustment_id}}::bigint
          AND gbp.id = a.group_buy_product_id
          -- CAMPAIGN-SCOPED like every adjustment mutation: a stale or
          -- forged id must not close another campaign's receivable
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
          AND a.pricing = 'cost'
          -- personal at-cost stock has no receivable to receive, and
          -- group stock settles out of net profit — nothing arrives
          AND a.beneficiary = 'both'
          AND NOT a.stock
          AND a.received_at IS NULL
        RETURNING a.id, a.expected_usd, a.reason
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'admin_adjustments', upd.id::text, 'at_cost_payment_received', {{params.actor}}::text,
             jsonb_build_object('expected_usd', upd.expected_usd, 'reason', upd.reason)
      FROM upd
      RETURNING row_pk AS id
    `,
  });
}

export default markAdjustmentReceived;
