import { action } from '@uibakery/data';

/**
 * One audit row per auto-reconcile run that CHANGED something, on the
 * campaign (group_buys scope): what triggered it, the counts, and the list
 * of what it did. Every individual write already has its own row
 * (chain_verify, payment_auto_repointed, payment_rail_corrected,
 * admin_note_appended) under the same actor; this is the run's summary so
 * the trail shows the pass as one event. A run that changed nothing writes
 * nothing. The scope is fixed in the query, not the caller.
 */
function logAutoReconRun() {
  return action('logAutoReconRun', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.group_buy_id}}::text, '')::bigint AS gb,
               NULLIF({{params.actor}}::text, '') AS actor,
               NULLIF({{params.detail}}::text, '')::jsonb AS detail
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'group_buys', inp.gb::text, 'auto_recon_run', inp.actor, inp.detail
      FROM inp
      WHERE inp.gb IS NOT NULL AND inp.actor IS NOT NULL AND inp.detail IS NOT NULL
      RETURNING id
    `,
  });
}

export default logAutoReconRun;
