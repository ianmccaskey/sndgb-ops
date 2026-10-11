import { action } from '@uibakery/data';

/**
 * Member polls on p2collective.app (not tied to a campaign): open first,
 * then drafts, then closed, newest first within each. Counts come back as
 * bigint text. `version` is the opaque updated_at token the edit hands back
 * (optimistic concurrency, same as getStorefrontCampaign). `max_choices_used`
 * is the most options any one cast vote holds — max_choices cannot be
 * lowered below it.
 */
function listStorefrontPolls() {
  return action('listStorefrontPolls', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT p.id, p.title, p.description_md, p.status::text AS status, p.opens_at, p.closes_at,
             p.max_choices, p.hide_results_until_close, p.allow_comments,
             p.created_by, p.created_at, p.updated_at,
             extract(epoch from p.updated_at)::text AS version,
             (SELECT count(*) FROM storefront.poll_options o WHERE o.poll_id = p.id) AS option_count,
             (SELECT count(*) FROM storefront.poll_votes v WHERE v.poll_id = p.id) AS vote_count,
             (SELECT count(*) FROM storefront.poll_votes v
              WHERE v.poll_id = p.id AND NULLIF(btrim(v.comment), '') IS NOT NULL) AS comment_count,
             (SELECT COALESCE(max(s.n), 0) FROM (
                SELECT count(*) AS n FROM storefront.poll_vote_options pvo
                WHERE pvo.poll_id = p.id GROUP BY pvo.vote_id) s) AS max_choices_used
      FROM storefront.polls p
      ORDER BY CASE p.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, p.created_at DESC, p.id DESC
    `,
  });
}

export default listStorefrontPolls;
