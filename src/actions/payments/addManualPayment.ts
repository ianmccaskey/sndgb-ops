import { action } from '@uibakery/data';

function addManualPayment() {
  return action('addManualPayment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO payments (order_id, method, tx_hash, receipt_ref, amount_usd, status, verify_source, verified_at, notes)
        VALUES (
          {{params.order_id}}::bigint,
          {{params.method}}::payment_method,
          NULLIF({{params.tx_hash}}::text, ''),
          NULLIF({{params.receipt_ref}}::text, ''),
          {{params.amount_usd}}::numeric,
          'verified',
          'manual',
          now(),
          NULLIF({{params.notes}}::text, '')
        )
        RETURNING id, order_id, amount_usd, method
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'payments', ins.id::text, 'manual_payment', {{params.actor}},
             jsonb_build_object('order_id', ins.order_id, 'amount_usd', ins.amount_usd, 'method', ins.method)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addManualPayment;
