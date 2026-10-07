-- P² Collective storefront (p2collective.app) — customer-facing schema.
--
-- The storefront is "another upstream" to this Ops app: it owns every row in
-- the `storefront` schema and Ops imports storefront orders through the same
-- ParsedOrder → importUpsertOrder pipeline base44 uses (source 'storefront',
-- SQL pull instead of REST). Nothing here is read by the money views; the
-- Ops copy of an order (public.orders) stays the reconciliation truth and
-- the storefront reads fulfilment/recon state back by order_number.
--
-- Identity: Neon Auth owns sign-in; auth_user_id is the Neon Auth user id
-- (uuid). No FK into the managed neon_auth schema on purpose — Neon Auth may
-- rebuild it; storefront.customer_profiles is our own durable mirror.
--
-- Conventions: money NUMERIC(12,2); qty NUMERIC(10,2) with half-kit
-- granularity; enums are schema-local; every table with updated_at uses
-- public.set_updated_at(); audit rows go to public.audit_log.

CREATE SCHEMA IF NOT EXISTS storefront;

DO $$ BEGIN
  CREATE TYPE storefront.identity_provider AS ENUM ('telegram','discord');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.order_status AS ENUM ('unpaid','payment_submitted','paid','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.payment_status AS ENUM ('pending','verified','mismatch','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.seller_kind AS ENUM ('house','individual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.seller_status AS ENUM ('pending','approved','suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.listing_status AS ENUM ('draft','active','sold_out','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.store_order_status AS ENUM ('unpaid','payment_submitted','paid','shipped','delivered','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.poll_status AS ENUM ('draft','open','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE storefront.media_kind AS ENUM ('hero','listing','coa','avatar');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- 1Click status vocabulary, verbatim (GET /v0/status)
  CREATE TYPE storefront.near_swap_status AS ENUM
    ('KNOWN_DEPOSIT_TX','PENDING_DEPOSIT','INCOMPLETE_DEPOSIT','PROCESSING','SUCCESS','REFUNDED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ Media (files live in DO Spaces; this is the index) ============

CREATE TABLE IF NOT EXISTS storefront.media (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_auth_user_id UUID,               -- NULL = admin-uploaded
  kind storefront.media_kind NOT NULL,
  spaces_key TEXT NOT NULL UNIQUE,       -- object key in the p2collective-media bucket
  mime TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Customers ============

CREATE TABLE IF NOT EXISTS storefront.customer_profiles (
  auth_user_id UUID PRIMARY KEY,
  customer_id BIGINT REFERENCES public.customers(id),   -- linked by email on first sign-in
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state_code TEXT,
  postal_code TEXT,                      -- TEXT: leading zeros are data
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_profiles_customer_idx ON storefront.customer_profiles (customer_id);

-- Verified social identities; store/seller access requires at least one.
CREATE TABLE IF NOT EXISTS storefront.customer_identities (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id UUID NOT NULL REFERENCES storefront.customer_profiles(auth_user_id) ON DELETE CASCADE,
  provider storefront.identity_provider NOT NULL,
  provider_user_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw JSONB,
  UNIQUE (provider, provider_user_id),
  UNIQUE (auth_user_id, provider)
);

CREATE TABLE IF NOT EXISTS storefront.customer_wallets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id UUID NOT NULL REFERENCES storefront.customer_profiles(auth_user_id) ON DELETE CASCADE,
  chain TEXT NOT NULL CHECK (chain IN ('eth','sol','base','btc','other')),
  address TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auth_user_id, chain, address)
);

-- ============ Campaign publishing (per public.group_buys row) ============

CREATE TABLE IF NOT EXISTS storefront.campaign_settings (
  group_buy_id BIGINT PRIMARY KEY REFERENCES public.group_buys(id),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,8}$'),   -- 'MB6' → order numbers 2026-MB6-001
  published BOOLEAN NOT NULL DEFAULT false,
  hero_media_id BIGINT REFERENCES storefront.media(id),
  description_md TEXT,
  payment_instructions_md TEXT,
  near_default_rail public.payment_rail,                          -- where NEAR Intents settles (eth|sol|base)
  insurance_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 1.27 CHECK (insurance_rate_pct >= 0),
  next_order_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_order_seq >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (near_default_rail IS NULL OR near_default_rail <> 'cash')
);

CREATE TABLE IF NOT EXISTS storefront.campaign_payment_options (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_id BIGINT NOT NULL REFERENCES storefront.campaign_settings(group_buy_id) ON DELETE CASCADE,
  rail public.payment_rail NOT NULL,
  token TEXT NOT NULL,                   -- 'USDC' | 'USDT' | 'ZELLE' | 'VENMO' | 'PAYPAL'
  address TEXT NOT NULL,                 -- wallet address or P2P handle
  label TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_buy_id, rail, token, address)
);

-- ============ Group-buy orders (customer-owned; Ops imports these) ============

CREATE TABLE IF NOT EXISTS storefront.orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,     -- 'YYYY-<code>-NNN', minted under the campaign lock
  group_buy_id BIGINT NOT NULL REFERENCES storefront.campaign_settings(group_buy_id),
  auth_user_id UUID NOT NULL REFERENCES storefront.customer_profiles(auth_user_id),
  status storefront.order_status NOT NULL DEFAULT 'unpaid',
  -- contact + ship-to snapshot at placement (profile edits never rewrite history)
  contact_name TEXT NOT NULL,
  contact_email CITEXT NOT NULL,
  contact_phone TEXT,
  telegram_username TEXT,
  discord_username TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state_code TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  -- payment choice
  payment_rail public.payment_rail NOT NULL,
  payment_option_id BIGINT REFERENCES storefront.campaign_payment_options(id),
  -- money (all server-computed, integer-cent arithmetic)
  subtotal_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  split_fees_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  admin_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  insurance_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  tip_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  processor_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  customer_note TEXT,
  -- idempotency: the order form mints a token per load; a retried submission
  -- (lost response, double tap) finds its order instead of minting another.
  -- Members may hold several open orders in a buy on purpose (ordering for a
  -- friend, splitting by vendor speed); the storefront asks before a second.
  client_token UUID,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sf_orders_campaign_status_idx ON storefront.orders (group_buy_id, status);
CREATE INDEX IF NOT EXISTS sf_orders_user_idx ON storefront.orders (auth_user_id, placed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sf_orders_client_token_uniq ON storefront.orders (auth_user_id, client_token)
  WHERE client_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS storefront.order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES storefront.orders(id) ON DELETE CASCADE,
  group_buy_product_id BIGINT NOT NULL REFERENCES public.group_buy_products(id),
  qty NUMERIC(10,2) NOT NULL CHECK (qty > 0 AND qty * 2 = floor(qty * 2)),   -- whole or half kits only
  unit_price_usd NUMERIC(12,2) NOT NULL,
  split_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  direct_ship BOOLEAN NOT NULL DEFAULT false,
  product_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, group_buy_product_id)
);
CREATE INDEX IF NOT EXISTS sf_order_items_gbp_idx ON storefront.order_items (group_buy_product_id);

-- ============ Sellers + store ============

CREATE TABLE IF NOT EXISTS storefront.sellers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id UUID UNIQUE REFERENCES storefront.customer_profiles(auth_user_id),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  display_name TEXT NOT NULL,
  kind storefront.seller_kind NOT NULL DEFAULT 'individual',
  fee_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (fee_pct >= 0 AND fee_pct <= 100),
  status storefront.seller_status NOT NULL DEFAULT 'pending',
  bio_md TEXT,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- the house seller (P2) has no storefront login: it is fulfilled in the P² Orders app
  CHECK (kind = 'house' OR auth_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS sellers_one_house ON storefront.sellers ((kind)) WHERE kind = 'house';

CREATE TABLE IF NOT EXISTS storefront.seller_wallets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id BIGINT NOT NULL REFERENCES storefront.sellers(id) ON DELETE CASCADE,
  rail public.payment_rail NOT NULL,
  token TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  is_default_settlement BOOLEAN NOT NULL DEFAULT false,   -- NEAR Intents settles here
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (seller_id, rail, token, address),
  CHECK (NOT is_default_settlement OR rail <> 'cash')
);
CREATE UNIQUE INDEX IF NOT EXISTS seller_wallets_one_default ON storefront.seller_wallets (seller_id) WHERE is_default_settlement;

CREATE TABLE IF NOT EXISTS storefront.coa_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_product_id BIGINT REFERENCES public.group_buy_products(id),
  product_id BIGINT REFERENCES public.products(id),
  lab TEXT,
  report_url TEXT,                       -- lab-hosted link when the lab allows linking
  media_id BIGINT REFERENCES storefront.media(id),   -- uploaded PDF (backup / no-link labs)
  batch_label TEXT,
  tested_at DATE,
  purity_pct NUMERIC(5,2) CHECK (purity_pct IS NULL OR (purity_pct >= 0 AND purity_pct <= 100)),
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (group_buy_product_id IS NOT NULL OR product_id IS NOT NULL),
  CHECK (report_url IS NOT NULL OR media_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS coa_reports_gbp_idx ON storefront.coa_reports (group_buy_product_id);
CREATE INDEX IF NOT EXISTS coa_reports_product_idx ON storefront.coa_reports (product_id);

CREATE TABLE IF NOT EXISTS storefront.store_listings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id BIGINT NOT NULL REFERENCES storefront.sellers(id),
  title TEXT NOT NULL,
  description_md TEXT,
  mass_label TEXT,
  p2_product_id BIGINT,                  -- house listings: products.id in the P² Orders DB (no cross-DB FK)
  price_usd NUMERIC(12,2) NOT NULL CHECK (price_usd >= 0),
  qty_available INTEGER CHECK (qty_available IS NULL OR qty_available >= 0),   -- NULL for house = live from P² inventory
  max_per_order INTEGER CHECK (max_per_order IS NULL OR max_per_order >= 1),
  shipping_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shipping_fee_usd >= 0),
  coa_report_id BIGINT REFERENCES storefront.coa_reports(id),
  status storefront.listing_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (p2_product_id IS NOT NULL OR qty_available IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS store_listings_seller_idx ON storefront.store_listings (seller_id, status);

CREATE TABLE IF NOT EXISTS storefront.listing_media (
  listing_id BIGINT NOT NULL REFERENCES storefront.store_listings(id) ON DELETE CASCADE,
  media_id BIGINT NOT NULL REFERENCES storefront.media(id),
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (listing_id, media_id)
);

CREATE SEQUENCE IF NOT EXISTS storefront.store_order_seq;

CREATE TABLE IF NOT EXISTS storefront.store_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,     -- 'ST-YYYY-NNNN'
  buyer_auth_user_id UUID NOT NULL REFERENCES storefront.customer_profiles(auth_user_id),
  seller_id BIGINT NOT NULL REFERENCES storefront.sellers(id),
  listing_id BIGINT NOT NULL REFERENCES storefront.store_listings(id),
  listing_title_snapshot TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_usd NUMERIC(12,2) NOT NULL,
  subtotal_usd NUMERIC(12,2) NOT NULL,
  shipping_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_usd NUMERIC(12,2) NOT NULL,
  fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,          -- collective fee owed BY the seller (fee_pct snapshot)
  payment_rail public.payment_rail NOT NULL,
  seller_wallet_id BIGINT REFERENCES storefront.seller_wallets(id),
  status storefront.store_order_status NOT NULL DEFAULT 'unpaid',
  contact_name TEXT NOT NULL,
  contact_email CITEXT NOT NULL,
  contact_phone TEXT,
  telegram_username TEXT,
  discord_username TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state_code TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  buyer_note TEXT,
  carrier TEXT,
  tracking_number TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  p2_sales_order_id BIGINT,              -- house orders: sales_orders.id in the P² Orders DB
  p2_sales_order_number TEXT,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_orders_buyer_idx ON storefront.store_orders (buyer_auth_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS store_orders_seller_idx ON storefront.store_orders (seller_id, status);

-- ============ Payments (one table for both order kinds) ============

CREATE TABLE IF NOT EXISTS storefront.payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gb_order_id BIGINT REFERENCES storefront.orders(id) ON DELETE CASCADE,
  store_order_id BIGINT REFERENCES storefront.store_orders(id) ON DELETE CASCADE,
  method public.payment_method NOT NULL,
  rail public.payment_rail NOT NULL,
  tx_hash TEXT,                          -- as submitted; canonical form below
  tx_hash_canonical TEXT GENERATED ALWAYS AS (
    CASE WHEN rail IN ('eth','base') THEN lower(tx_hash) ELSE tx_hash END
  ) STORED,
  receipt_ref TEXT,                      -- Zelle/Venmo/PayPal reference
  amount_claimed_usd NUMERIC(12,2),
  verified_usd NUMERIC(12,2),            -- stablecoin face value seen on-chain, to our wallet
  onchain JSONB,                         -- {token, amount, to, from, block_time, native}
  status storefront.payment_status NOT NULL DEFAULT 'pending',
  verify_error TEXT,
  -- re-verification schedule for claims the chain hasn't confirmed yet:
  -- the worker only picks rows whose next_verify_at has passed (exponential
  -- backoff, 1 min → 1 h), so an outage costs dozens of provider calls, not thousands
  verify_attempts INT NOT NULL DEFAULT 0,
  next_verify_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((gb_order_id IS NULL) <> (store_order_id IS NULL)),
  CHECK (tx_hash IS NOT NULL OR receipt_ref IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sf_payments_gb_order_idx ON storefront.payments (gb_order_id);
CREATE INDEX IF NOT EXISTS sf_payments_store_order_idx ON storefront.payments (store_order_id);
-- one live claim per on-chain tx (rejected rows free the hash, mirroring Ops)
-- Deliberately NOT unique: campaign wallets are shared, so a tx hash carries no
-- proof of which order it pays. Two orders may claim the same hash; Ops
-- reconciliation keeps one and rejects the other. A unique index would let a
-- wrong (or malicious) claim block the real payer.
CREATE INDEX IF NOT EXISTS sf_payments_tx_hash_idx ON storefront.payments (tx_hash_canonical)
  WHERE tx_hash_canonical IS NOT NULL;

CREATE TABLE IF NOT EXISTS storefront.near_swaps (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gb_order_id BIGINT REFERENCES storefront.orders(id) ON DELETE CASCADE,
  store_order_id BIGINT REFERENCES storefront.store_orders(id) ON DELETE CASCADE,
  deposit_address TEXT NOT NULL UNIQUE,
  deposit_memo TEXT,
  origin_asset TEXT NOT NULL,            -- 1Click assetId, e.g. nep141:btc.omft.near
  destination_asset TEXT NOT NULL,
  amount_in TEXT NOT NULL,               -- smallest units (string, per API)
  amount_in_formatted TEXT,
  amount_out_usd NUMERIC(12,2) NOT NULL,
  recipient TEXT NOT NULL,
  refund_to TEXT NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  status storefront.near_swap_status NOT NULL DEFAULT 'PENDING_DEPOSIT',
  quote JSONB NOT NULL,                  -- full quote response (signature included)
  swap_details JSONB,
  settlement_rail public.payment_rail,
  settlement_tx_hash TEXT,
  payment_id BIGINT REFERENCES storefront.payments(id),   -- written on SUCCESS
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((gb_order_id IS NULL) <> (store_order_id IS NULL))
);
CREATE INDEX IF NOT EXISTS near_swaps_pending_idx ON storefront.near_swaps (status, last_polled_at)
  WHERE status IN ('PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','PROCESSING','INCOMPLETE_DEPOSIT');

-- ============ Polls ============

CREATE TABLE IF NOT EXISTS storefront.polls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  description_md TEXT,
  status storefront.poll_status NOT NULL DEFAULT 'draft',
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  max_choices INTEGER NOT NULL DEFAULT 1 CHECK (max_choices >= 1),
  hide_results_until_close BOOLEAN NOT NULL DEFAULT false,
  allow_comments BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS storefront.poll_options (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id BIGINT NOT NULL REFERENCES storefront.polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, poll_id)                   -- lets poll_vote_options pin the option to the vote's poll
);

CREATE TABLE IF NOT EXISTS storefront.poll_votes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id BIGINT NOT NULL REFERENCES storefront.polls(id) ON DELETE CASCADE,
  auth_user_id UUID NOT NULL REFERENCES storefront.customer_profiles(auth_user_id),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (poll_id, auth_user_id),        -- one vote per customer per poll
  UNIQUE (id, poll_id)
);

CREATE TABLE IF NOT EXISTS storefront.poll_vote_options (
  vote_id BIGINT NOT NULL,
  poll_id BIGINT NOT NULL,
  option_id BIGINT NOT NULL,
  PRIMARY KEY (vote_id, option_id),
  FOREIGN KEY (vote_id, poll_id) REFERENCES storefront.poll_votes(id, poll_id) ON DELETE CASCADE,
  FOREIGN KEY (option_id, poll_id) REFERENCES storefront.poll_options(id, poll_id) ON DELETE CASCADE
);

-- max_choices is enforced in the database, not only in the app
CREATE OR REPLACE FUNCTION storefront.enforce_poll_max_choices() RETURNS trigger AS $$
DECLARE v_max INTEGER; v_count INTEGER;
BEGIN
  SELECT max_choices INTO v_max FROM storefront.polls WHERE id = NEW.poll_id;
  SELECT count(*) INTO v_count FROM storefront.poll_vote_options WHERE vote_id = NEW.vote_id;
  IF v_count > v_max THEN
    RAISE EXCEPTION 'poll % allows at most % choice(s)', NEW.poll_id, v_max;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS poll_vote_options_max ON storefront.poll_vote_options;
CREATE CONSTRAINT TRIGGER poll_vote_options_max
  AFTER INSERT ON storefront.poll_vote_options
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION storefront.enforce_poll_max_choices();

-- ============ updated_at triggers ============

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_profiles','campaign_settings','orders','sellers','store_listings','store_orders','payments','near_swaps','polls','poll_votes']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON storefront.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON storefront.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
  END LOOP;
END $$;
