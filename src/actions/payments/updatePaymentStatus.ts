import { action } from '@uibakery/data';

/**
 * Manual status change with an optimistic-concurrency guard: when
 * expected_status is provided, the write only lands if the row still has
 * that status — a stale UI action (e.g. rejecting a payment the verifier
 * just marked verified) returns zero rows instead of clobbering it.
 */
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
          AND (COALESCE({{params.expected_status}}, '') = '' OR status = {{params.expected_status}}::payment_status)
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
