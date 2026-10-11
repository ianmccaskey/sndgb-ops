import { action } from '@uibakery/data';

/**
 * Comments members left with their vote on one poll, oldest first, with the
 * options that vote chose. Member identity is ONLY the short form of the
 * Neon Auth user id (first 8 characters) — never the full id, an email or a
 * display name: this list is read in an admin screen that may be shared.
 */
function listStorefrontPollComments() {
  return action('listStorefrontPollComments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT v.id, v.poll_id, left(v.auth_user_id::text, 8) AS member, v.comment, v.created_at, v.updated_at,
             (SELECT string_agg(o.label, ', ' ORDER BY o.sort, o.id)
              FROM storefront.poll_vote_options pvo
              JOIN storefront.poll_options o ON o.id = pvo.option_id
              WHERE pvo.vote_id = v.id) AS choices
      FROM storefront.poll_votes v
      WHERE v.poll_id = NULLIF({{params.poll_id}}::text, '')::bigint
        AND NULLIF(btrim(v.comment), '') IS NOT NULL
      ORDER BY v.created_at, v.id
    `,
  });
}

export default listStorefrontPollComments;
