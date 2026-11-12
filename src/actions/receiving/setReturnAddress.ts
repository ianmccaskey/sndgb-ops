import { action } from '@uibakery/data';

/**
 * Point one active receive address at the saved address its ORDER labels
 * return to ('' clears — Shippo then returns them to the ship-from itself).
 * 1790105100: the Ship dialog preselects this as the label's
 * address_return. The target must be active and not the address itself
 * (CHECK receive_addresses_return_not_self binds every writer). A target
 * archived later keeps the pairing — the Ship dialog then makes the
 * operator pick, and restoring the target restores it. Zero rows =
 * refused. Audited with the old and new target.
 */
function setReturnAddress() {
  return action('setReturnAddress', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH prev AS (
        SELECT ra.id, ra.return_address_id
        FROM receive_addresses ra
        WHERE ra.id = {{params.address_id}}::bigint
      ),
      up AS (
        UPDATE receive_addresses ra
        SET return_address_id = NULLIF({{params.return_id}}::text, '')::bigint
        WHERE ra.id = {{params.address_id}}::bigint
          AND ra.active
          AND (NULLIF({{params.return_id}}::text, '') IS NULL
               OR EXISTS (SELECT 1 FROM receive_addresses t
                          WHERE t.id = NULLIF({{params.return_id}}::text, '')::bigint
                            AND t.active
                            AND t.id <> ra.id))
        RETURNING ra.id, ra.return_address_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
      SELECT 'receive_addresses', up.id::text, 'return_address_set', {{params.actor}}::text,
             jsonb_build_object('return_address_id', prev.return_address_id),
             jsonb_build_object('return_address_id', up.return_address_id)
      FROM up JOIN prev ON prev.id = up.id
      RETURNING row_pk AS id
    `,
  });
}

export default setReturnAddress;
