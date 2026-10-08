import { action } from '@uibakery/data';

/**
 * Add a wallet (eth/sol/base: token + address) or a cash handle (cash:
 * token = ZELLE/VENMO/PAYPAL, address = the handle) members can pay on.
 * Addresses are never edited in place — a wrong one is retired (active =
 * false) and a new row added, so orders keep pointing at what they were
 * told to pay. Duplicate (rail, token, address) is refused by the unique index.
 */
function addStorefrontPaymentOption() {
  return action('addStorefrontPaymentOption', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT {{params.group_buy_id}}::bigint AS group_buy_id,
               {{params.rail}}::payment_rail AS rail,
               upper(btrim({{params.token}}::text)) AS token,
               btrim({{params.address}}::text) AS address,
               NULLIF(btrim({{params.label}}::text), '') AS label,
               COALESCE(NULLIF({{params.sort}}::text, '')::int, 0) AS sort
      )
      INSERT INTO storefront.campaign_payment_options (group_buy_id, rail, token, address, label, active, sort)
      SELECT group_buy_id, rail, token, address, label, true, sort
      FROM inp
      WHERE address <> ''
        -- the token is what members are told to send: an allowlist, never free text
        -- (the same rule is a CHECK on the table, migration 1790100800)
        AND ((rail IN ('eth', 'sol', 'base') AND token IN ('USDC', 'USDT'))
             OR (rail = 'cash' AND token IN ('ZELLE', 'VENMO', 'PAYPAL')))
        AND (rail <> 'eth' AND rail <> 'base' OR address ~ '^0x[0-9a-fA-F]{40}$')
        AND (rail <> 'sol' OR address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
      RETURNING id
    `,
  });
}

export default addStorefrontPaymentOption;
