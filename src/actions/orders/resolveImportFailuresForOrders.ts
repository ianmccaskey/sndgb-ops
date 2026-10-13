import { action } from '@uibakery/data';

/**
 * Auto-resolve: called ONCE at the end of an import run with every
 * order number that imported CLEAN this run. An open failure for an
 * order that now imports without a problem is by definition addressed —
 * closing it here is what keeps the failures card from nagging about
 * fixed problems. Set-based single UPDATE (never a multi-row insert —
 * the platform validation precedent), idempotent, campaign-scoped.
 */
function resolveImportFailuresForOrders() {
  return action('resolveImportFailuresForOrders', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE import_failures f
         SET resolved_at = now(),
             resolved_by = {{params.actor}}::text,
             resolution = 'auto: imported clean on a later run'
       WHERE f.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
         AND f.resolved_at IS NULL
         AND f.order_number IN (
           SELECT jsonb_array_elements_text({{params.order_numbers}}::jsonb)
         )
      RETURNING f.id, f.order_number
    `,
  });
}

export default resolveImportFailuresForOrders;
