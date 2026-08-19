import { action } from '@uibakery/data';

/**
 * Record a refund request's status on a FINALIZED transfer. The refund
 * itself was requested at Shippo by the client; USPS refunds settle over
 * days, so this is a status marker ("check the Shippo dashboard"), not a
 * settlement record. Audited.
 */
function setTransferRefund() {
  return action('setTransferRefund', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET refund_status = {{params.refund_status}}
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NOT NULL
        RETURNING t.id, t.refund_status, t.shippo_transaction_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_refund_status_set', {{params.actor}},
             jsonb_build_object('refund_status', up.refund_status, 'shippo_transaction_id', up.shippo_transaction_id)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default setTransferRefund;
