import { action } from '@uibakery/data';

/**
 * Retire (or reinstate) a payment option. Retiring hides the address from
 * every unpaid order that was set to pay it and makes the storefront refuse
 * new claims against it — the member is told to ask for the current one.
 *
 * A PUBLISHED campaign must always keep one active option (members could
 * not pay otherwise). The campaign row is locked first so two retirements
 * cannot both see the other option as active; the database keeps the same
 * rule as a constraint trigger (1790100900) for every other writer. Refusal
 * returns no rows (the page says why); the trigger would raise.
 */
function setStorefrontPaymentOptionActive() {
  return action('setStorefrontPaymentOptionActive', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- serializes every option change of this campaign (and publish toggles)
        SELECT cs.group_buy_id, cs.published
        FROM storefront.campaign_settings cs
        WHERE cs.group_buy_id = {{params.group_buy_id}}::bigint
        FOR UPDATE
      )
      UPDATE storefront.campaign_payment_options o
      SET active = ({{params.active}}::text = 'true')
      WHERE o.id = {{params.id}}::bigint
        AND o.group_buy_id = {{params.group_buy_id}}::bigint
        -- scalar dependency: the lock CTE is empty when the campaign was never
        -- set up (nothing published, nothing to protect) and must not suppress the update
        AND (SELECT COUNT(*) FROM lck) >= 0
        AND (
          ({{params.active}}::text = 'true')
          OR NOT COALESCE((SELECT published FROM lck), false)
          OR EXISTS (SELECT 1 FROM storefront.campaign_payment_options o2
                     WHERE o2.group_buy_id = o.group_buy_id AND o2.active AND o2.id <> o.id)
        )
      RETURNING o.id, o.active
    `,
  });
}

export default setStorefrontPaymentOptionActive;
