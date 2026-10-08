import { action } from '@uibakery/data';

/**
 * Retire (or reinstate) a payment option. Retiring hides the address from
 * every unpaid order that was set to pay it and makes the storefront refuse
 * new claims against it — the member is told to ask for the current one.
 *
 * A PUBLISHED campaign must always keep one active option (members could
 * not pay otherwise), so retiring the last active one is refused while the
 * campaign is published: add the replacement first, or unpublish.
 * Returns no rows when refused.
 */
function setStorefrontPaymentOptionActive() {
  return action('setStorefrontPaymentOptionActive', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE storefront.campaign_payment_options o
      SET active = ({{params.active}}::text = 'true')
      WHERE o.id = {{params.id}}::bigint
        AND o.group_buy_id = {{params.group_buy_id}}::bigint
        AND (
          ({{params.active}}::text = 'true')
          OR NOT EXISTS (SELECT 1 FROM storefront.campaign_settings cs
                         WHERE cs.group_buy_id = o.group_buy_id AND cs.published)
          OR EXISTS (SELECT 1 FROM storefront.campaign_payment_options o2
                     WHERE o2.group_buy_id = o.group_buy_id AND o2.active AND o2.id <> o.id)
        )
      RETURNING o.id, o.active
    `,
  });
}

export default setStorefrontPaymentOptionActive;
