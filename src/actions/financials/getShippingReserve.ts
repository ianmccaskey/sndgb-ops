import { action } from '@uibakery/data';

/**
 * Money the wallets must hold back for shipping before anything counts
 * as stock budget (Ian: fees paid for shipping and insurance must not be
 * allocatable). Reserve = shipping-fee + insurance revenue billed on
 * live orders, minus what shipping has already consumed (label costs +
 * shipping/reship expenses), floored at 0 — once labels are bought the
 * money is spent, not reserved twice.
 * THIS CAMPAIGN ONLY — unlike vendor owed. Per Ian (2026-09-13): each
 * buy's planning treats the wallet as starting from zero, and earlier
 * buys' shipping is settled from cash outside the crypto wallets, so
 * holding their fees back here would double-reserve money that cash
 * already covers. Components are returned so the UI can show its work.
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
        WHERE group_buy_id = {{params.group_buy_id}}::bigint
      ) fees,
      (
        SELECT COALESCE(SUM(p.label_costs_usd), 0) AS label_costs_usd,
               COALESCE((SELECT SUM(e.total_usd) FROM expenses e
                         WHERE e.category IN ('shipping', 'reship')
                           AND e.group_buy_id = {{params.group_buy_id}}::bigint), 0) AS shipping_expenses_usd
        FROM v_group_buy_pnl p
        WHERE p.group_buy_id = {{params.group_buy_id}}::bigint
      ) spent
    `,
  });
}

export default getShippingReserve;
