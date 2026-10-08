-- A payment option's token is what a member is told to send. It is an
-- allowlist, not free text: a mistyped asset published to members sends
-- money onto a rail/asset nobody is watching. Crypto rails take the
-- stablecoins the verifier sums (USDC, USDT); the cash rail takes the P2P
-- method names the receipt form offers.
ALTER TABLE storefront.campaign_payment_options
  DROP CONSTRAINT IF EXISTS campaign_payment_options_token_check;
ALTER TABLE storefront.campaign_payment_options
  ADD CONSTRAINT campaign_payment_options_token_check CHECK (
    (rail IN ('eth', 'sol', 'base') AND token IN ('USDC', 'USDT'))
    OR (rail = 'cash' AND token IN ('ZELLE', 'VENMO', 'PAYPAL'))
  );
