import { action } from '@uibakery/data';

/**
 * Remove one option from a draft or open poll. One row, audited with the
 * removed option.
 *
 * Refused (zero rows; the page says why) when the poll is closed, when any
 * vote chose the option (the foreign-key cascade would silently erase that
 * member's choice), or when it would leave an OPEN poll with fewer than two
 * options. The poll row is locked first so a close that commits ahead is
 * seen.
 */
function removeStorefrontPollOption() {
  return action('removeStorefrontPollOption', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.id}}::text, '')::bigint AS id,
               NULLIF({{params.poll_id}}::text, '')::bigint AS poll_id,
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin') AS actor
      ), lck AS (
        SELECT p.id, p.status
        FROM storefront.polls p
        JOIN inp i ON i.poll_id = p.id
        WHERE p.status <> 'closed'
        FOR UPDATE OF p
      ), del AS (
        DELETE FROM storefront.poll_options o
        USING lck l, inp i
        WHERE o.id = i.id
          AND o.poll_id = l.id
          AND NOT EXISTS (SELECT 1 FROM storefront.poll_vote_options pvo WHERE pvo.option_id = o.id)
          AND (l.status = 'draft'
               OR (SELECT count(*) FROM storefront.poll_options o2
                   WHERE o2.poll_id = l.id AND o2.id <> o.id) >= 2)
        RETURNING o.id, o.poll_id, o.label, o.sort
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
        SELECT 'storefront.poll_options', del.id::text, 'poll_option_removed', i.actor,
               jsonb_build_object('poll_id', del.poll_id, 'label', del.label, 'sort', del.sort)
        FROM del, inp i
        RETURNING row_pk
      )
      SELECT id FROM del
    `,
  });
}

export default removeStorefrontPollOption;
