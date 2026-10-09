import { action } from '@uibakery/data';

/**
 * Publish or unpublish a campaign on the storefront — the ONLY writer of
 * campaign_settings.published. It touches no other column, so a stale page
 * can never carry old copy or settings into this flip, and the setup save
 * (upsertStorefrontCampaign) never carries a stale flag the other way.
 *
 * Publishing requires an active payment option (members could not pay
 * otherwise): checked here under the campaign row lock, and kept by the
 * database for every writer (constraint trigger 1790100900). Refusal returns
 * no rows; the page says why. Idempotent: setting the flag to its current
 * value still returns the row.
 */
function setStorefrontCampaignPublished() {
  return action('setStorefrontCampaignPublished', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE storefront.campaign_settings cs
      SET published = ({{params.published}}::text = 'true')
      WHERE cs.group_buy_id = {{params.group_buy_id}}::bigint
        AND (
          {{params.published}}::text <> 'true'
          OR EXISTS (
            SELECT 1 FROM storefront.campaign_payment_options po
            WHERE po.group_buy_id = cs.group_buy_id AND po.active
          )
        )
      RETURNING cs.group_buy_id, cs.published
    `,
  });
}

export default setStorefrontCampaignPublished;
