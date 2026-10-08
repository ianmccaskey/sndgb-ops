import { action } from '@uibakery/data';

/** Wallets and handles members may pay on, for one campaign (active and retired). */
function listStorefrontPaymentOptions() {
  return action('listStorefrontPaymentOptions', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id, o.rail::text AS rail, o.token, o.address, o.label, o.active, o.sort,
             (SELECT count(*) FROM storefront.orders so WHERE so.payment_option_id = o.id) AS orders_using
      FROM storefront.campaign_payment_options o
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY o.sort, o.id
    `,
  });
}

export default listStorefrontPaymentOptions;
