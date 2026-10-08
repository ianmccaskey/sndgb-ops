import { action } from '@uibakery/data';

/**
 * Leave ONE dated admin-note line on an order for a storefront payment claim
 * that other storefront orders also hold. Idempotent on (order, tx hash):
 * the audit row written alongside the note is the marker, so a retried
 * request after a transient platform error, or the next re-import of the
 * same conflict, appends nothing. Returns the order id when a line was
 * written, no rows when it already existed.
 */
function noteStorefrontClaimConflict() {
  return action('noteStorefrontClaimConflict', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH seen AS (
        SELECT 1
        FROM audit_log
        WHERE table_name = 'orders'
          AND row_pk = {{params.order_id}}::text
          AND action = 'storefront_claim_conflict'
          AND new_data->>'tx_hash' = {{params.tx_hash}}::text
      ), upd AS (
        UPDATE orders SET
          admin_note = CASE
            WHEN admin_note IS NULL OR admin_note = '' THEN {{params.note}}::text
            ELSE admin_note || E'\\n' || {{params.note}}::text
          END
        WHERE id = {{params.order_id}}::bigint
          AND NOT EXISTS (SELECT 1 FROM seen)
        RETURNING id
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'orders', upd.id::text, 'storefront_claim_conflict', {{params.actor}}::text,
               jsonb_build_object('tx_hash', {{params.tx_hash}}::text, 'others', {{params.others}}::jsonb, 'note', {{params.note}}::text)
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default noteStorefrontClaimConflict;
