import { action } from '@uibakery/data';

/**
 * The campaign's OPEN import failures, oldest first (the longest-
 * neglected problem tops the card), plus the recently-resolved count so
 * the card can say the basin self-heals. Resolved history stays in the
 * table for the audit trail; this list is the "what is broken NOW" view.
 */
function listImportFailures() {
  return action('listImportFailures', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT f.id, f.order_number, f.message, f.seen_count,
             f.first_seen_at, f.last_seen_at,
             (SELECT count(*) FROM import_failures r
               WHERE r.group_buy_id = f.group_buy_id
                 AND r.resolved_at > now() - interval '7 days') AS resolved_recently
      FROM import_failures f
      WHERE f.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
        AND f.resolved_at IS NULL
      ORDER BY f.first_seen_at
    `,
  });
}

export default listImportFailures;
