import { action } from '@uibakery/data';

/**
 * Delete an UNFINALIZED draft (failed/abandoned purchase). A finalized
 * transfer is a real label + inventory movement and never deletes here —
 * the refund flow marks it instead. Items snapshot into old_data (CASCADE
 * would erase them silently). Audited.
 */
function deleteTransferDraft() {
  return action('deleteTransferDraft', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH snapshot AS (
        SELECT t.id, t.from_address_id, t.destination_label, t.shippo_rate_id, t.rate_amount,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'qty', i.qty))
                         FROM transfer_items i WHERE i.transfer_id = t.id), '[]'::jsonb) AS items
        FROM transfers t
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
      ), del AS (
        DELETE FROM transfers t
        USING snapshot s
        WHERE t.id = s.id
        RETURNING t.id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
      SELECT 'transfers', s.id::text, 'transfer_draft_deleted', {{params.actor}},
             jsonb_build_object('from_address_id', s.from_address_id, 'destination_label', s.destination_label,
                                'shippo_rate_id', s.shippo_rate_id, 'rate_amount', s.rate_amount, 'items', s.items)
      FROM snapshot s
      JOIN del ON del.id = s.id
      RETURNING row_pk AS id
    `,
  });
}

export default deleteTransferDraft;
