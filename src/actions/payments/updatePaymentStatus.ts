import { action } from '@uibakery/data';

function updatePaymentStatus() {
  return action('updatePaymentStatus', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE payments SET
          status = {{params.status}}::payment_status,
          amount_usd = {{params.amount_usd}}::numeric,
          verify_source = 'manual',
          verified_at = CASE WHEN {{params.status}} = 'verified' THEN now() ELSE verified_at END,
          notes = NULLIF({{params.notes}}::text, '')
        WHERE id = {{params.payment_id}}::bigint
        RETURNING id, order_id, amount_usd, status
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'payments', upd.id::text, 'manual_status_change', {{params.actor}},
             jsonb_build_object('order_id', upd.order_id, 'amount_usd', upd.amount_usd, 'status', upd.status)
      FROM upd
      RETURNING row_pk AS id
    `,
  });
}

export default updatePaymentStatus;
