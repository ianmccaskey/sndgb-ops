import { action } from '@uibakery/data';

/**
 * Give back the order's ordering-app write lease (claimOrderUpstream) when
 * a write ends, however it ends. Only the caller's own claim is cleared
 * (exact timestamp). dispatched_at is passed only when the ordering app
 * ANSWERED the writer's PUT — that request is finished, whatever it said —
 * and then its own dispatch mark is cleared too; a PUT whose connection
 * dropped unanswered passes '' and its mark stays (the request may still
 * land) until it is 10 minutes old. Zero rows means both were already gone
 * or taken over. Not audited: a lease, not a fact.
 */
function releaseOrderUpstream() {
  return action('releaseOrderUpstream', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE order_upstream_leases l
      SET claimed_at = CASE WHEN l.claimed_at = NULLIF({{params.claimed_at}}::text, '')::timestamptz
                            THEN NULL ELSE l.claimed_at END,
          dispatched_at = CASE WHEN l.dispatched_at = NULLIF({{params.dispatched_at}}::text, '')::timestamptz
                               THEN NULL ELSE l.dispatched_at END
      WHERE l.order_id = NULLIF({{params.order_id}}::text, '')::bigint
        AND (l.claimed_at = NULLIF({{params.claimed_at}}::text, '')::timestamptz
             OR l.dispatched_at = NULLIF({{params.dispatched_at}}::text, '')::timestamptz)
      RETURNING l.order_id
    `,
  });
}

export default releaseOrderUpstream;
