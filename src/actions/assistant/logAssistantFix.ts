import { action } from '@uibakery/data';

/**
 * One audit row per assistant proposal the operator APPLIED, under the
 * operator who clicked, beside the row the underlying control wrote
 * (manual_status_change, payment_hash_added, override, …). That row says
 * what changed; this one says the change was proposed by the assistant,
 * with the kind, the target, the (scrubbed) reason the operator confirmed
 * and the control's own result line. Only an order can be the scope — the
 * allowlist is in the query. Refused or failed applies write nothing here:
 * nothing changed, and the dialog shows the operator why.
 */
function logAssistantFix() {
  return action('logAssistantFix', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.row_pk}}::text, '') AS row_pk,
               NULLIF({{params.actor}}::text, '') AS actor,
               NULLIF({{params.detail}}::text, '')::jsonb AS detail
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'orders', inp.row_pk, 'assistant_fix_applied', inp.actor, inp.detail
      FROM inp
      WHERE inp.row_pk IS NOT NULL AND inp.actor IS NOT NULL AND inp.detail IS NOT NULL
      RETURNING id
    `,
  });
}

export default logAssistantFix;
