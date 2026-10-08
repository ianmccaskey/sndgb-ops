-- A storefront order may only pay on an option that belongs to ITS campaign
-- and matches ITS rail. The storefront resolves options campaign-scoped
-- already; this makes the relationship a database invariant so no retry,
-- bug or stray write can point a campaign-A order at campaign B's wallet.
--
-- Composite FK through a composite unique key: (option id, campaign, rail).
-- A NULL payment_option_id (none chosen yet) is not checked — MATCH SIMPLE.
ALTER TABLE storefront.campaign_payment_options
  ADD CONSTRAINT campaign_payment_options_id_gb_rail_uniq UNIQUE (id, group_buy_id, rail);

ALTER TABLE storefront.orders
  ADD CONSTRAINT orders_option_same_campaign_fk
  FOREIGN KEY (payment_option_id, group_buy_id, payment_rail)
  REFERENCES storefront.campaign_payment_options (id, group_buy_id, rail);
