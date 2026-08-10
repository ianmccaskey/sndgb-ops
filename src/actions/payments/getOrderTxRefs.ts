import { action } from '@uibakery/data';

/**
 * The order's current tx hashes split by rejection state, pipe-delimited.
 * The upstream push reads THIS at click time (never a stale component
 * render): non-rejected refs are what we assert, rejected refs are what the
 * merge strips from the upstream list.
 */
function getOrderTxRefs() {
  return action('getOrderTxRefs', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT COALESCE(string_agg(tx_hash, ' | ' ORDER BY id) FILTER (WHERE status <> 'rejected'), '') AS refs,
             COUNT(*) FILTER (WHERE status <> 'rejected') AS ref_count,
             COALESCE(string_agg(tx_hash, ' | ' ORDER BY id) FILTER (WHERE status = 'rejected'), '') AS rejected_refs
      FROM payments
      WHERE order_id = {{params.order_id}}::bigint
        AND tx_hash IS NOT NULL
    `,
  });
}

export default getOrderTxRefs;
