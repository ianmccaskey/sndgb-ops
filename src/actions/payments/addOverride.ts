import { action } from '@uibakery/data';

function addOverride() {
  return action('addOverride', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO payment_overrides (order_id, amount_usd, reason, created_by)
        VALUES (
          {{params.order_id}}::bigint,
          {{params.amount_usd}}::numeric,
          {{params.reason}},
          {{params.created_by}}
        )
        RETURNING id, order_id, amount_usd, reason
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'payment_overrides', ins.id::text, 'override', {{params.created_by}},
             jsonb_build_object('order_id', ins.order_id, 'amount_usd', ins.amount_usd, 'reason', ins.reason)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addOverride;
