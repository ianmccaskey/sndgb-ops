import { action } from '@uibakery/data';

/**
 * Cancel a local order whose source record was deleted in the ordering app —
 * status change, admin-note line, and audit row happen in ONE statement, so
 * the destructive part can never land without its audit trail (a plain
 * syncOrderStatus + appendOrderAdminNote pair could).
 *
 * Idempotent: an already-cancelled/refunded order matches nothing and returns
 * no rows (no duplicate note on retry); the caller reports "already cancelled".
 *
 * Source-bound like listActiveExternalOrders: the row's preserved raw_import
 * must prove it came from the base44 campaign the caller diffed against
 * (gb_external_id) — a row from a since-relinked source matches nothing.
 */
function cancelDeletedUpstream() {
  return action('cancelDeletedUpstream', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE orders SET
          status = 'cancelled'::order_status,
          admin_note = CASE
            WHEN admin_note IS NULL OR admin_note = '' THEN {{params.note}}::text
            ELSE admin_note || E'\\n' || {{params.note}}::text
          END
        WHERE id = {{params.order_id}}::bigint
          AND group_buy_id = {{params.group_buy_id}}::bigint
          AND external_id = {{params.external_id}}::text
          AND status NOT IN ('cancelled','refunded')
          AND raw_import->>'source' = 'base44'
          AND (raw_import->>'json')::jsonb->>'group_buy_id' = {{params.gb_external_id}}::text
        RETURNING id
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'orders', upd.id::text, 'cancelled_deleted_upstream', {{params.actor}},
               jsonb_build_object('note', {{params.note}}::text, 'external_id', {{params.external_id}})
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default cancelDeletedUpstream;
