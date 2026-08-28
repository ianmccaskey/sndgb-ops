import { action } from '@uibakery/data';

function updateOrderAdmin() {
  return action('updateOrderAdmin', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE orders SET
          status = {{params.status}}::order_status,
          hold_shipping = {{params.hold_shipping}}::boolean,
          admin_note = NULLIF({{params.admin_note}}::text, '')
        WHERE id = {{params.order_id}}::bigint
        RETURNING id, status, hold_shipping
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'orders', upd.id::text, 'admin_update', {{params.actor}}::text,
             jsonb_build_object('status', upd.status, 'hold_shipping', upd.hold_shipping)
      FROM upd
      RETURNING row_pk AS id
    `,
  });
}

export default updateOrderAdmin;
