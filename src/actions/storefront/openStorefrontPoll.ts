import { action } from '@uibakery/data';

/**
 * Open a DRAFT poll to members (draft → open). One row, audited.
 *
 * Refused (zero rows; the page says why) unless the poll is a draft with at
 * least two options and its closing time, if set, is still ahead. Writes
 * only the status.
 */
function openStorefrontPoll() {
  return action('openStorefrontPoll', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE storefront.polls p
        SET status = 'open'
        WHERE p.id = NULLIF({{params.id}}::text, '')::bigint
          AND p.status = 'draft'
          AND (SELECT count(*) FROM storefront.poll_options o WHERE o.poll_id = p.id) >= 2
          AND (p.closes_at IS NULL OR p.closes_at > now())
        RETURNING p.id, p.status, p.opens_at, p.closes_at, p.max_choices
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'storefront.polls', upd.id::text, 'poll_opened',
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin'),
               jsonb_build_object('status', 'draft'),
               jsonb_build_object('status', upd.status, 'opens_at', upd.opens_at, 'closes_at', upd.closes_at,
                                  'max_choices', upd.max_choices,
                                  'options', (SELECT count(*) FROM storefront.poll_options o WHERE o.poll_id = upd.id))
        FROM upd
        RETURNING row_pk
      )
      SELECT id, status::text AS status FROM upd
    `,
  });
}

export default openStorefrontPoll;
