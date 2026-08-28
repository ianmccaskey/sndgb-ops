import { action } from '@uibakery/data';

/**
 * Delete a package — refused once RECEIVED (deleting would silently
 * shrink inventory; un-receive first). The audit snapshot pre-aggregates
 * the item lines into old_data because the CASCADE would otherwise erase
 * them without a trace.
 */
function deleteInboundPackage() {
  return action('deleteInboundPackage', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH snapshot AS (
        SELECT p.id, p.receive_address_id, p.carrier, p.tracking_number, p.note, p.committed_at,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'qty', i.qty))
                         FROM inbound_package_items i WHERE i.package_id = p.id), '[]'::jsonb) AS items
        FROM inbound_packages p
        WHERE p.id = {{params.package_id}}::bigint
          AND p.received_at IS NULL
      ), del AS (
        DELETE FROM inbound_packages p
        USING snapshot s
        WHERE p.id = s.id
        RETURNING p.id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
      SELECT 'inbound_packages', s.id::text, 'package_deleted', {{params.actor}}::text,
             jsonb_build_object('receive_address_id', s.receive_address_id, 'carrier', s.carrier,
                                'tracking_number', s.tracking_number, 'note', s.note,
                                'committed_at', s.committed_at, 'items', s.items)
      FROM snapshot s
      JOIN del ON del.id = s.id
      RETURNING row_pk AS id
    `,
  });
}

export default deleteInboundPackage;
