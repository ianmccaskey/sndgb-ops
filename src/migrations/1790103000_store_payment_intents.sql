-- Store checkout lanes: a payment intent per order per lane, and a webhook
-- event ledger.
--
-- Ian, 2026-11-01: the P² store gets three ways to pay — stablecoins on
-- Ethereum or Solana (on Solana a Solana Pay QR with a per-order reference
-- key, so the server sees the payment without a pasted hash), any coin
-- through NEAR Intents (storefront.near_swaps, which already carries
-- store_order_id, so that lane needs no row here), and a card lane through
-- MoonPay Commerce where the buyer is charged a grossed-up amount so the
-- order's total lands in the vault after the provider's fees: "If product
-- is $100 we want $100. I dont care what fees are involved."
--
-- store_payment_intents: one attempt per lane per order. `reference` is
-- what the chain or the provider reports back (the Solana Pay reference
-- pubkey; the MoonPay charge id), `expected_usd` what must arrive in the
-- wallet, `charge_usd` what the buyer is asked to pay on that lane. The
-- claim an intent produces is the usual storefront.payments row
-- (payment_id), so verification, re-checks, "paid" and the P2 sync are
-- unchanged; the intent only tells the worker where to look.
--
-- webhook_events: provider + event id, inserted before any handling, so a
-- redelivered event is a no-op.

DO $mig$
BEGIN
  CREATE TABLE IF NOT EXISTS storefront.store_payment_intents (
    id             bigserial PRIMARY KEY,
    store_order_id bigint NOT NULL REFERENCES storefront.store_orders(id) ON DELETE CASCADE,
    lane           text NOT NULL CHECK (lane IN ('solana_pay', 'card')),
    reference      text NOT NULL,
    provider_ref   text,
    expected_usd   numeric(12,2) NOT NULL CHECK (expected_usd > 0),
    charge_usd     numeric(12,2) NOT NULL CHECK (charge_usd >= expected_usd),
    status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'detected', 'settled', 'expired', 'failed')),
    payment_id     bigint REFERENCES storefront.payments(id) ON DELETE SET NULL,
    meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lane, reference)
  );
  CREATE INDEX IF NOT EXISTS store_payment_intents_order_idx
    ON storefront.store_payment_intents (store_order_id, lane);
  CREATE INDEX IF NOT EXISTS store_payment_intents_open_idx
    ON storefront.store_payment_intents (lane, status)
    WHERE status IN ('open', 'detected');

  CREATE TABLE IF NOT EXISTS storefront.webhook_events (
    provider     text NOT NULL,
    event_id     text NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    payload      jsonb NOT NULL,
    PRIMARY KEY (provider, event_id)
  );
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103000_store_payment_intents.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103000_store_payment_intents.sql');
