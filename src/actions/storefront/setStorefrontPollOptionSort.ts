import { action } from '@uibakery/data';

/**
 * Set ONE option's position (sort) on a draft or open poll. One row,
 * audited with the old and new position. Reordering renumbers the list on
 * the page and calls this once per option whose position changed; ties sort
 * by id, so a partly applied reorder still lists every option exactly once.
 * Refused (zero rows) for a closed poll, an option of another poll, or a
 * sort that is not a whole number 0–999999.
 */
function setStorefrontPollOptionSort() {
  return action('setStorefrontPollOptionSort', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.id}}::text, '')::bigint AS id,
               NULLIF({{params.poll_id}}::text, '')::bigint AS poll_id,
               NULLIF(btrim({{params.sort}}::text), '') AS sort_txt,
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin') AS actor
      ), val AS (
        SELECT inp.*, CASE WHEN inp.sort_txt ~ '^[0-9]{1,6}$' THEN inp.sort_txt::int END AS sort
        FROM inp
      ), lck AS (
        SELECT p.id
        FROM storefront.polls p
        JOIN val v ON v.poll_id = p.id
        WHERE p.status <> 'closed'
        FOR UPDATE OF p
      ), old AS (
        SELECT o.id, o.sort FROM storefront.poll_options o JOIN val v ON v.id = o.id AND v.poll_id = o.poll_id
      ), upd AS (
        UPDATE storefront.poll_options o
        SET sort = v.sort
        FROM lck l, val v
        WHERE o.id = v.id
          AND o.poll_id = l.id
          AND v.sort IS NOT NULL
        RETURNING o.id, o.poll_id, o.label, o.sort
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'storefront.poll_options', upd.id::text, 'poll_option_sorted', v.actor,
               jsonb_build_object('sort', old.sort),
               jsonb_build_object('poll_id', upd.poll_id, 'label', upd.label, 'sort', upd.sort)
        FROM upd
        JOIN old ON old.id = upd.id
        CROSS JOIN val v
        RETURNING row_pk
      )
      SELECT id, sort FROM upd
    `,
  });
}

export default setStorefrontPollOptionSort;
