-- Store orders: the payment destination is chosen on the order page.
--
-- Ian, 2026-11-08: the store's buy form no longer asks "USDC on Ethereum or
-- USDC on Solana" before the order exists. A store order is placed without
-- a destination; on its own page the buyer picks the network (and, where the
-- seller holds more than one stablecoin wallet there, the token), and may
-- change it until money is moving — a live payment claim, an open card
-- checkout or a live swap deposit address fixes it. So payment_rail (with
-- seller_wallet_id, nullable since day one) is nullable until then.
--
-- Money never lands without a destination: every claim is verified against
-- the wallet the order pays, so an order can only leave 'unpaid' with its
-- rail set. The CHECK says so for every writer.
--
-- The store's Solana Pay lane is retired with the same change (the wallet
-- lane and a by-hand send cover Solana). Its open intents are closed here,
-- each with an audit row; historic rows keep their lane value, so the lane
-- CHECK on store_payment_intents stays as it is.

DO $mig$
BEGIN
  ALTER TABLE storefront.store_orders ALTER COLUMN payment_rail DROP NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_orders_destination_before_money') THEN
    ALTER TABLE storefront.store_orders
      ADD CONSTRAINT store_orders_destination_before_money
      CHECK (payment_rail IS NOT NULL OR status IN ('unpaid', 'cancelled'));
  END IF;

  WITH closed AS (
    UPDATE storefront.store_payment_intents
       SET status = 'expired',
           meta = meta || '{"reason":"lane_removed"}'::jsonb,
           updated_at = now()
     WHERE lane = 'solana_pay' AND status IN ('open', 'detected')
    RETURNING id
  )
  INSERT INTO public.audit_log (table_name, row_pk, action, actor, new_data)
  SELECT 'storefront.store_payment_intents', id::text, 'intent_expired', 'migration:1790103400', '{"reason":"lane_removed"}'::jsonb
    FROM closed;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103400_store_destination_chosen_at_checkout.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103400_store_destination_chosen_at_checkout.sql');
