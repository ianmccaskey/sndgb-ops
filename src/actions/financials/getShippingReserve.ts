import { action } from '@uibakery/data';

/**
 * Money the wallets must hold back for shipping before anything counts
 * as stock budget (Ian: fees paid for shipping and insurance must not be
 * allocatable). Reserve = shipping-fee + insurance revenue billed on
 * live orders, minus what shipping has already consumed (label costs +
 * shipping/reship expenses), floored at 0 — once labels are bought the
 * money is spent, not reserved twice.
 * ALL campaigns, like vendor owed: the wallets are one physical pool,
 * so every campaign's unshipped orders lean on the same balance.
 * Components are returned so the UI can show its work.
 */
function getShippingReserve() {
  return action('getShippingReserve', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT fees.shipping_fees_usd,
             fees.insurance_usd,
             spent.label_costs_usd,
             spent.shipping_expenses_usd,
             GREATEST(fees.shipping_fees_usd + fees.insurance_usd
                      - spent.label_costs_usd - spent.shipping_expenses_usd, 0) AS reserve_usd
      FROM (
        SELECT COALESCE(SUM(shipping_fee_revenue_usd), 0) AS shipping_fees_usd,
               COALESCE(SUM(insurance_revenue_usd), 0) AS insurance_usd
        FROM v_group_buy_pnl
      ) fees,
      (
        SELECT COALESCE(SUM(p.label_costs_usd), 0) AS label_costs_usd,
               COALESCE((SELECT SUM(e.total_usd) FROM expenses e
                         WHERE e.category IN ('shipping', 'reship')), 0) AS shipping_expenses_usd
        FROM v_group_buy_pnl p
      ) spent
    `,
  });
}

export default getShippingReserve;
