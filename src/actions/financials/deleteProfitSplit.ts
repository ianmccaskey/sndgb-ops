import { action } from '@uibakery/data';

/**
 * Remove a party from a campaign's profit split — for one-off
 * collaborators added to a single buy (Ian/Paige are permanent, but a
 * guest party should not haunt every later view of the campaign).
 * REFUSED (zero rows) when the party has payout-affecting adjustments
 * in this campaign (gb-priced, or personal at-cost stock): those
 * deductions come out of the party's split payout, so deleting the
 * split row would orphan real money attributed to them — delete or
 * reassign the adjustments first, or set the party to 0% instead.
 * CAMPAIGN-SCOPED like every destructive action: the same name in
 * another campaign keeps its row there.
 */
function deleteProfitSplit() {
  return action('deleteProfitSplit', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      DELETE FROM profit_splits ps
      WHERE ps.group_buy_id = {{params.group_buy_id}}::bigint
        AND ps.party = {{params.party}}::text
        AND NOT EXISTS (
          SELECT 1
          FROM admin_adjustments a
          JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
          WHERE gbp.group_buy_id = ps.group_buy_id
            AND a.beneficiary = ps.party
            AND (a.pricing = 'gb' OR (a.pricing = 'cost' AND a.beneficiary <> 'both'))
        )
      RETURNING ps.id
    `,
  });
}

export default deleteProfitSplit;
