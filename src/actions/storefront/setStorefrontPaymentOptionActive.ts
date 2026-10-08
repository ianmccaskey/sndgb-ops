import { action } from '@uibakery/data';

/**
 * Retire (or reinstate) a payment option. Retiring hides the address from
 * every unpaid order that was set to pay it and makes the storefront refuse
 * new claims against it — the member is told to ask for the current one.
 */
function setStorefrontPaymentOptionActive() {
  return action('setStorefrontPaymentOptionActive', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE storefront.campaign_payment_options
      SET active = ({{params.active}}::text = 'true')
      WHERE id = {{params.id}}::bigint AND group_buy_id = {{params.group_buy_id}}::bigint
      RETURNING id, active
    `,
  });
}

export default setStorefrontPaymentOptionActive;
