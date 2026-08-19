import { action } from '@uibakery/data';

/**
 * One content line per call (platform single-row rule). Refused once the
 * transfer is finalized — its items are inventory movement then. Audited.
 */
function addTransferItem() {
  return action('addTransferItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        INSERT INTO transfer_items (transfer_id, product_id, qty)
        SELECT t.id, {{params.product_id}}::bigint, ({{params.qty}})::numeric
        FROM transfers t
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
          AND ({{params.qty}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.qty}})::numeric > 0
        ON CONFLICT (transfer_id, product_id) DO UPDATE SET qty = EXCLUDED.qty
        RETURNING id, transfer_id, product_id, qty
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfer_items', up.id::text, 'transfer_item_set', {{params.actor}},
             jsonb_build_object('transfer_id', up.transfer_id, 'product_id', up.product_id, 'qty', up.qty)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default addTransferItem;
