import { action } from '@uibakery/data';

/**
 * Record the purchased label onto its draft — the transfer becomes real
 * (inventory decrements from here). Retryable: a purchase-succeeded-but-
 * finalize-failed draft can call this again with the same transaction
 * data; the finalized guard makes a double-fire refuse harmlessly. Audited.
 */
function finalizeTransfer() {
  return action('finalizeTransfer', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET shippo_transaction_id = {{params.transaction_id}},
            tracking_number = NULLIF({{params.tracking_number}}::text, ''),
            label_url = {{params.label_url}},
            finalized_at = now()
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
          AND TRIM({{params.transaction_id}}) <> ''
          AND TRIM({{params.label_url}}) <> ''
        RETURNING t.id, t.shippo_transaction_id, t.tracking_number, t.label_url, t.rate_amount
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_finalized', {{params.actor}},
             jsonb_build_object('shippo_transaction_id', up.shippo_transaction_id,
                                'tracking_number', up.tracking_number, 'label_url', up.label_url,
                                'rate_amount', up.rate_amount)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default finalizeTransfer;
