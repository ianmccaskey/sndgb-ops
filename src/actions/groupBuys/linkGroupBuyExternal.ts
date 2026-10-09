import { action } from '@uibakery/data';

/**
 * Link (or unlink, with an empty id) a campaign to the base44 ordering app.
 * A campaign runs on ONE ordering platform: one already set up for the
 * storefront (a storefront.campaign_settings row) is never linked — the
 * Import page would hide the storefront pull behind the base44 one. Refusal
 * returns no rows; the database keeps the same rule as a constraint trigger
 * (1790101100) for every other writer.
 */
function linkGroupBuyExternal() {
  return action('linkGroupBuyExternal', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE group_buys SET
        external_id = NULLIF({{params.external_id}}::text, '')
      WHERE id = {{params.id}}::bigint
        AND (NULLIF({{params.external_id}}::text, '') IS NULL
             OR NOT EXISTS (SELECT 1 FROM storefront.campaign_settings cs WHERE cs.group_buy_id = group_buys.id))
      RETURNING id, external_id
    `,
  });
}

export default linkGroupBuyExternal;
