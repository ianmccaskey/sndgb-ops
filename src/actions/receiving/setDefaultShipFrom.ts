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
      -- the target is proven eligible (exists + active, row-locked) BEFORE
      -- anything is cleared: an archived/stale/invalid target refuses with
      -- the existing default untouched
      tgt AS (
        SELECT ra.id, ra.label
        FROM receive_addresses ra, inp
        WHERE ra.id = inp.aid AND ra.active
        FOR UPDATE OF ra
      ),
      clr AS (
        UPDATE receive_addresses SET is_default_ship_from = false
        WHERE is_default_ship_from AND id <> (SELECT id FROM tgt)
          AND EXISTS (SELECT 1 FROM tgt)
        RETURNING id
      ),
      setr AS (
        UPDATE receive_addresses ra SET is_default_ship_from = true
        FROM tgt
        WHERE ra.id = tgt.id
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
