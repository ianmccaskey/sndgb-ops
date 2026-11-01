import { action } from '@uibakery/data';

/**
 * Claim (prior_claimed_at '') or renew (the caller's own claim, right
 * before its PUT) the ORDER's ordering-app write lease — thin wrapper over
 * claim_order_upstream() (migration 1790103200). Every writer of an
 * order's ship state upstream holds it: a box's push (names the box and
 * its push_epoch, which must still be pushable), a cancelled box's reset
 * and the auto-adopt write-back (no box). Taken before the writer reads
 * what shipped here, under the 42001 order lock the cancel holds too; the
 * renewal also marks the write dispatched, and at most one dispatched
 * write per order is unresolved. Zero rows = refused (the box changed,
 * another write's sent PUT is unresolved, or — for a renewal — the lease
 * was taken over). Timestamps travel as text (microsecond-exact).
 */
function claimOrderUpstream() {
  return action('claimOrderUpstream', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o_claimed_at AS claimed_at, o_dispatched_at AS dispatched_at
      FROM claim_order_upstream(
        NULLIF({{params.order_id}}::text, '')::bigint,
        NULLIF({{params.shipment_id}}::text, '')::bigint,
        NULLIF({{params.expected_push_epoch}}::text, '')::int,
        COALESCE({{params.prior_claimed_at}}::text, ''),
        NULLIF(btrim({{params.actor}}::text), '')
      )
    `,
  });
}

export default claimOrderUpstream;
