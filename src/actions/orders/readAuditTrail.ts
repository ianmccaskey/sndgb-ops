import { action } from '@uibakery/data';

/**
 * Everything audited about ONE order, oldest first: rows keyed on the
 * order itself and on its child rows (items, payments, overrides,
 * credits, refunds, write-offs, shipments, direct-ship transfers), plus
 * rows from any table whose new_data names this order_id — that second
 * leg is what keeps a deleted credit or an auto-cleared write-off in the
 * story after its own row is gone. Campaign-pinned: an order number
 * outside the given campaign returns nothing, so a caller (the read-only
 * assistant included) cannot wander across campaigns. Read-only.
 */
function readAuditTrail() {
  return action('readAuditTrail', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.order_number}}::text, '') AS order_number,
               NULLIF({{params.group_buy_id}}::text, '')::bigint AS group_buy_id
      ),
      ord AS (
        SELECT o.id FROM orders o, inp
        WHERE o.order_number = inp.order_number AND o.group_buy_id = inp.group_buy_id
      ),
      scope AS (
        SELECT 'orders'::text AS t, id::text AS pk FROM ord
        UNION ALL SELECT 'order_items', oi.id::text FROM order_items oi JOIN ord ON ord.id = oi.order_id
        UNION ALL SELECT 'payments', p.id::text FROM payments p JOIN ord ON ord.id = p.order_id
        UNION ALL SELECT 'payment_overrides', po.id::text FROM payment_overrides po JOIN ord ON ord.id = po.order_id
        UNION ALL SELECT 'order_credits', c.id::text FROM order_credits c JOIN ord ON ord.id = c.order_id
        UNION ALL SELECT 'order_refunds', r.id::text FROM order_refunds r JOIN ord ON ord.id = r.order_id
        UNION ALL SELECT 'order_writeoffs', w.id::text FROM order_writeoffs w JOIN ord ON ord.id = w.order_id
        UNION ALL SELECT 'shipments', s.id::text FROM shipments s JOIN ord ON ord.id = s.order_id
        UNION ALL SELECT 'transfers', t.id::text
          FROM transfers t JOIN order_items oi ON oi.id = t.direct_order_item_id JOIN ord ON ord.id = oi.order_id
      )
      -- raw upstream snapshots and shipment destinations carry member
      -- contact data; the trail never needs them (the consumer redacts
      -- nested keys too, this is the first net)
      SELECT a.id, a.at, a.table_name, a.row_pk, a.action, a.actor,
             a.old_data - 'raw_import' - 'destination' - 'parcel' - 'from_label' - 'address_to' - 'address_from' AS old_data,
             a.new_data - 'raw_import' - 'destination' - 'parcel' - 'from_label' - 'address_to' - 'address_from' AS new_data
      FROM audit_log a
      WHERE EXISTS (SELECT 1 FROM scope s WHERE s.t = a.table_name AND s.pk = a.row_pk)
         OR (a.new_data ? 'order_id' AND (a.new_data->>'order_id') = (SELECT id::text FROM ord))
      ORDER BY a.at, a.id
      LIMIT 500
    `,
  });
}

export default readAuditTrail;
