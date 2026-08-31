import { action } from '@uibakery/data';

/**
 * Point one receive address at the group ORIGIN its transfers ship from
 * ('' clears — the address becomes its own origin again). Delegates to
 * set_transfer_origin() (migration 1786477100): the fn LOCKS every row
 * the one-level invariant touches (id order) and validates on fresh
 * statements, so two admins racing A->B and B->C can never commit a
 * two-hop chain the transfer fns' one-level COALESCE would strand.
 * Zero rows = refused. Audited by the fn.
 */
function setTransferOrigin() {
  return action('setTransferOrigin', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM set_transfer_origin(
        {{params.address_id}}::bigint,
        NULLIF({{params.origin_id}}::text, '')::bigint,
        {{params.actor}}::text
      )
    `,
  });
}

export default setTransferOrigin;
