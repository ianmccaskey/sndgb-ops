import { action } from '@uibakery/data';

/** Archive/unarchive a receive address (history keeps its FK rows). Audited. */
function setAddressActive() {
  return action('setAddressActive', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE receive_addresses
        SET active = {{params.active}}::boolean
        WHERE id = {{params.id}}::bigint
        RETURNING id, label, active
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'receive_addresses', up.id::text, 'receive_address_active_set', {{params.actor}},
             jsonb_build_object('label', up.label, 'active', up.active)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default setAddressActive;
