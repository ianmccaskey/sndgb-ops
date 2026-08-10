import { action } from '@uibakery/data';

/**
 * The order's current non-rejected tx hashes, aggregated in the ordering
 * app's pipe-delimited format. The upstream push reads THIS at click time so
 * it always reflects the database, never a stale component render.
 */
function getOrderTxRefs() {
  return action('getOrderTxRefs', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT COALESCE(string_agg(tx_hash, ' | ' ORDER BY id), '') AS refs,
             COUNT(*) AS ref_count
      FROM payments
      WHERE order_id = {{params.order_id}}::bigint
        AND tx_hash IS NOT NULL
        AND status <> 'rejected'
    `,
  });
}

export default getOrderTxRefs;
