import { action } from '@uibakery/data';

/**
 * Create a member poll as a DRAFT. One row, audited. Options are added one
 * at a time afterwards (addStorefrontPollOption); opening is its own step
 * (openStorefrontPoll).
 *
 * Guards (zero rows = refused, the page says why): a title (≤ 200 chars);
 * max_choices a whole number 1–10; opens_at / closes_at, when given, are
 * ISO timestamps WITH a zone (the page sends toISOString()), closes_at is in
 * the future and after opens_at. Text is pattern-checked before any cast.
 */
function createStorefrontPoll() {
  return action('createStorefrontPoll', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF(btrim({{params.title}}::text), '') AS title,
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
      ), ins AS (
        INSERT INTO storefront.polls
          (title, description_md, status, opens_at, closes_at, max_choices, hide_results_until_close, allow_comments, created_by)
        SELECT v.title, v.description_md, 'draft'::storefront.poll_status, v.opens_at, v.closes_at, v.max_choices,
               v.hide_results_until_close, v.allow_comments, v.actor
        FROM val v
        WHERE v.title IS NOT NULL AND length(v.title) <= 200
          AND v.max_choices BETWEEN 1 AND 10
          AND (v.opens_at_txt IS NULL OR v.opens_at IS NOT NULL)
          AND (v.closes_at_txt IS NULL OR v.closes_at IS NOT NULL)
          AND (v.closes_at IS NULL OR v.closes_at > now())
          AND (v.closes_at IS NULL OR v.opens_at IS NULL OR v.closes_at > v.opens_at)
        RETURNING id, title, description_md, status, opens_at, closes_at, max_choices,
                  hide_results_until_close, allow_comments, updated_at
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'storefront.polls', ins.id::text, 'poll_created', v.actor,
               jsonb_build_object('title', ins.title, 'description_md', ins.description_md, 'status', ins.status,
                                  'opens_at', ins.opens_at, 'closes_at', ins.closes_at, 'max_choices', ins.max_choices,
                                  'hide_results_until_close', ins.hide_results_until_close,
                                  'allow_comments', ins.allow_comments)
        FROM ins, val v
        RETURNING row_pk
      )
      SELECT id, extract(epoch from updated_at)::text AS version FROM ins
    `,
  });
}

export default createStorefrontPoll;
