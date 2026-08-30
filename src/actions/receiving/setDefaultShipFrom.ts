import { action } from '@uibakery/data';

/**
 * Move the app-wide default ship-from to one ACTIVE address. One
 * statement: clear the old default, set the new one (archived targets
 * refuse — zero rows), audit. The partial unique index
 * receive_addresses_default_ship_from_uniq backstops the one-default
 * invariant against any concurrent setter.
 */
function setDefaultShipFrom() {
  return action('setDefaultShipFrom', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.address_id}}::text, '')::bigint AS aid, {{params.actor}}::text AS actor
      ),
      clr AS (
        UPDATE receive_addresses SET is_default_ship_from = false
        WHERE is_default_ship_from AND id <> (SELECT aid FROM inp)
        RETURNING id
      ),
      setr AS (
        UPDATE receive_addresses ra SET is_default_ship_from = true
        FROM inp
        WHERE ra.id = inp.aid AND ra.active
        RETURNING ra.id, ra.label
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'receive_addresses', s.id::text, 'default_ship_from_set', inp.actor,
             jsonb_build_object('label', s.label, 'cleared', (SELECT COUNT(*) FROM clr))
      FROM setr s, inp
      RETURNING row_pk AS id
    `,
  });
}

export default setDefaultShipFrom;
