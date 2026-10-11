import { action } from '@uibakery/data';

/**
 * Edit a draft or open poll's settings (never its status — open/close are
 * their own actions). One row, audited with before and after values.
 *
 * Closed polls are read-only. Version-checked: `expected_version` is the
 * updated_at token listStorefrontPolls handed the page; a poll another
 * admin or tab changed since (including opening or closing it) is refused.
 * Same input guards as createStorefrontPoll, except that an unchanged
 * closes_at may already be past (the worker closes it); max_choices may not
 * drop below the most options any cast vote already holds. Zero rows =
 * refused.
 */
function updateStorefrontPoll() {
  return action('updateStorefrontPoll', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.id}}::text, '')::bigint AS id,
               NULLIF({{params.expected_version}}::text, '') AS expected_version,
               NULLIF(btrim({{params.title}}::text), '') AS title,
               NULLIF(btrim({{params.description_md}}::text), '') AS description_md,
               NULLIF(btrim({{params.max_choices}}::text), '') AS max_choices_txt,
               COALESCE(NULLIF({{params.hide_results_until_close}}::text, ''), 'false') = 'true' AS hide_results_until_close,
               COALESCE(NULLIF({{params.allow_comments}}::text, ''), 'true') = 'true' AS allow_comments,
               NULLIF(btrim({{params.opens_at}}::text), '') AS opens_at_txt,
               NULLIF(btrim({{params.closes_at}}::text), '') AS closes_at_txt,
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin') AS actor
      ), val AS (
        SELECT inp.*,
               CASE WHEN inp.max_choices_txt ~ '^[0-9]{1,2}$' THEN inp.max_choices_txt::int END AS max_choices,
               CASE WHEN inp.opens_at_txt ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
                    THEN inp.opens_at_txt::timestamptz END AS opens_at,
               CASE WHEN inp.closes_at_txt ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
                    THEN inp.closes_at_txt::timestamptz END AS closes_at
        FROM inp
      ), old AS (
        -- the poll as the page loaded it, not closed, locked for the update
        SELECT p.id, p.title, p.description_md, p.status, p.opens_at, p.closes_at, p.max_choices,
               p.hide_results_until_close, p.allow_comments
        FROM storefront.polls p
        JOIN val v ON v.id = p.id
        WHERE p.status <> 'closed'
          AND extract(epoch from p.updated_at)::text = v.expected_version
        FOR UPDATE OF p
      ), upd AS (
        UPDATE storefront.polls p SET
          title = v.title,
          description_md = v.description_md,
          opens_at = v.opens_at,
          closes_at = v.closes_at,
          max_choices = v.max_choices,
          hide_results_until_close = v.hide_results_until_close,
          allow_comments = v.allow_comments
        FROM old o, val v
        WHERE p.id = o.id
          AND v.title IS NOT NULL AND length(v.title) <= 200
          AND v.max_choices BETWEEN 1 AND 10
          AND (v.opens_at_txt IS NULL OR v.opens_at IS NOT NULL)
          AND (v.closes_at_txt IS NULL OR v.closes_at IS NOT NULL)
          AND (v.closes_at IS NULL OR v.closes_at > now()
               OR date_trunc('minute', v.closes_at) = date_trunc('minute', o.closes_at))
          AND (v.closes_at IS NULL OR v.opens_at IS NULL OR v.closes_at > v.opens_at)
          AND NOT EXISTS (
            SELECT 1 FROM storefront.poll_vote_options pvo
            WHERE pvo.poll_id = p.id
            GROUP BY pvo.vote_id
            HAVING count(*) > v.max_choices
          )
        RETURNING p.id, p.title, p.description_md, p.status, p.opens_at, p.closes_at, p.max_choices,
                  p.hide_results_until_close, p.allow_comments, p.updated_at
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'storefront.polls', upd.id::text, 'poll_updated', v.actor,
               jsonb_build_object('title', o.title, 'description_md', o.description_md, 'opens_at', o.opens_at,
                                  'closes_at', o.closes_at, 'max_choices', o.max_choices,
                                  'hide_results_until_close', o.hide_results_until_close,
                                  'allow_comments', o.allow_comments),
               jsonb_build_object('title', upd.title, 'description_md', upd.description_md, 'status', upd.status,
                                  'opens_at', upd.opens_at, 'closes_at', upd.closes_at, 'max_choices', upd.max_choices,
                                  'hide_results_until_close', upd.hide_results_until_close,
                                  'allow_comments', upd.allow_comments)
        FROM upd
        JOIN old o ON o.id = upd.id
        CROSS JOIN val v
        RETURNING row_pk
      )
      SELECT id, extract(epoch from updated_at)::text AS version FROM upd
    `,
  });
}

export default updateStorefrontPoll;
