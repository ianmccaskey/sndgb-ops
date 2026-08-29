import { action } from '@uibakery/data';

/**
 * Delete an UNFINALIZED shipment draft (failed/abandoned purchase),
 * freeing its attributed quantities (CASCADE removes shipment_items — the
 * order's remaining-to-pack grows back). A finalized shipment is a real
 * label and never deletes here — the refund flow voids it instead.
 * Refuses while the purchase lease is fresher than 10 minutes (a label
 * purchase may be in flight — this session's or the other admin's), and
 * refuses a draft whose Shippo POST was DISPATCHED (purchase_attempted_at)
 * until a proof-of-absence walk stamped attempt_verified_no_label_at:
 * deleting would orphan the rate id, the only recovery handle for a label
 * that may have been paid. Items snapshot into old_data (CASCADE would
 * erase them silently). Attached package photos also CASCADE away, so
 * each one gets its own shipment_photo_deleted TOMBSTONE audit row
 * (reason draft_deleted, with the full image's md5 fingerprint and the
 * complete thumbnail blob) and the draft's audit row carries their count
 * — deleted evidence stays viewable and provable in audit history.
 * Audited.
 */
function deleteShipmentDraft() {
  return action('deleteShipmentDraft', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT s.id AS sid, pg_advisory_xact_lock(42001, s.order_id::int) AS locked
        FROM shipments s
        WHERE s.id = {{params.shipment_id}}::bigint
      ),
      snapshot AS (
        SELECT s.id, s.order_id, s.shippo_rate_id, s.rate_amount,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('order_item_id', i.order_item_id, 'qty', i.qty))
                         FROM shipment_items i WHERE i.shipment_id = s.id), '[]'::jsonb) AS items
        FROM shipments s, lck
        WHERE s.id = lck.sid
          AND s.finalized_at IS NULL
          AND (s.purchase_started_at IS NULL OR s.purchase_started_at < now() - interval '10 minutes')
          AND (s.purchase_attempted_at IS NULL OR s.attempt_verified_no_label_at IS NOT NULL)
      ), photos AS (
        SELECT sp.id, sp.shipment_id, length(sp.image_data) AS bytes,
               md5(sp.image_data) AS image_md5, sp.thumb_data,
               sp.created_by, sp.created_at
        FROM shipment_photos sp, snapshot sn
        WHERE sp.shipment_id = sn.id
      ), del AS (
        DELETE FROM shipments s
        USING snapshot sn
        WHERE s.id = sn.id
        RETURNING s.id
      ), audit_photos AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
        SELECT 'shipment_photos', p.id::text, 'shipment_photo_deleted', {{params.actor}}::text,
               jsonb_build_object('shipment_id', p.shipment_id, 'bytes', p.bytes,
                                  'image_md5', p.image_md5, 'thumb_data', p.thumb_data,
                                  'taken_at', p.created_at, 'taken_by', p.created_by,
                                  'reason', 'draft_deleted')
        FROM photos p
        JOIN del ON del.id = p.shipment_id
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
      SELECT 'shipments', sn.id::text, 'shipment_draft_deleted', {{params.actor}}::text,
             jsonb_build_object('order_id', sn.order_id, 'shippo_rate_id', sn.shippo_rate_id,
                                'rate_amount', sn.rate_amount, 'items', sn.items,
                                'photos_deleted', (SELECT count(*) FROM photos))
      FROM snapshot sn
      JOIN del ON del.id = sn.id
      RETURNING row_pk AS id
    `,
  });
}

export default deleteShipmentDraft;
