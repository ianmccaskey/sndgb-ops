import { action } from '@uibakery/data';

/**
 * Archive/unarchive a receive address (history keeps its FK rows).
 * Archiving also clears is_default_ship_from in the same UPDATE — the
 * Ship dialog preselects only active defaults, so a default stranded on
 * an archived row would silently stop preselection; the audit row says
 * whether the default was released. Audited.
 */
function setAddressActive() {
  return action('setAddressActive', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE receive_addresses
        SET active = {{params.active}}::boolean,
            is_default_ship_from = CASE WHEN {{params.active}}::boolean THEN is_default_ship_from ELSE false END
        WHERE id = {{params.id}}::bigint
        RETURNING id, label, active, is_default_ship_from
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'receive_addresses', up.id::text, 'receive_address_active_set', {{params.actor}}::text,
             jsonb_build_object('label', up.label, 'active', up.active, 'default_ship_from_kept', up.is_default_ship_from)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default setAddressActive;
