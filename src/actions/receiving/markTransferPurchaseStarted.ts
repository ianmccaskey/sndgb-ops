import { action } from '@uibakery/data';

/**
 * Re-claim the PURCHASE LEASE on a draft right before a retry-purchase
 * POSTs to Shippo. Two jobs: (1) deleteTransferDraft refuses while the
 * lease is fresh, so a concurrent admin cannot delete the draft in the
 * window where a label purchase may be in flight; (2) ZERO ROWS back
 * means the draft no longer exists (deleted or finalized in another
 * session) — the caller must ABORT before any money moves. Audited.
 */
function markTransferPurchaseStarted() {
  return action('markTransferPurchaseStarted', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET purchase_started_at = now()
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
        RETURNING t.id, t.shippo_rate_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_purchase_claimed', {{params.actor}},
             jsonb_build_object('shippo_rate_id', up.shippo_rate_id)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default markTransferPurchaseStarted;
