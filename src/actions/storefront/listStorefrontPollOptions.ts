import { action } from '@uibakery/data';

/**
 * A poll's options in display order (sort, then id) with the number of
 * votes that chose each — the editor and the results view both read this.
 * Organizers always see counts; hide_results_until_close only governs what
 * members see on the storefront.
 */
function listStorefrontPollOptions() {
  return action('listStorefrontPollOptions', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id, o.poll_id, o.label, o.sort,
             (SELECT count(*) FROM storefront.poll_vote_options pvo
              WHERE pvo.option_id = o.id AND pvo.poll_id = o.poll_id) AS votes
      FROM storefront.poll_options o
      WHERE o.poll_id = NULLIF({{params.poll_id}}::text, '')::bigint
      ORDER BY o.sort, o.id
    `,
  });
}

export default listStorefrontPollOptions;
