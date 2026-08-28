import { action } from '@uibakery/data';

/**
 * Archive/unarchive a saved destination. Archived destinations disappear
 * from the transfer form (which offers only active ones) but stay on the
 * Addresses tab for restore; finalized transfers keep their own
 * destination jsonb snapshot, so history never depends on this row. Audited.
 */
function setDestinationActive() {
  return action('setDestinationActive', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfer_destinations
        SET active = {{params.active}}::boolean
        WHERE id = {{params.id}}::bigint
        RETURNING id, label, active
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfer_destinations', up.id::text, 'transfer_destination_active_set', {{params.actor}}::text,
             jsonb_build_object('label', up.label, 'active', up.active)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default setDestinationActive;
