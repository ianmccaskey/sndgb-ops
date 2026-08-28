import { action } from '@uibakery/data';

function addOverride() {
  return action('addOverride', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- per-order advisory lock (class 42001) shared with write-offs and
        -- payment writes — overrides replace effective received wholesale
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), ins AS (
        INSERT INTO payment_overrides (order_id, amount_usd, reason, created_by)
        SELECT
          {{params.order_id}}::bigint,
          {{params.amount_usd}}::numeric,
          {{params.reason}}::text,
          {{params.created_by}}::text
        FROM lck
        RETURNING id, order_id, amount_usd, reason
      ), wo_clear AS (
        -- an override is an explicit statement of total received: a standing
        -- write-off no longer describes reality — auto-clear it, audited
        DELETE FROM order_writeoffs w
        USING ins
        WHERE w.order_id = ins.order_id
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.created_by}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'override')
        FROM wo_clear
        RETURNING row_pk
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
