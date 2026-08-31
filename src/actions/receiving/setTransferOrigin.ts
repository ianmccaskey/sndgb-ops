import { action } from '@uibakery/data';

/**
 * Point one receive address at the group ORIGIN its transfers ship from
 * ('' clears — the address becomes its own origin again). One level
 * deep, enforced here: the target origin must be active with NO origin
 * of its own, and the address being pointed must not itself BE an
 * origin for others (that would strand their stock two hops away, which
 * the fns' one-level COALESCE never resolves). Zero rows = refused.
 * Audited.
 */
function setTransferOrigin() {
  return action('setTransferOrigin', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT {{params.address_id}}::bigint AS aid,
               NULLIF({{params.origin_id}}::text, '')::bigint AS oid,
               {{params.actor}}::text AS actor
      ),
      up AS (
        UPDATE receive_addresses ra SET transfer_origin_id = inp.oid
        FROM inp
        WHERE ra.id = inp.aid
          AND ra.active
          AND (inp.oid IS NULL OR (
            inp.oid <> inp.aid
            AND EXISTS (SELECT 1 FROM receive_addresses o
                        WHERE o.id = inp.oid AND o.active AND o.transfer_origin_id IS NULL)
          ))
          -- an address other rows point at cannot itself be re-pointed
          AND NOT (inp.oid IS NOT NULL AND EXISTS (
            SELECT 1 FROM receive_addresses m WHERE m.transfer_origin_id = inp.aid))
        RETURNING ra.id, ra.label, ra.transfer_origin_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'receive_addresses', up.id::text, 'transfer_origin_set', inp.actor,
             jsonb_build_object('label', up.label, 'transfer_origin_id', up.transfer_origin_id)
      FROM up, inp
      RETURNING row_pk AS id
    `,
  });
}

export default setTransferOrigin;
