import { action } from '@uibakery/data';

/**
 * Add one option to a draft or open poll, at the end of the order. One row,
 * audited. The poll row is locked first, so a close that commits ahead of
 * this is seen (closed polls are read-only). Refused (zero rows) for a
 * closed or missing poll, an empty or over-long (> 200 chars) label, or a
 * label the poll already has (case-insensitive).
 */
function addStorefrontPollOption() {
  return action('addStorefrontPollOption', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.poll_id}}::text, '')::bigint AS poll_id,
               NULLIF(btrim({{params.label}}::text), '') AS label,
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin') AS actor
      ), lck AS (
        SELECT p.id, p.status
        FROM storefront.polls p
        JOIN inp i ON i.poll_id = p.id
        WHERE p.status <> 'closed'
        FOR UPDATE OF p
      ), ins AS (
        INSERT INTO storefront.poll_options (poll_id, label, sort)
        SELECT l.id, i.label,
               COALESCE((SELECT max(o.sort) + 1 FROM storefront.poll_options o WHERE o.poll_id = l.id), 0)
        FROM lck l, inp i
        WHERE i.label IS NOT NULL
          AND length(i.label) <= 200
          AND NOT EXISTS (SELECT 1 FROM storefront.poll_options o
                          WHERE o.poll_id = l.id AND lower(o.label) = lower(i.label))
        RETURNING id, poll_id, label, sort
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'storefront.poll_options', ins.id::text, 'poll_option_added', i.actor,
               jsonb_build_object('poll_id', ins.poll_id, 'label', ins.label, 'sort', ins.sort,
                                  'poll_status', (SELECT l.status FROM lck l))
        FROM ins, inp i
        RETURNING row_pk
      )
      SELECT id FROM ins
    `,
  });
}

export default addStorefrontPollOption;
