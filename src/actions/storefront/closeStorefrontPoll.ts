import { action } from '@uibakery/data';

/**
 * Close an OPEN poll (open → closed). Final: no action reopens a closed
 * poll, and every edit action refuses one. One row, audited with the vote
 * count at closing. Refused (zero rows) unless the poll is open. Writes only
 * the status.
 */
function closeStorefrontPoll() {
  return action('closeStorefrontPoll', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE storefront.polls p
        SET status = 'closed'
        WHERE p.id = NULLIF({{params.id}}::text, '')::bigint
          AND p.status = 'open'
        RETURNING p.id, p.status, p.opens_at, p.closes_at
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'storefront.polls', upd.id::text, 'poll_closed',
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin'),
               jsonb_build_object('status', 'open'),
               jsonb_build_object('status', upd.status, 'closes_at', upd.closes_at,
                                  'votes', (SELECT count(*) FROM storefront.poll_votes v WHERE v.poll_id = upd.id))
        FROM upd
        RETURNING row_pk
      )
      SELECT id, status::text AS status FROM upd
    `,
  });
}

export default closeStorefrontPoll;
