-- The seller portal: member shops run their store from a UI Bakery app.
--
-- Ian, 2026-11-08. Until now a member seller (Wisco Reserve, El Peppy
-- Joe's, K&K 3D Designs …) managed listings, wallets and fulfilment on the
-- storefront's own /seller dashboard. Sellers now sign in to a separate
-- UI Bakery app, "P2 Seller Portal", and the organizer-run shops (P², PRT,
-- Papa Porgy's Emporium, Paige's) are fulfilled from P2 Collective Orders by
-- Ian and Paige, who already work there. The storefront dashboard stays as
-- a second writer for now; applying to sell leaves the storefront UI.
--
-- TRUST MODEL (settled with the owner 2026-11-08; AGENTS.md "tenant
-- boundary" amended in the same change):
--  * UI Bakery substitutes {{user.email}} SERVER-SIDE in a SQL action; the
--    browser cannot alter it. Every portal action is one statement,
--    `SELECT … FROM storefront.portal_x({{user.email}}, {{params…}})`.
--  * The portal's datasource connects as `p2_seller_portal`, a role with
--    USAGE on schema storefront and EXECUTE on the portal_* functions and
--    NOTHING else — no table, sequence or public-schema privilege. A forged
--    action call can reach only these functions, and each resolves the shop
--    from the email first (portal_resolve_seller → seller_operators).
--  * ONE implementation, TWO entry points: every rule lives in a
--    storefront.shop_*(p_seller_id, p_actor, …) core function, owner-only,
--    which P2 Collective Orders calls directly (it connects as the owner and
--    passes its usual actor). The granted portal_*(p_email, …) functions are
--    thin wrappers that resolve the email and call the core. Both run as the
--    owner (SECURITY DEFINER), so RLS still binds to nothing here.
--  * Identity mapping: storefront.seller_operators — login emails Ian
--    assigns per shop in P2 Collective Orders (one live shop per login).
--    A shop flagged managed_in_ops has no portal login at all.
--
-- WHAT A SELLER CAN DO (the storefront's lib/sellers/rules.ts +
-- mutations.ts, ported here so both writers enforce the same rules):
-- orders (mark shipped with carrier + tracking, fix tracking, mark
-- delivered), Shippo labels on the SELLER'S OWN Shippo key (draft row first,
-- then the money POST, then the label is recorded and the order shipped in
-- one call; void returns the order to paid only while its tracking is that
-- label's), listings + stock (compare-and-set), payout wallets, ship-from
-- address. Never: branding (storefront dashboard), cancel/refund of an
-- order (organizers), the buyer's email (never selected), the ship-to
-- outside its 30-day window.
--
-- store_orders.carrier/tracking_number/shipped_at/status stay the
-- buyer-facing truth (the storefront order page reads them);
-- store_shipments is the label ledger, written in the same call.
--
-- Locks: seller row FOR NO KEY UPDATE (serialises with the storefront
-- dashboard's FOR UPDATE and other portal writes, but not with checkout's
-- FK KEY SHARE on the seller, so no deadlock cycle with lib/store/place.ts),
-- then the listing / order / wallet FOR UPDATE, then the live shipment.
-- Every refusal RAISEs a plain-English sentence (insufficient_privilege for
-- identity, invalid_parameter_value + HINT 'field:<name>' for input,
-- no_data_found for "not yours / reload", object_not_in_prerequisite_state
-- for stale state and compare-and-set misses). Audit rows go to
-- public.audit_log with camelCase payloads like the storefront's and never
-- carry contact_email, the ship-to, a label URL or a Shippo key.
--
-- LOGIN and the password of p2_seller_portal are NOT set here (no secret
-- in git): the operator runs `ALTER ROLE p2_seller_portal LOGIN PASSWORD
-- '…'` once, out of band, and puts the connection string in the portal's
-- UI Bakery datasource "P2 Seller Portal DB".
--
-- Fully transactional (no ALTER TYPE … ADD VALUE, no CONCURRENTLY): probe
-- it inside BEGIN … ROLLBACK. Idempotent: tables and types are guarded,
-- functions are dropped and recreated with their grants.

-- ── 0. the applier must be the database owner (function ownership IS the model)
DO $mig$
BEGIN
  IF (SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = current_database()) <> current_user THEN
    RAISE EXCEPTION '1790103600 must be applied as the database owner (the portal functions must be owned by it)';
  END IF;
END
$mig$;

-- ── 1. sellers.managed_in_ops ──────────────────────────────────────────────
ALTER TABLE storefront.sellers ADD COLUMN IF NOT EXISTS managed_in_ops boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN storefront.sellers.managed_in_ops IS
  'Run from P2 Collective Orders by the organizers (P², PRT, Papa Porgy''s, Paige''s): no portal login; its orders are fulfilled there through storefront.shop_*.';

-- the house is always organizer-run; Papa Porgy''s is Ian''s own shop
UPDATE storefront.sellers SET managed_in_ops = true
 WHERE (kind = 'house' OR slug = 'papa-porgy-s-emporium') AND NOT managed_in_ops;

DO $mig$ BEGIN
  ALTER TABLE storefront.sellers ADD CONSTRAINT sellers_house_is_managed
    CHECK (kind <> 'house' OR managed_in_ops);
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

-- ── 2. seller_operators: which logins run which shop ───────────────────────
CREATE TABLE IF NOT EXISTS storefront.seller_operators (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id    bigint NOT NULL REFERENCES storefront.sellers(id) ON DELETE CASCADE,
  email        text NOT NULL,
  added_by     text NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   text,
  last_seen_at timestamptz,
  CONSTRAINT seller_operators_email_shape CHECK (
    email = lower(btrim(email)) AND char_length(email) <= 254
    AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT seller_operators_revoked_by CHECK (
    revoked_at IS NULL OR (revoked_by IS NOT NULL AND btrim(revoked_by) <> ''))
);
COMMENT ON TABLE storefront.seller_operators IS
  'UI Bakery logins that may run a member shop in the P2 Seller Portal. Written by P2 Collective Orders (owner); read by portal_resolve_seller. One live shop per login.';

-- one LIVE shop per login; revoked rows stay as history and the email may be reassigned
CREATE UNIQUE INDEX IF NOT EXISTS seller_operators_live_email_uniq
  ON storefront.seller_operators (lower(email)) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS seller_operators_seller_idx
  ON storefront.seller_operators (seller_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION storefront.seller_operators_normalize() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_kind storefront.seller_kind; v_managed boolean;
BEGIN
  NEW.email := lower(btrim(NEW.email));
  -- a live operator row needs a shop a portal login may run: an individual
  -- seller not run from P2 Collective Orders. Revoking stays allowed whatever
  -- the shop became, so a flag flipped later never strands a row.
  IF TG_OP = 'INSERT' OR NEW.revoked_at IS NULL THEN
    SELECT s.kind, s.managed_in_ops INTO v_kind, v_managed FROM storefront.sellers s WHERE s.id = NEW.seller_id;
    IF v_kind IS NULL THEN
      RAISE EXCEPTION 'That shop no longer exists.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_kind <> 'individual' OR v_managed THEN
      RAISE EXCEPTION 'This shop is run from P2 Collective Orders and has no portal login.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS seller_operators_normalize ON storefront.seller_operators;
CREATE TRIGGER seller_operators_normalize
  BEFORE INSERT OR UPDATE ON storefront.seller_operators
  FOR EACH ROW EXECUTE FUNCTION storefront.seller_operators_normalize();

-- ── 3. seller_ship_from: the shop's return address + its own Shippo key ───
CREATE TABLE IF NOT EXISTS storefront.seller_ship_from (
  seller_id         bigint PRIMARY KEY REFERENCES storefront.sellers(id) ON DELETE CASCADE,
  name              text NOT NULL,
  company           text,
  street1           text NOT NULL,
  street2           text,
  city              text NOT NULL,
  state             text NOT NULL,
  zip               text NOT NULL,
  country           text NOT NULL DEFAULT 'US',
  phone             text NOT NULL,
  email             text NOT NULL,
  shippo_api_key    text,
  shippo_key_set_at timestamptz,
  shippo_key_set_by text,
  updated_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_ship_from_lengths CHECK (
    char_length(name) BETWEEN 1 AND 80 AND (company IS NULL OR char_length(company) <= 80)
    AND char_length(street1) BETWEEN 1 AND 100 AND (street2 IS NULL OR char_length(street2) <= 100)
    AND char_length(city) BETWEEN 1 AND 60),
  CONSTRAINT seller_ship_from_country CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT seller_ship_from_us_shape CHECK (
    country <> 'US' OR (state ~ '^[A-Z]{2}$' AND zip ~ '^[0-9]{5}(-[0-9]{4})?$')),
  CONSTRAINT seller_ship_from_phone CHECK (phone ~ '^\+?[0-9]{10,15}$'),
  CONSTRAINT seller_ship_from_email CHECK (
    email = lower(btrim(email)) AND char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT seller_ship_from_key_shape CHECK (
    shippo_api_key IS NULL OR shippo_api_key ~ '^shippo_(live|test)_[A-Za-z0-9]{20,64}$')
);
COMMENT ON TABLE storefront.seller_ship_from IS
  'A shop''s Shippo from-address and its OWN Shippo API key (plaintext like the Moralis/Helius keys in app_settings; returned only to that shop''s own session, never audited beyond mode + last 4).';
DROP TRIGGER IF EXISTS seller_ship_from_updated_at ON storefront.seller_ship_from;
CREATE TRIGGER seller_ship_from_updated_at
  BEFORE UPDATE ON storefront.seller_ship_from
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 4. store_shipments: the label ledger ───────────────────────────────────
-- lets a shipment's (order, seller) pair be a real FK, so a shipment can never
-- belong to another shop's order
CREATE UNIQUE INDEX IF NOT EXISTS store_orders_id_seller_uniq ON storefront.store_orders (id, seller_id);

CREATE TABLE IF NOT EXISTS storefront.store_shipments (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_order_id        bigint NOT NULL,
  seller_id             bigint NOT NULL,
  source                text NOT NULL CHECK (source IN ('manual', 'shippo')),
  carrier               text CHECK (carrier IN ('USPS', 'UPS', 'FedEx', 'DHL', 'Other')),
  servicelevel          text CHECK (servicelevel IS NULL OR char_length(servicelevel) <= 80),
  tracking_number       text CHECK (tracking_number IS NULL OR tracking_number ~ '^[A-Z0-9]{8,40}$'),
  shippo_rate_id        text CHECK (shippo_rate_id IS NULL OR shippo_rate_id ~ '^[0-9a-f]{32}$'),
  rate_amount           numeric(12,2) CHECK (rate_amount IS NULL OR rate_amount BETWEEN 0 AND 1000),
  shippo_transaction_id text CHECK (shippo_transaction_id IS NULL OR shippo_transaction_id ~ '^[0-9a-f]{32}$'),
  label_url             text CHECK (label_url IS NULL OR (label_url ~ '^https://' AND char_length(label_url) <= 1000)),
  label_cost_usd        numeric(12,2) CHECK (label_cost_usd IS NULL OR label_cost_usd BETWEEN 0 AND 1000),
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  purchase_started_at   timestamptz,
  -- the Shippo account the purchase was started on: sha256 of the shop's key
  -- at begin_label and its last 4, so a recovery proof ("no transaction for
  -- this rate") is only trusted while the shop still holds THAT key
  key_fingerprint       text,
  key_last4             text,
  recorded_at           timestamptz,
  cancelled_at          timestamptz,
  cancelled_by          text,
  cancel_reason         text,
  refund_status         text CHECK (refund_status IS NULL OR refund_status IN ('requested', 'success', 'error', 'unavailable', 'not_applicable')),
  refund_object_id      text CHECK (refund_object_id IS NULL OR refund_object_id ~ '^[0-9a-f]{32}$'),
  refund_note           text,
  refund_recorded_at    timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  status                text GENERATED ALWAYS AS (
                          CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled'
                               WHEN recorded_at IS NULL THEN 'draft'
                               ELSE 'recorded' END) STORED,
  CONSTRAINT store_shipments_order_fk FOREIGN KEY (store_order_id, seller_id)
    REFERENCES storefront.store_orders (id, seller_id),
  -- manual: carrier + tracking recorded at insert, nothing from Shippo.
  -- shippo draft: a rate (and its carrier/amount) but no label yet.
  -- shippo recorded: the label — transaction, tracking, url, cost.
  CONSTRAINT store_shipments_shape CHECK (
    CASE source
      WHEN 'manual' THEN recorded_at IS NOT NULL AND carrier IS NOT NULL AND tracking_number IS NOT NULL
                         AND shippo_rate_id IS NULL AND shippo_transaction_id IS NULL AND label_url IS NULL
                         AND rate_amount IS NULL AND label_cost_usd IS NULL
      ELSE shippo_rate_id IS NOT NULL AND carrier IS NOT NULL AND rate_amount IS NOT NULL
           AND (recorded_at IS NULL) = (shippo_transaction_id IS NULL)
           AND (recorded_at IS NULL) = (tracking_number IS NULL)
           AND (recorded_at IS NULL) = (label_url IS NULL)
           AND (recorded_at IS NULL) = (label_cost_usd IS NULL)
    END),
  CONSTRAINT store_shipments_cancel_shape CHECK (
    cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND btrim(cancelled_by) <> '' AND cancel_reason IS NOT NULL AND btrim(cancel_reason) <> '')),
  CONSTRAINT store_shipments_refund_shape CHECK (
    refund_status IS NULL OR cancelled_at IS NOT NULL),
  CONSTRAINT store_shipments_manual_refund CHECK (
    source <> 'manual' OR refund_status IS NULL OR refund_status = 'not_applicable')
);
COMMENT ON TABLE storefront.store_shipments IS
  'What a shop recorded for a store order: a manual carrier+tracking, or a Shippo label (a draft row BEFORE the money POST, recorded after). store_orders stays the buyer-facing truth. One live (uncancelled) row per order. A cancelled, recorded Shippo row with refund_status NULL is a late label whose refund has not been requested yet.';

ALTER TABLE storefront.store_shipments ADD COLUMN IF NOT EXISTS key_fingerprint text;
ALTER TABLE storefront.store_shipments ADD COLUMN IF NOT EXISTS key_last4 text;

-- drafts count: two operators cannot buy two labels for one order
CREATE UNIQUE INDEX IF NOT EXISTS store_shipments_one_live ON storefront.store_shipments (store_order_id) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS store_shipments_txn_uniq ON storefront.store_shipments (shippo_transaction_id) WHERE shippo_transaction_id IS NOT NULL;
-- a Shippo rate belongs to one shipment object; a discarded draft's rate is never reused (the app re-rates)
CREATE UNIQUE INDEX IF NOT EXISTS store_shipments_rate_uniq ON storefront.store_shipments (shippo_rate_id) WHERE shippo_rate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_shipments_seller_idx ON storefront.store_shipments (seller_id, created_at DESC);

DROP TRIGGER IF EXISTS store_shipments_updated_at ON storefront.store_shipments;
CREATE TRIGGER store_shipments_updated_at
  BEFORE UPDATE ON storefront.store_shipments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- once cancelled only the refund columns move; a recorded label never changes; a cancel never clears
CREATE OR REPLACE FUNCTION storefront.store_shipments_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_late boolean;
BEGIN
  IF OLD.cancelled_at IS NOT NULL THEN
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
      RAISE EXCEPTION 'shipment % cancel record is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    -- the one allowed fill: a late Shippo label landing on a discarded draft
    -- (shop_record_label) — its label columns and recorded_at, once
    v_late := OLD.source = 'shippo' AND OLD.recorded_at IS NULL AND NEW.recorded_at IS NOT NULL;
    IF NEW.source IS DISTINCT FROM OLD.source OR NEW.servicelevel IS DISTINCT FROM OLD.servicelevel
       OR NEW.shippo_rate_id IS DISTINCT FROM OLD.shippo_rate_id OR NEW.rate_amount IS DISTINCT FROM OLD.rate_amount
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.purchase_started_at IS DISTINCT FROM OLD.purchase_started_at
       OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint OR NEW.key_last4 IS DISTINCT FROM OLD.key_last4
       OR NEW.store_order_id IS DISTINCT FROM OLD.store_order_id OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
       OR (NOT v_late AND (NEW.carrier IS DISTINCT FROM OLD.carrier OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
           OR NEW.shippo_transaction_id IS DISTINCT FROM OLD.shippo_transaction_id OR NEW.label_url IS DISTINCT FROM OLD.label_url
           OR NEW.label_cost_usd IS DISTINCT FROM OLD.label_cost_usd OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at)) THEN
      RAISE EXCEPTION 'shipment % was cancelled — only its refund outcome may change', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.recorded_at IS NOT NULL AND NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'shipment % is recorded; that stamp never moves', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.recorded_at IS NOT NULL AND OLD.source = 'shippo' AND NEW.cancelled_at IS NULL AND (
       NEW.tracking_number IS DISTINCT FROM OLD.tracking_number OR NEW.shippo_transaction_id IS DISTINCT FROM OLD.shippo_transaction_id
       OR NEW.label_url IS DISTINCT FROM OLD.label_url OR NEW.label_cost_usd IS DISTINCT FROM OLD.label_cost_usd) THEN
    RAISE EXCEPTION 'shipment % is a recorded label; void it instead of editing it', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS store_shipments_immutable ON storefront.store_shipments;
CREATE TRIGGER store_shipments_immutable
  BEFORE UPDATE ON storefront.store_shipments
  FOR EACH ROW EXECUTE FUNCTION storefront.store_shipments_immutable();

-- ── 5. the portal role ─────────────────────────────────────────────────────
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_seller_portal') THEN
    CREATE ROLE p2_seller_portal NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;
  END IF;
END
$mig$;
ALTER ROLE p2_seller_portal CONNECTION LIMIT 10;
ALTER ROLE p2_seller_portal SET statement_timeout = '15s';
ALTER ROLE p2_seller_portal SET idle_in_transaction_session_timeout = '30s';
GRANT CONNECT ON DATABASE neondb TO p2_seller_portal;
GRANT USAGE ON SCHEMA storefront TO p2_seller_portal;
-- no table, sequence or public-schema grants and no default privileges: the
-- role reaches rows only through the portal_* functions granted below

-- ── 6. row types shared by core and wrapper ────────────────────────────────
-- dropped and recreated on every apply (every dependent function is recreated
-- below), so a later shape change needs no hand-written ALTER TYPE
DROP TYPE IF EXISTS storefront.shop_me_row CASCADE;
CREATE TYPE storefront.shop_me_row AS (
    seller_id bigint, slug text, display_name text, seller_status text, fee_pct numeric, managed_in_ops boolean,
    wallet_count int, has_default_wallet boolean, ship_from_complete boolean,
    has_shippo_key boolean, shippo_key_last4 text, shippo_key_is_test boolean, to_ship int);

DROP TYPE IF EXISTS storefront.shop_counts_row CASCADE;
CREATE TYPE storefront.shop_counts_row AS (
    awaiting_payment int, to_ship int, label_in_progress int, in_transit int, delivered int, cancelled int, total int);

DROP TYPE IF EXISTS storefront.shop_order_row CASCADE;
CREATE TYPE storefront.shop_order_row AS (
    id bigint, order_number text, listing_id bigint, listing_title text, qty int,
    unit_price_usd numeric, shipping_fee_usd numeric, total_usd numeric, fee_usd numeric, payment_rail text,
    status text, telegram_username text, discord_username text, buyer_note text,
    ship_to_visible boolean, ship_name text, ship_phone text, ship_line1 text, ship_line2 text,
    ship_city text, ship_state text, ship_postal text,
    carrier text, tracking_number text, shipped_at timestamptz, delivered_at timestamptz, paid_at timestamptz,
    created_at timestamptz, live_shipment_id bigint, live_shipment_source text, live_shipment_status text);

DROP TYPE IF EXISTS storefront.shop_shipment_row CASCADE;
CREATE TYPE storefront.shop_shipment_row AS (
    id bigint, store_order_id bigint, source text, status text, carrier text, servicelevel text, tracking_number text,
    rate_amount numeric, label_url text, label_cost_usd numeric, shippo_rate_id text, shippo_transaction_id text,
    created_by text, created_at timestamptz, recorded_at timestamptz, cancelled_at timestamptz, cancelled_by text,
    cancel_reason text, refund_status text, refund_object_id text, refund_note text, refund_recorded_at timestamptz, is_live boolean,
    key_last4 text, key_matches_current boolean);

DROP TYPE IF EXISTS storefront.shop_order_result CASCADE;
CREATE TYPE storefront.shop_order_result AS (
    order_id bigint, order_number text, order_status text, corrected boolean, shipment_id bigint, message text);

DROP TYPE IF EXISTS storefront.shop_label_begin_result CASCADE;
CREATE TYPE storefront.shop_label_begin_result AS (shipment_id bigint, created_at timestamptz, message text);

DROP TYPE IF EXISTS storefront.shop_label_result CASCADE;
CREATE TYPE storefront.shop_label_result AS (
    shipment_id bigint, order_id bigint, order_number text, order_status text, order_updated boolean,
    recorded_at timestamptz, message text);

DROP TYPE IF EXISTS storefront.shop_void_result CASCADE;
CREATE TYPE storefront.shop_void_result AS (
    shipment_id bigint, order_id bigint, shipment_status text, order_reset boolean, order_status text, refund_status text, message text);

DROP TYPE IF EXISTS storefront.shop_refund_result CASCADE;
CREATE TYPE storefront.shop_refund_result AS (shipment_id bigint, refund_status text, message text);

DROP TYPE IF EXISTS storefront.shop_listing_row CASCADE;
CREATE TYPE storefront.shop_listing_row AS (
    id bigint, title text, description_md text, mass_label text, price_usd numeric, shipping_fee_usd numeric,
    qty_available int, max_per_order int, status text, effective_status text, organizer_managed boolean,
    created_at timestamptz, updated_at timestamptz);

DROP TYPE IF EXISTS storefront.shop_listing_result CASCADE;
CREATE TYPE storefront.shop_listing_result AS (listing_id bigint, status text, qty_available int, message text);

DROP TYPE IF EXISTS storefront.shop_wallet_row CASCADE;
CREATE TYPE storefront.shop_wallet_row AS (
    id bigint, rail text, token text, address text, label text, is_default boolean, can_be_default boolean,
    removal_block text, created_at timestamptz);

DROP TYPE IF EXISTS storefront.shop_wallet_result CASCADE;
CREATE TYPE storefront.shop_wallet_result AS (wallet_id bigint, is_default boolean, restored boolean, previous_default_id bigint, message text);

DROP TYPE IF EXISTS storefront.shop_ship_from_row CASCADE;
CREATE TYPE storefront.shop_ship_from_row AS (
    name text, company text, street1 text, street2 text, city text, state text, zip text, country text,
    phone text, email text, complete boolean, has_shippo_key boolean, shippo_key_last4 text, shippo_key_is_test boolean,
    updated_at timestamptz, message text);

DROP TYPE IF EXISTS storefront.shop_key_row CASCADE;
CREATE TYPE storefront.shop_key_row AS (shippo_api_key text);

-- ── 7. private helpers (owner-only; run as the owner inside the entry points)
DROP FUNCTION IF EXISTS storefront.portal_resolve_seller(text);
CREATE FUNCTION storefront.portal_resolve_seller(p_email text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_email text := lower(btrim(COALESCE(p_email, ''))); v_id bigint;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'not an approved seller operator' USING ERRCODE = 'insufficient_privilege',
      HINT = 'This login carries no email. Sign out and in again.';
  END IF;
  SELECT s.id INTO v_id
    FROM storefront.seller_operators o
    JOIN storefront.sellers s ON s.id = o.seller_id
   WHERE lower(o.email) = v_email AND o.revoked_at IS NULL
     AND s.kind = 'individual' AND s.status = 'approved' AND NOT s.managed_in_ops;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not an approved seller operator' USING ERRCODE = 'insufficient_privilege',
      HINT = 'Ask the organizers to add this exact login email to your shop.';
  END IF;
  RETURN v_id;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.portal_resolve_seller(text) FROM PUBLIC;

DROP FUNCTION IF EXISTS storefront.portal_actor(text);
CREATE FUNCTION storefront.portal_actor(p_email text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$ SELECT lower(btrim(COALESCE(p_email, ''))) || ' (seller portal)' $fn$;
REVOKE EXECUTE ON FUNCTION storefront.portal_actor(text) FROM PUBLIC;

-- the seller row lock every write takes first (NO KEY UPDATE: see the header)
DROP FUNCTION IF EXISTS storefront.shop_lock_seller(bigint);
CREATE FUNCTION storefront.shop_lock_seller(p_seller_id bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_kind storefront.seller_kind; v_status storefront.seller_status;
BEGIN
  SELECT s.kind, s.status INTO v_kind, v_status FROM storefront.sellers s WHERE s.id = p_seller_id FOR NO KEY UPDATE;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'That shop no longer exists. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_kind <> 'individual' THEN
    RAISE EXCEPTION 'The P² house stock is shipped from the warehouse flow, not here.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_status = 'pending' THEN
    RAISE EXCEPTION 'This shop is not approved yet.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'This shop is paused. Message the organizers.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_lock_seller(bigint) FROM PUBLIC;

-- "123" → 123; anything else is a stale or forged id
DROP FUNCTION IF EXISTS storefront.shop_parse_id(text, text);
CREATE FUNCTION storefront.shop_parse_id(p_raw text, p_what text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF COALESCE(btrim(p_raw), '') !~ '^[1-9][0-9]{0,17}$' THEN
    RAISE EXCEPTION 'That % isn''t on your list. Reload the page.', p_what USING ERRCODE = 'no_data_found';
  END IF;
  RETURN btrim(p_raw)::bigint;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_parse_id(text, text) FROM PUBLIC;

-- "$1,234.50", "12", ".50" → numeric(12,2); shape is checked before the cast
-- (house rule). Blank is 0 when allowed, otherwise refused with the field's message.
DROP FUNCTION IF EXISTS storefront.shop_parse_usd(text, text, boolean, boolean, numeric, text, text);
CREATE FUNCTION storefront.shop_parse_usd(p_raw text, p_field text, p_blank_is_zero boolean, p_zero_ok boolean, p_max numeric, p_shape_msg text, p_range_msg text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE s text := regexp_replace(btrim(COALESCE(p_raw, '')), '^\$\s*', ''); v numeric;
BEGIN
  IF s = '' THEN
    IF p_blank_is_zero THEN RETURN 0; END IF;
    RAISE EXCEPTION '%', p_shape_msg USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  -- the storefront's parseUsdCents: thousands commas only in their places
  -- ("1,234.50"), at most two decimals; "12,50" is a mistake, not $1,250
  IF s !~ '^(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})?(?:\.[0-9]{1,2})?$' OR s !~ '[0-9]' THEN
    RAISE EXCEPTION '%', p_shape_msg USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  s := replace(s, ',', '');
  IF char_length(split_part(s, '.', 1)) > 10 THEN
    RAISE EXCEPTION '%', p_shape_msg USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  v := ('0' || s)::numeric;
  IF (v <= 0 AND NOT p_zero_ok) OR v > p_max THEN
    RAISE EXCEPTION '%', p_range_msg USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  RETURN round(v, 2);
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_parse_usd(text, text, boolean, boolean, numeric, text, text) FROM PUBLIC;

DROP FUNCTION IF EXISTS storefront.shop_parse_stock(text, text);
CREATE FUNCTION storefront.shop_parse_stock(p_raw text, p_field text) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE s text := btrim(COALESCE(p_raw, ''));
BEGIN
  IF s = '' THEN
    RAISE EXCEPTION 'Enter how many you have on hand (0 is fine).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  IF s !~ '^[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'Stock is a whole number, 0 or more.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  IF s::int > 100000 THEN
    RAISE EXCEPTION 'Stock must be 100,000 or less.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:' || p_field;
  END IF;
  RETURN s::int;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_parse_stock(text, text) FROM PUBLIC;

-- the storefront's shipToVisible: from Paid until 30 days after shipping
-- (or delivery when no ship date), never before payment, never cancelled
DROP FUNCTION IF EXISTS storefront.shop_ship_to_visible(storefront.store_order_status, timestamptz, timestamptz);
CREATE FUNCTION storefront.shop_ship_to_visible(p_status storefront.store_order_status, p_shipped_at timestamptz, p_delivered_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN p_status = 'paid' THEN true
    WHEN p_status NOT IN ('shipped', 'delivered') THEN false
    WHEN COALESCE(p_shipped_at, p_delivered_at) IS NULL THEN p_status = 'shipped'
    ELSE now() - COALESCE(p_shipped_at, p_delivered_at) < interval '30 days' END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_ship_to_visible(storefront.store_order_status, timestamptz, timestamptz) FROM PUBLIC;

DROP FUNCTION IF EXISTS storefront.shop_has_wallet(bigint);
CREATE FUNCTION storefront.shop_has_wallet(p_seller_id bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM storefront.seller_wallets w WHERE w.seller_id = p_seller_id AND w.active AND w.rail <> 'cash')
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_has_wallet(bigint) FROM PUBLIC;

-- sha256 of the shop's current Shippo key (NULL when none); compared with the
-- fingerprint a draft stored at begin_label
DROP FUNCTION IF EXISTS storefront.shop_key_fingerprint(bigint);
CREATE FUNCTION storefront.shop_key_fingerprint(p_seller_id bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT encode(sha256(convert_to(f.shippo_api_key, 'UTF8')), 'hex') FROM storefront.seller_ship_from f WHERE f.seller_id = p_seller_id AND f.shippo_api_key IS NOT NULL
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_key_fingerprint(bigint) FROM PUBLIC;

-- the storefront's walletRemovalBlock, in order: orders waiting to pay this
-- wallet → the last wallet behind live listings → a default another USDC
-- wallet could take over. NULL = may be removed.
DROP FUNCTION IF EXISTS storefront.shop_wallet_removal_block(bigint, bigint);
CREATE FUNCTION storefront.shop_wallet_removal_block(p_seller_id bigint, p_wallet_id bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_open int; v_others int; v_other_usdc int; v_live int; v_is_default boolean;
BEGIN
  SELECT w.is_default_settlement INTO v_is_default FROM storefront.seller_wallets w WHERE w.id = p_wallet_id AND w.seller_id = p_seller_id AND w.active;
  IF v_is_default IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_open FROM storefront.store_orders o
   WHERE o.seller_id = p_seller_id AND o.seller_wallet_id = p_wallet_id AND o.status IN ('unpaid', 'payment_submitted');
  IF v_open > 0 THEN
    RETURN CASE WHEN v_open = 1 THEN 'An order waiting on payment is' ELSE v_open || ' orders waiting on payment are' END
      || ' set to pay this wallet. Remove it once they''re paid or cancelled — or message the organizers if the wallet is compromised.';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE w.token = 'USDC') INTO v_others, v_other_usdc
    FROM storefront.seller_wallets w WHERE w.seller_id = p_seller_id AND w.active AND w.rail <> 'cash' AND w.id <> p_wallet_id;
  SELECT count(*) INTO v_live FROM storefront.store_listings l WHERE l.seller_id = p_seller_id AND l.status IN ('active', 'sold_out');
  IF v_others = 0 AND v_live > 0 THEN
    RETURN 'Buyers need a wallet to pay you. Move your live listings to draft or archive them first, or add another wallet.';
  END IF;
  IF v_is_default AND v_other_usdc > 0 THEN
    RETURN 'This is your default wallet. Make another USDC wallet the default first, then remove this one.';
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_wallet_removal_block(bigint, bigint) FROM PUBLIC;

-- the listing form, validated with the storefront's limits and messages
DROP FUNCTION IF EXISTS storefront.shop_check_listing(text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_check_listing(p_title text, p_mass_label text, p_description_md text, p_price_usd text, p_shipping_usd text, p_qty text, p_status text)
RETURNS TABLE (title text, mass_label text, description_md text, price_usd numeric, shipping_fee_usd numeric, qty int, requested text)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE v_title text := btrim(COALESCE(p_title, '')); v_mass text := NULLIF(btrim(COALESCE(p_mass_label, '')), '');
        v_desc text := NULLIF(btrim(COALESCE(p_description_md, '')), ''); v_status text := lower(btrim(COALESCE(p_status, '')));
BEGIN
  IF char_length(v_title) < 3 OR char_length(v_title) > 120 THEN
    RAISE EXCEPTION 'Give the listing a title of 3 to 120 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:title';
  END IF;
  IF v_mass IS NOT NULL AND char_length(v_mass) > 40 THEN
    RAISE EXCEPTION 'Keep the size label to 40 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:massLabel';
  END IF;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 4000 THEN
    RAISE EXCEPTION 'Keep the description under 4,000 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:descriptionMd';
  END IF;
  IF v_status NOT IN ('draft', 'active', 'archived') THEN
    RAISE EXCEPTION 'Pick draft, active or archived.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:status';
  END IF;
  RETURN QUERY SELECT v_title, v_mass, v_desc,
    storefront.shop_parse_usd(p_price_usd, 'price', false, false, 100000,
      CASE WHEN btrim(COALESCE(p_price_usd, '')) = '' THEN 'Enter a price in USD.' ELSE 'Enter the price as dollars and cents, like 45 or 45.50.' END,
      CASE WHEN regexp_replace(COALESCE(p_price_usd, ''), '[$,\s]', '', 'g') ~ '^0+(\.0{1,2})?$|^\.0{1,2}$' THEN 'Price must be more than $0.' ELSE 'Price must be under $100,000. Check the decimal point.' END),
    storefront.shop_parse_usd(p_shipping_usd, 'shipping', true, true, 1000,
      'Enter shipping as dollars and cents, like 8 or 8.50 — or 0 for free.', 'Shipping must be $1,000 or less.'),
    storefront.shop_parse_stock(p_qty, 'qty'),
    v_status;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_check_listing(text, text, text, text, text, text, text) FROM PUBLIC;

-- resolveListingStatus: active needs a wallet (buyers pay the seller directly) and reads sold out at zero stock
DROP FUNCTION IF EXISTS storefront.shop_resolve_listing_status(text, int, boolean);
CREATE FUNCTION storefront.shop_resolve_listing_status(p_requested text, p_qty int, p_has_wallet boolean) RETURNS storefront.listing_status
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF p_requested <> 'active' THEN RETURN p_requested::storefront.listing_status; END IF;
  IF NOT p_has_wallet THEN
    RAISE EXCEPTION 'Add a payout wallet before you list — buyers pay you there.' USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:status';
  END IF;
  RETURN CASE WHEN p_qty > 0 THEN 'active' ELSE 'sold_out' END::storefront.listing_status;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_resolve_listing_status(text, int, boolean) FROM PUBLIC;

DROP FUNCTION IF EXISTS storefront.shop_check_tracking(text, text);
CREATE FUNCTION storefront.shop_check_tracking(p_carrier text, p_tracking text, OUT carrier text, OUT tracking text)
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  carrier := btrim(COALESCE(p_carrier, ''));
  tracking := upper(regexp_replace(COALESCE(p_tracking, ''), '[\s-]+', '', 'g'));
  IF carrier NOT IN ('USPS', 'UPS', 'FedEx', 'DHL', 'Other') THEN
    RAISE EXCEPTION 'Pick the carrier.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:carrier';
  END IF;
  IF tracking = '' THEN
    RAISE EXCEPTION 'Enter the tracking number from your label.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:trackingNumber';
  END IF;
  IF tracking !~ '^[A-Z0-9]{8,40}$' THEN
    RAISE EXCEPTION 'A tracking number is 8–40 letters and numbers. Copy it again from your label.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:trackingNumber';
  END IF;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_check_tracking(text, text) FROM PUBLIC;

DROP FUNCTION IF EXISTS storefront.shop_audit(text, bigint, text, text, jsonb, jsonb);
CREATE FUNCTION storefront.shop_audit(p_table text, p_row_pk bigint, p_action text, p_actor text, p_old jsonb, p_new jsonb) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES (p_table, p_row_pk::text, p_action, COALESCE(NULLIF(btrim(p_actor), ''), 'seller'), p_old, p_new)
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_audit(text, bigint, text, text, jsonb, jsonb) FROM PUBLIC;

-- ── 8. core functions: storefront.shop_*(p_seller_id, p_actor, …) ───────────
-- Owner-only. P2 Collective Orders calls these for the organizer-run shops;
-- the portal_* wrappers below call them for member shops.

-- the shop summary the header shows
DROP FUNCTION IF EXISTS storefront.shop_me(bigint);
CREATE FUNCTION storefront.shop_me(p_seller_id bigint) RETURNS SETOF storefront.shop_me_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT s.id, s.slug, s.display_name, s.status::text, s.fee_pct, s.managed_in_ops,
         (SELECT count(*)::int FROM storefront.seller_wallets w WHERE w.seller_id = s.id AND w.active AND w.rail <> 'cash'),
         EXISTS (SELECT 1 FROM storefront.seller_wallets w WHERE w.seller_id = s.id AND w.active AND w.is_default_settlement),
         f.seller_id IS NOT NULL,
         f.shippo_api_key IS NOT NULL,
         CASE WHEN f.shippo_api_key IS NOT NULL THEN right(f.shippo_api_key, 4) END,
         COALESCE(f.shippo_api_key LIKE 'shippo\_test\_%', false),
         (SELECT count(*)::int FROM storefront.store_orders o WHERE o.seller_id = s.id AND o.status = 'paid')
    FROM storefront.sellers s
    LEFT JOIN storefront.seller_ship_from f ON f.seller_id = s.id
   WHERE s.id = p_seller_id
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_me(bigint) FROM PUBLIC;

DROP FUNCTION IF EXISTS storefront.shop_order_counts(bigint);
CREATE FUNCTION storefront.shop_order_counts(p_seller_id bigint) RETURNS SETOF storefront.shop_counts_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT count(*) FILTER (WHERE o.status IN ('unpaid', 'payment_submitted'))::int,
         count(*) FILTER (WHERE o.status = 'paid')::int,
         (SELECT count(*)::int FROM storefront.store_shipments sh WHERE sh.seller_id = p_seller_id AND sh.cancelled_at IS NULL AND sh.recorded_at IS NULL),
         count(*) FILTER (WHERE o.status = 'shipped')::int,
         count(*) FILTER (WHERE o.status = 'delivered')::int,
         count(*) FILTER (WHERE o.status = 'cancelled')::int,
         count(*)::int
    FROM storefront.store_orders o WHERE o.seller_id = p_seller_id
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_order_counts(bigint) FROM PUBLIC;

-- the shop's orders, newest first. The buyer's email is never selected; the
-- ship-to comes back NULL outside its window (shop_ship_to_visible).
DROP FUNCTION IF EXISTS storefront.shop_list_orders(bigint, text, text);
CREATE FUNCTION storefront.shop_list_orders(p_seller_id bigint, p_status text DEFAULT '', p_limit text DEFAULT '100') RETURNS SETOF storefront.shop_order_row
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_status text := lower(btrim(COALESCE(p_status, ''))); v_limit int;
BEGIN
  IF v_status <> '' AND v_status NOT IN ('unpaid', 'payment_submitted', 'paid', 'shipped', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Unknown order status filter.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:status';
  END IF;
  v_limit := LEAST(200, GREATEST(1, CASE WHEN btrim(COALESCE(p_limit, '')) ~ '^[0-9]{1,3}$' THEN btrim(p_limit)::int ELSE 100 END));
  RETURN QUERY
    SELECT o.id, o.order_number, o.listing_id, o.listing_title_snapshot, o.qty,
           o.unit_price_usd, o.shipping_fee_usd, o.total_usd, o.fee_usd, o.payment_rail::text,
           o.status::text, o.telegram_username, o.discord_username, o.buyer_note,
           v.visible,
           CASE WHEN v.visible THEN o.contact_name END, CASE WHEN v.visible THEN o.contact_phone END,
           CASE WHEN v.visible THEN o.address_line1 END, CASE WHEN v.visible THEN o.address_line2 END,
           CASE WHEN v.visible THEN o.city END, CASE WHEN v.visible THEN o.state_code END, CASE WHEN v.visible THEN o.postal_code END,
           o.carrier, o.tracking_number, o.shipped_at, o.delivered_at, o.paid_at, o.created_at,
           sh.id, sh.source, sh.status
      FROM storefront.store_orders o
      CROSS JOIN LATERAL (SELECT storefront.shop_ship_to_visible(o.status, o.shipped_at, o.delivered_at) AS visible) v
      LEFT JOIN storefront.store_shipments sh ON sh.store_order_id = o.id AND sh.cancelled_at IS NULL
     WHERE o.seller_id = p_seller_id AND (v_status = '' OR o.status::text = v_status)
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT v_limit;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_orders(bigint, text, text) FROM PUBLIC;

-- every shipment row of one order (live first). The label PDF carries the
-- buyer's address, so its URL follows the ship-to window too.
DROP FUNCTION IF EXISTS storefront.shop_list_shipments(bigint, text);
CREATE FUNCTION storefront.shop_list_shipments(p_seller_id bigint, p_order_id text) RETURNS SETOF storefront.shop_shipment_row
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_id bigint := storefront.shop_parse_id(p_order_id, 'order');
BEGIN
  RETURN QUERY
    SELECT sh.id, sh.store_order_id, sh.source, sh.status, sh.carrier, sh.servicelevel, sh.tracking_number,
           sh.rate_amount,
           CASE WHEN storefront.shop_ship_to_visible(o.status, o.shipped_at, o.delivered_at) THEN sh.label_url END,
           sh.label_cost_usd, sh.shippo_rate_id, sh.shippo_transaction_id,
           sh.created_by, sh.created_at, sh.recorded_at, sh.cancelled_at, sh.cancelled_by,
           sh.cancel_reason, sh.refund_status, sh.refund_object_id, sh.refund_note, sh.refund_recorded_at,
           sh.cancelled_at IS NULL,
           sh.key_last4,
           CASE WHEN sh.key_fingerprint IS NULL THEN NULL ELSE sh.key_fingerprint IS NOT DISTINCT FROM storefront.shop_key_fingerprint(p_seller_id) END
      FROM storefront.store_shipments sh
      JOIN storefront.store_orders o ON o.id = sh.store_order_id
     WHERE sh.store_order_id = v_id AND sh.seller_id = p_seller_id AND o.seller_id = p_seller_id
     ORDER BY (sh.cancelled_at IS NULL) DESC, sh.created_at DESC, sh.id DESC;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_shipments(bigint, text) FROM PUBLIC;

-- Paid → shipped with carrier + tracking; on a shipped order the same call
-- corrects the tracking (status and ship date stay). p_expected_status is
-- the status the page showed, so a stale tab never ships twice.
DROP FUNCTION IF EXISTS storefront.shop_mark_shipped(bigint, text, text, text, text, text);
CREATE FUNCTION storefront.shop_mark_shipped(p_seller_id bigint, p_actor text, p_order_id text, p_carrier text, p_tracking_number text, p_expected_status text)
RETURNS SETOF storefront.shop_order_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_id bigint; v_o storefront.store_orders%ROWTYPE; v_s storefront.store_shipments%ROWTYPE;
        v_carrier text; v_track text; v_fix boolean; v_ship bigint;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);                                    -- 1. seller
  v_id := storefront.shop_parse_id(p_order_id, 'order');
  SELECT * FROM storefront.shop_check_tracking(p_carrier, p_tracking_number) INTO v_carrier, v_track;

  SELECT * INTO v_o FROM storefront.store_orders o WHERE o.id = v_id AND o.seller_id = p_seller_id FOR UPDATE;   -- 2. order
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That order isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF btrim(COALESCE(p_expected_status, '')) <> '' AND btrim(p_expected_status) <> v_o.status::text THEN
    RAISE EXCEPTION 'This order changed since you opened it — it''s % now. Reload the page.', replace(v_o.status::text, '_', ' ')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_fix := v_o.status = 'shipped';
  IF NOT v_fix AND v_o.status <> 'paid' THEN
    RAISE EXCEPTION '%', CASE v_o.status
      WHEN 'unpaid' THEN 'This order isn''t paid yet. Don''t ship until it shows Paid.'
      WHEN 'payment_submitted' THEN 'The buyer''s payment is still being checked. Ship once it shows Paid.'
      WHEN 'delivered' THEN 'This order is already delivered.'
      WHEN 'cancelled' THEN 'This order was cancelled. Don''t ship it.'
      ELSE 'This order can''t be marked shipped right now.' END
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT * INTO v_s FROM storefront.store_shipments sh WHERE sh.store_order_id = v_o.id AND sh.cancelled_at IS NULL FOR UPDATE;  -- 3. shipment
  IF FOUND AND v_s.source = 'shippo' THEN
    RAISE EXCEPTION '%', CASE WHEN v_s.recorded_at IS NULL
      THEN 'A label is being bought for this order. Finish it, or discard the draft, first.'
      ELSE 'This order shipped on a Shippo label. Void the label to change its tracking.' END
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF FOUND THEN
    UPDATE storefront.store_shipments SET carrier = v_carrier, tracking_number = v_track WHERE id = v_s.id;
    v_ship := v_s.id;
  ELSE
    INSERT INTO storefront.store_shipments (store_order_id, seller_id, source, carrier, tracking_number, created_by, recorded_at)
    VALUES (v_o.id, p_seller_id, 'manual', v_carrier, v_track, p_actor, now())
    RETURNING id INTO v_ship;
  END IF;

  UPDATE storefront.store_orders o
     SET status = 'shipped', carrier = v_carrier, tracking_number = v_track, shipped_at = COALESCE(o.shipped_at, now())
   WHERE o.id = v_o.id AND o.seller_id = p_seller_id AND o.status = v_o.status;

  PERFORM storefront.shop_audit('storefront.store_orders', v_o.id,
    CASE WHEN v_fix THEN 'tracking_corrected' ELSE 'shipped_by_seller' END, p_actor,
    jsonb_build_object('status', v_o.status, 'carrier', v_o.carrier, 'trackingNumber', v_o.tracking_number),
    jsonb_build_object('status', 'shipped', 'carrier', v_carrier, 'trackingNumber', v_track, 'shipmentId', v_ship, 'source', 'manual'));

  RETURN QUERY SELECT v_o.id, v_o.order_number, 'shipped'::text, v_fix, v_ship,
    CASE WHEN v_fix THEN 'Tracking updated.' ELSE v_o.order_number || ' marked shipped.' END;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_mark_shipped(bigint, text, text, text, text, text) FROM PUBLIC;

-- shipped → delivered
DROP FUNCTION IF EXISTS storefront.shop_mark_delivered(bigint, text, text);
CREATE FUNCTION storefront.shop_mark_delivered(p_seller_id bigint, p_actor text, p_order_id text) RETURNS SETOF storefront.shop_order_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_id bigint; v_o storefront.store_orders%ROWTYPE;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_id := storefront.shop_parse_id(p_order_id, 'order');
  SELECT * INTO v_o FROM storefront.store_orders o WHERE o.id = v_id AND o.seller_id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That order isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_o.status <> 'shipped' THEN
    RAISE EXCEPTION '%', CASE v_o.status
      WHEN 'delivered' THEN 'This order is already marked delivered.'
      WHEN 'paid' THEN 'Mark it shipped with tracking first.'
      ELSE 'Only a shipped order can be marked delivered.' END
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE storefront.store_orders o SET status = 'delivered', delivered_at = now()
   WHERE o.id = v_o.id AND o.seller_id = p_seller_id AND o.status = 'shipped';
  PERFORM storefront.shop_audit('storefront.store_orders', v_o.id, 'delivered_by_seller', p_actor,
    jsonb_build_object('status', v_o.status), jsonb_build_object('status', 'delivered'));
  RETURN QUERY SELECT v_o.id, v_o.order_number, 'delivered'::text, false, NULL::bigint, v_o.order_number || ' marked delivered.';
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_mark_delivered(bigint, text, text) FROM PUBLIC;

-- A label purchase starts HERE, before the money POST: the draft row holds
-- the rate so a second operator, a double click or a dead tab cannot buy a
-- second label (one live row per order, one row per rate). Nothing has been
-- charged when this refuses.
DROP FUNCTION IF EXISTS storefront.shop_begin_label(bigint, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS storefront.shop_begin_label(bigint, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_begin_label(p_seller_id bigint, p_actor text, p_order_id text, p_rate_id text, p_rate_amount text, p_carrier text, p_servicelevel text, p_key_fingerprint text)
RETURNS SETOF storefront.shop_label_begin_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_id bigint; v_o storefront.store_orders%ROWTYPE; v_rate text := lower(btrim(COALESCE(p_rate_id, '')));
        v_carrier text := btrim(COALESCE(p_carrier, '')); v_amt numeric; v_ship bigint; v_created timestamptz; v_live storefront.store_shipments%ROWTYPE;
        v_key text;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_id := storefront.shop_parse_id(p_order_id, 'order');
  IF v_rate !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'Pick a rate first.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:rate';
  END IF;
  IF v_carrier NOT IN ('USPS', 'UPS', 'FedEx', 'DHL', 'Other') THEN
    RAISE EXCEPTION 'Pick the carrier.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:carrier';
  END IF;
  v_amt := storefront.shop_parse_usd(p_rate_amount, 'rate', false, true, 1000, 'The rate has no price. Quote again.', 'That rate is over $1,000. Quote again.');
  -- the key the browser quoted with and is about to charge: its sha256, computed
  -- there. Read the shop's key under the row lock and refuse if it is not that
  -- key — another operator saved a different key between the quote and this
  -- click — so the draft is only ever stamped with the account that pays.
  SELECT f.shippo_api_key INTO v_key FROM storefront.seller_ship_from f WHERE f.seller_id = p_seller_id FOR UPDATE;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Add your ship-from address and Shippo key in Settings before buying a label.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF lower(btrim(COALESCE(p_key_fingerprint, ''))) !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Quote again before buying.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:keyFingerprint';
  END IF;
  IF lower(btrim(p_key_fingerprint)) <> encode(sha256(convert_to(v_key, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'The shop''s Shippo key changed while you were quoting. Quote again.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT * INTO v_o FROM storefront.store_orders o WHERE o.id = v_id AND o.seller_id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That order isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_o.status <> 'paid' THEN
    RAISE EXCEPTION '%', CASE v_o.status
      WHEN 'shipped' THEN 'This order is already shipped. Void its label or fix its tracking instead.'
      WHEN 'delivered' THEN 'This order is already delivered.'
      WHEN 'cancelled' THEN 'This order was cancelled. Don''t ship it.'
      ELSE 'This order isn''t paid yet. Buy the label once it shows Paid.' END
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT * INTO v_live FROM storefront.store_shipments sh WHERE sh.store_order_id = v_o.id AND sh.cancelled_at IS NULL FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION '%', CASE WHEN v_live.recorded_at IS NULL
      THEN 'A label for this order was started ' || to_char(v_live.created_at AT TIME ZONE 'America/New_York', 'Mon DD HH24:MI') || ' by ' || v_live.created_by || '. Finish it, or discard that draft, first.'
      ELSE 'This order already has a shipment recorded. Reload the page.' END
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  BEGIN
    INSERT INTO storefront.store_shipments (store_order_id, seller_id, source, shippo_rate_id, rate_amount, carrier, servicelevel, created_by, purchase_started_at, key_fingerprint, key_last4)
    VALUES (v_o.id, p_seller_id, 'shippo', v_rate, v_amt, v_carrier, NULLIF(btrim(COALESCE(p_servicelevel, '')), ''), p_actor, now(),
            encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), right(v_key, 4))
    RETURNING id, created_at INTO v_ship, v_created;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That rate was already used for a label. Quote again and pick a fresh rate.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END;

  PERFORM storefront.shop_audit('storefront.store_shipments', v_ship, 'label_purchase_started', p_actor, NULL,
    jsonb_build_object('orderId', v_o.id, 'orderNumber', v_o.order_number, 'rateId', v_rate, 'rateAmount', v_amt, 'carrier', v_carrier, 'keyLast4', right(v_key, 4)));
  RETURN QUERY SELECT v_ship, v_created, 'Label started.'::text;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_begin_label(bigint, text, text, text, text, text, text, text) FROM PUBLIC;

-- The label was bought: record it on the draft and, if the order is still
-- paid, ship the order in the same call. It never refuses because the order
-- moved — the postage is spent — it then records the label only and says so.
-- Idempotent on the same transaction id.
DROP FUNCTION IF EXISTS storefront.shop_record_label(bigint, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_record_label(p_seller_id bigint, p_actor text, p_shipment_id text, p_transaction_id text, p_carrier text, p_tracking_number text, p_label_url text, p_label_cost_usd text)
RETURNS SETOF storefront.shop_label_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_sid bigint; v_order_id bigint; v_o storefront.store_orders%ROWTYPE; v_s storefront.store_shipments%ROWTYPE;
        v_txn text := lower(btrim(COALESCE(p_transaction_id, ''))); v_url text := btrim(COALESCE(p_label_url, ''));
        v_carrier text; v_track text; v_cost numeric; v_updated boolean := false; v_now timestamptz := now();
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_sid := storefront.shop_parse_id(p_shipment_id, 'label');
  IF v_txn !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'The label has no Shippo transaction id. Use "Check Shippo & retry".' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:transactionId';
  END IF;
  IF v_url !~ '^https://' OR char_length(v_url) > 1000 THEN
    RAISE EXCEPTION 'The label has no PDF link. Use "Check Shippo & retry".' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:labelUrl';
  END IF;
  SELECT * FROM storefront.shop_check_tracking(p_carrier, p_tracking_number) INTO v_carrier, v_track;
  v_cost := storefront.shop_parse_usd(p_label_cost_usd, 'cost', true, true, 1000, 'The label cost is unreadable.', 'The label cost is over $1,000.');

  SELECT sh.store_order_id INTO v_order_id FROM storefront.store_shipments sh WHERE sh.id = v_sid AND sh.seller_id = p_seller_id;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'That label isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_o FROM storefront.store_orders o WHERE o.id = v_order_id AND o.seller_id = p_seller_id FOR UPDATE;
  SELECT * INTO v_s FROM storefront.store_shipments sh WHERE sh.id = v_sid AND sh.seller_id = p_seller_id FOR UPDATE;
  IF v_s.source <> 'shippo' THEN
    RAISE EXCEPTION 'That shipment was entered by hand; it takes no label.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_s.recorded_at IS NOT NULL THEN
    IF v_s.shippo_transaction_id = v_txn THEN
      RETURN QUERY SELECT v_s.id, v_o.id, v_o.order_number, v_o.status::text, false, v_s.recorded_at, 'This label was already recorded.'::text;
      RETURN;
    END IF;
    RAISE EXCEPTION 'A different label is already recorded on this shipment. Message the organizers.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_s.cancelled_at IS NOT NULL THEN
    -- a late label on a discarded draft (the POST was in flight when the draft
    -- was discarded): put the postage in the ledger on the cancelled row —
    -- refund_status NULL on a cancelled, recorded Shippo row means "refund
    -- not requested yet" — and leave the order alone
    UPDATE storefront.store_shipments
       SET recorded_at = v_now, shippo_transaction_id = v_txn, carrier = v_carrier, tracking_number = v_track, label_url = v_url, label_cost_usd = v_cost,
           refund_status = NULL, refund_object_id = NULL, refund_recorded_at = NULL,
           refund_note = 'late label on a discarded draft — request its refund'
     WHERE id = v_s.id;
    PERFORM storefront.shop_audit('storefront.store_shipments', v_s.id, 'label_bought_by_seller', p_actor, NULL,
      jsonb_build_object('orderId', v_o.id, 'orderNumber', v_o.order_number, 'transactionId', v_txn, 'carrier', v_carrier,
                         'trackingNumber', v_track, 'labelCostUsd', v_cost, 'orderUpdated', false, 'lateOnDiscardedDraft', true));
    RETURN QUERY SELECT v_s.id, v_o.id, v_o.order_number, v_o.status::text, false, v_now,
      'This draft had been discarded, but the label was bought — it is recorded; request its refund. Nothing shipped.'::text;
    RETURN;
  END IF;

  UPDATE storefront.store_shipments
     SET recorded_at = v_now, shippo_transaction_id = v_txn, carrier = v_carrier, tracking_number = v_track, label_url = v_url, label_cost_usd = v_cost
   WHERE id = v_s.id;

  IF v_o.status = 'paid' THEN
    UPDATE storefront.store_orders o
       SET status = 'shipped', carrier = v_carrier, tracking_number = v_track, shipped_at = COALESCE(o.shipped_at, v_now)
     WHERE o.id = v_o.id AND o.seller_id = p_seller_id AND o.status = 'paid';
    v_updated := true;
    PERFORM storefront.shop_audit('storefront.store_orders', v_o.id, 'shipped_by_seller', p_actor,
      jsonb_build_object('status', v_o.status, 'carrier', v_o.carrier, 'trackingNumber', v_o.tracking_number),
      jsonb_build_object('status', 'shipped', 'carrier', v_carrier, 'trackingNumber', v_track, 'shipmentId', v_s.id, 'source', 'shippo'));
  END IF;
  PERFORM storefront.shop_audit('storefront.store_shipments', v_s.id, 'label_bought_by_seller', p_actor, NULL,
    jsonb_build_object('orderId', v_o.id, 'orderNumber', v_o.order_number, 'transactionId', v_txn, 'carrier', v_carrier,
                       'trackingNumber', v_track, 'labelCostUsd', v_cost, 'orderUpdated', v_updated));

  RETURN QUERY SELECT v_s.id, v_o.id, v_o.order_number, CASE WHEN v_updated THEN 'shipped' ELSE v_o.status::text END, v_updated, v_now,
    CASE WHEN v_updated THEN 'Label recorded — ' || v_o.order_number || ' is shipped.'
         ELSE 'Recorded the label, but the order was already ' || replace(v_o.status::text, '_', ' ') || ' — void this label to get the postage back.' END;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_record_label(bigint, text, text, text, text, text, text, text) FROM PUBLIC;

-- Void a shipment at once; the Shippo refund settles on its own (the
-- 1790103200 philosophy). A draft is discarded with the order untouched. A
-- recorded label (or a manual shipment) is cancelled and the order goes back
-- to paid ONLY while the order's tracking is still that shipment's — a
-- correction made meanwhile on the storefront dashboard is never undone.
DROP FUNCTION IF EXISTS storefront.shop_void_shipment(bigint, text, text, text, text);
CREATE FUNCTION storefront.shop_void_shipment(p_seller_id bigint, p_actor text, p_shipment_id text, p_refund_status text, p_refund_object_id text)
RETURNS SETOF storefront.shop_void_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_sid bigint; v_order_id bigint; v_o storefront.store_orders%ROWTYPE; v_s storefront.store_shipments%ROWTYPE;
        v_refund text := lower(btrim(COALESCE(p_refund_status, ''))); v_obj text := NULLIF(lower(btrim(COALESCE(p_refund_object_id, ''))), '');
        v_reset boolean := false; v_reason text; v_action text; v_key_changed boolean := false; v_note text;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_sid := storefront.shop_parse_id(p_shipment_id, 'shipment');
  IF v_obj IS NOT NULL AND v_obj !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'The refund id is unreadable.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:refundObjectId';
  END IF;
  SELECT sh.store_order_id INTO v_order_id FROM storefront.store_shipments sh WHERE sh.id = v_sid AND sh.seller_id = p_seller_id;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'That shipment isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_o FROM storefront.store_orders o WHERE o.id = v_order_id AND o.seller_id = p_seller_id FOR UPDATE;
  SELECT * INTO v_s FROM storefront.store_shipments sh WHERE sh.id = v_sid AND sh.seller_id = p_seller_id FOR UPDATE;
  IF v_s.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This shipment was already voided.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_s.source = 'shippo' AND v_s.recorded_at IS NULL THEN
    -- A draft. Its purchase may be in flight in another tab (the POST goes
    -- out right after begin_label), so a discard is allowed only when Shippo
    -- REFUSED that purchase ('refused': no label can exist for the rate) or
    -- when the draft is older than 10 minutes — the lease horizon the Ops
    -- app's own shipment pushes carry. A label that still lands on a
    -- discarded draft is recorded by shop_record_label as a cancelled row
    -- awaiting its refund, so bought postage is never lost (Codex 2026-11-08).
    IF v_refund = 'refused' THEN
      v_reason := 'purchase refused by Shippo';
    ELSIF v_refund = 'unsent' THEN
      -- the flow that started this draft was abandoned before the money POST
      -- (inputs changed, operator backed out). Only that flow knows, so only the
      -- operator who started the draft may say so; another operator waits the
      -- 10 minutes or proves it on Shippo.
      IF v_s.created_by IS DISTINCT FROM p_actor THEN
        RAISE EXCEPTION 'This label was started by %; only they can discard it as unsent. Wait until % or use "Check Shippo & retry".',
          v_s.created_by, to_char((COALESCE(v_s.purchase_started_at, v_s.created_at) + interval '10 minutes') AT TIME ZONE 'America/New_York', 'HH24:MI')
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      v_reason := 'purchase never sent';
    ELSIF v_s.key_fingerprint IS NOT NULL AND v_s.key_fingerprint IS DISTINCT FROM storefront.shop_key_fingerprint(p_seller_id) THEN
      -- "no transaction found" was looked up on a different Shippo account than
      -- the one this label was started on: it proves nothing about the postage
      RAISE EXCEPTION 'The Shippo key changed since this label was started (it was on the key ending …%). Put that key back in Settings to check Shippo, or message the organizers.', v_s.key_last4
        USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSIF COALESCE(v_s.purchase_started_at, v_s.created_at) > now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'This label was started at % by % and its purchase may still be in flight. Wait until % or use "Check Shippo & retry".',
        to_char(COALESCE(v_s.purchase_started_at, v_s.created_at) AT TIME ZONE 'America/New_York', 'HH24:MI'), v_s.created_by,
        to_char((COALESCE(v_s.purchase_started_at, v_s.created_at) + interval '10 minutes') AT TIME ZONE 'America/New_York', 'HH24:MI')
        USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSE
      v_reason := 'draft discarded (no label)';
    END IF;
    v_refund := 'not_applicable'; v_obj := NULL; v_action := 'label_purchase_abandoned';
  ELSE
    IF v_o.status = 'delivered' THEN
      RAISE EXCEPTION 'This order is marked delivered — that''s a return, not a void.' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF v_s.source = 'manual' THEN
      v_refund := 'not_applicable'; v_obj := NULL; v_reason := 'shipment voided by seller'; v_action := 'shipment_voided_by_seller';
    ELSE
      IF v_refund NOT IN ('requested', 'unavailable', 'error') THEN
        RAISE EXCEPTION 'Request the Shippo refund first; its outcome is recorded with the void.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:refundStatus';
      END IF;
      v_reason := 'label voided by seller'; v_action := 'shipment_voided_by_seller';
      IF v_s.key_fingerprint IS NOT NULL AND v_s.key_fingerprint IS DISTINCT FROM storefront.shop_key_fingerprint(p_seller_id) THEN
        -- the refund outcome was obtained on another Shippo account than the one
        -- that bought the label: it proves nothing. The void still happens (the
        -- order can be re-shipped now), the refund stays unresolved until the
        -- original key is back (shop_set_refund_status, same guard).
        v_key_changed := true; v_refund := NULL; v_obj := NULL;
        v_note := 'voided while the shop held a different Shippo key — request the refund with the key ending …' || COALESCE(v_s.key_last4, '????');
      END IF;
    END IF;
    IF v_o.status = 'shipped' AND v_o.tracking_number IS NOT DISTINCT FROM v_s.tracking_number THEN
      UPDATE storefront.store_orders o SET status = 'paid', carrier = NULL, tracking_number = NULL, shipped_at = NULL
       WHERE o.id = v_o.id AND o.seller_id = p_seller_id AND o.status = 'shipped';
      v_reset := true;
      PERFORM storefront.shop_audit('storefront.store_orders', v_o.id, 'shipping_reset_by_seller', p_actor,
        jsonb_build_object('status', v_o.status, 'carrier', v_o.carrier, 'trackingNumber', v_o.tracking_number, 'shippedAt', v_o.shipped_at),
        jsonb_build_object('status', 'paid', 'shipmentId', v_s.id));
    END IF;
  END IF;

  UPDATE storefront.store_shipments
     SET cancelled_at = now(), cancelled_by = p_actor, cancel_reason = v_reason,
         refund_status = v_refund, refund_object_id = v_obj, refund_note = v_note,
         refund_recorded_at = CASE WHEN v_refund IS NOT NULL AND v_refund <> 'not_applicable' THEN now() END
   WHERE id = v_s.id;
  PERFORM storefront.shop_audit('storefront.store_shipments', v_s.id, v_action, p_actor,
    jsonb_build_object('status', v_s.status, 'source', v_s.source, 'trackingNumber', v_s.tracking_number, 'transactionId', v_s.shippo_transaction_id, 'labelCostUsd', v_s.label_cost_usd),
    jsonb_build_object('orderId', v_o.id, 'orderReset', v_reset, 'refundStatus', v_refund, 'refundObjectId', v_obj, 'keyChanged', v_key_changed));

  RETURN QUERY SELECT v_s.id, v_o.id, 'cancelled'::text, v_reset, CASE WHEN v_reset THEN 'paid' ELSE v_o.status::text END, v_refund,
    (CASE WHEN v_s.source = 'shippo' AND v_s.recorded_at IS NULL THEN 'Draft discarded. Quote again when you''re ready.'
          WHEN v_reset THEN 'Shipment voided — ' || v_o.order_number || ' is back on To ship.'
          ELSE 'Shipment voided. The order''s tracking was changed elsewhere, so the order was left as it is.' END)
    || CASE WHEN v_key_changed THEN ' The refund is not recorded: the label was bought on the Shippo key ending …' || COALESCE(v_s.key_last4, '????') || '; put that key back to request it.' ELSE '' END;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_void_shipment(bigint, text, text, text, text) FROM PUBLIC;

-- later refund outcomes on a voided Shippo label (requested → success / error)
DROP FUNCTION IF EXISTS storefront.shop_set_refund_status(bigint, text, text, text, text, text);
CREATE FUNCTION storefront.shop_set_refund_status(p_seller_id bigint, p_actor text, p_shipment_id text, p_refund_status text, p_refund_object_id text, p_note text)
RETURNS SETOF storefront.shop_refund_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_sid bigint; v_s storefront.store_shipments%ROWTYPE; v_refund text := lower(btrim(COALESCE(p_refund_status, '')));
        v_obj text := NULLIF(lower(btrim(COALESCE(p_refund_object_id, ''))), ''); v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_sid := storefront.shop_parse_id(p_shipment_id, 'shipment');
  IF v_refund NOT IN ('requested', 'success', 'error', 'unavailable') THEN
    RAISE EXCEPTION 'Unknown refund outcome.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:refundStatus';
  END IF;
  IF v_obj IS NOT NULL AND v_obj !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'The refund id is unreadable.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:refundObjectId';
  END IF;
  SELECT * INTO v_s FROM storefront.store_shipments sh WHERE sh.id = v_sid AND sh.seller_id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That shipment isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_s.cancelled_at IS NULL OR v_s.source <> 'shippo' OR v_s.recorded_at IS NULL THEN
    RAISE EXCEPTION 'Only a voided Shippo label carries a refund.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_s.key_fingerprint IS NOT NULL AND v_s.key_fingerprint IS DISTINCT FROM storefront.shop_key_fingerprint(p_seller_id) THEN
    RAISE EXCEPTION 'The Shippo key changed since this label was bought (it was on the key ending …%). Put that key back in Settings to manage its refund, or message the organizers.', v_s.key_last4
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE storefront.store_shipments
     SET refund_status = v_refund, refund_object_id = COALESCE(v_obj, refund_object_id), refund_note = v_note, refund_recorded_at = now()
   WHERE id = v_s.id;
  PERFORM storefront.shop_audit('storefront.store_shipments', v_s.id, 'label_refund_recorded', p_actor,
    jsonb_build_object('refundStatus', v_s.refund_status, 'refundObjectId', v_s.refund_object_id),
    jsonb_build_object('refundStatus', v_refund, 'refundObjectId', COALESCE(v_obj, v_s.refund_object_id), 'note', v_note));
  RETURN QUERY SELECT v_s.id, v_refund, CASE v_refund WHEN 'success' THEN 'Refund settled.' WHEN 'requested' THEN 'Refund requested.' ELSE 'Refund outcome recorded.' END;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_set_refund_status(bigint, text, text, text, text, text) FROM PUBLIC;

-- ── listings ──
DROP FUNCTION IF EXISTS storefront.shop_list_listings(bigint);
CREATE FUNCTION storefront.shop_list_listings(p_seller_id bigint) RETURNS SETOF storefront.shop_listing_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT l.id, l.title, l.description_md, l.mass_label, l.price_usd, l.shipping_fee_usd,
         COALESCE(l.qty_available, 0), l.max_per_order, l.status::text,
         CASE WHEN l.status = 'active' AND COALESCE(l.qty_available, 0) <= 0 THEN 'sold_out' ELSE l.status::text END,
         l.p2_product_id IS NOT NULL, l.created_at, l.updated_at
    FROM storefront.store_listings l
   WHERE l.seller_id = p_seller_id
   ORDER BY CASE CASE WHEN l.status = 'active' AND COALESCE(l.qty_available, 0) <= 0 THEN 'sold_out' ELSE l.status::text END
              WHEN 'active' THEN 0 WHEN 'sold_out' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
            l.updated_at DESC, l.id DESC
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_listings(bigint) FROM PUBLIC;

DROP FUNCTION IF EXISTS storefront.shop_create_listing(bigint, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_create_listing(p_seller_id bigint, p_actor text, p_title text, p_mass_label text, p_description_md text, p_price_usd text, p_shipping_usd text, p_qty text, p_status text)
RETURNS SETOF storefront.shop_listing_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v record; v_status storefront.listing_status; v_id bigint;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  SELECT * INTO v FROM storefront.shop_check_listing(p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status);
  v_status := storefront.shop_resolve_listing_status(v.requested, v.qty, storefront.shop_has_wallet(p_seller_id));
  INSERT INTO storefront.store_listings (seller_id, title, mass_label, description_md, price_usd, shipping_fee_usd, qty_available, status)
  VALUES (p_seller_id, v.title, v.mass_label, v.description_md, v.price_usd, v.shipping_fee_usd, v.qty, v_status)
  RETURNING id INTO v_id;
  PERFORM storefront.shop_audit('storefront.store_listings', v_id, 'listing_created', p_actor, NULL,
    jsonb_build_object('title', v.title, 'priceUsd', v.price_usd, 'shippingFeeUsd', v.shipping_fee_usd, 'qtyAvailable', v.qty, 'status', v_status));
  RETURN QUERY SELECT v_id, v_status::text, v.qty, 'Listing saved.'::text;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_create_listing(bigint, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- the listing row every edit locks; house-managed listings are never edited here
DROP FUNCTION IF EXISTS storefront.shop_lock_listing(bigint, bigint);
CREATE FUNCTION storefront.shop_lock_listing(p_seller_id bigint, p_listing_id bigint) RETURNS storefront.store_listings
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_l storefront.store_listings%ROWTYPE;
BEGIN
  SELECT * INTO v_l FROM storefront.store_listings l WHERE l.id = p_listing_id AND l.seller_id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That listing isn''t yours, or it was removed. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_l.p2_product_id IS NOT NULL THEN
    RAISE EXCEPTION 'This listing is managed by the organizers.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN v_l;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_lock_listing(bigint, bigint) FROM PUBLIC;

-- Save the edit form. Stock is written only when the seller changed it, and
-- only if it still equals what the form loaded (p_expected_qty): a buyer's
-- checkout in between is never overwritten.
DROP FUNCTION IF EXISTS storefront.shop_update_listing(bigint, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_update_listing(p_seller_id bigint, p_actor text, p_listing_id text, p_title text, p_mass_label text, p_description_md text, p_price_usd text, p_shipping_usd text, p_qty text, p_expected_qty text, p_status text)
RETURNS SETOF storefront.shop_listing_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v record; v_l storefront.store_listings%ROWTYPE; v_cur int; v_qty int; v_expected int; v_status storefront.listing_status;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  SELECT * INTO v FROM storefront.shop_check_listing(p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status);
  v_expected := storefront.shop_parse_stock(p_expected_qty, 'qty');
  v_l := storefront.shop_lock_listing(p_seller_id, storefront.shop_parse_id(p_listing_id, 'listing'));
  v_cur := COALESCE(v_l.qty_available, 0);
  v_qty := v_cur;
  IF v.qty <> v_expected THEN
    IF v_cur <> v_expected THEN
      RAISE EXCEPTION 'Stock changed while you were editing — it''s % now. Check the number and save again.', v_cur
        USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:qty';
    END IF;
    v_qty := v.qty;
  END IF;
  v_status := storefront.shop_resolve_listing_status(v.requested, v_qty, storefront.shop_has_wallet(p_seller_id));
  UPDATE storefront.store_listings l
     SET title = v.title, mass_label = v.mass_label, description_md = v.description_md,
         price_usd = v.price_usd, shipping_fee_usd = v.shipping_fee_usd, qty_available = v_qty, status = v_status
   WHERE l.id = v_l.id AND l.seller_id = p_seller_id;
  PERFORM storefront.shop_audit('storefront.store_listings', v_l.id, 'listing_updated', p_actor,
    jsonb_build_object('title', v_l.title, 'priceUsd', v_l.price_usd, 'shippingFeeUsd', v_l.shipping_fee_usd, 'qtyAvailable', v_l.qty_available, 'status', v_l.status),
    jsonb_build_object('title', v.title, 'priceUsd', v.price_usd, 'shippingFeeUsd', v.shipping_fee_usd, 'qtyAvailable', v_qty, 'status', v_status));
  RETURN QUERY SELECT v_l.id, v_status::text, v_qty, 'Listing saved.'::text;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_update_listing(bigint, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- activate, move to draft, or archive; activation needs a wallet
DROP FUNCTION IF EXISTS storefront.shop_set_listing_status(bigint, text, text, text);
CREATE FUNCTION storefront.shop_set_listing_status(p_seller_id bigint, p_actor text, p_listing_id text, p_status text) RETURNS SETOF storefront.shop_listing_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_l storefront.store_listings%ROWTYPE; v_req text := lower(btrim(COALESCE(p_status, ''))); v_status storefront.listing_status;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  IF v_req NOT IN ('draft', 'active', 'archived') THEN
    RAISE EXCEPTION 'Pick draft, active or archived.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:status';
  END IF;
  v_l := storefront.shop_lock_listing(p_seller_id, storefront.shop_parse_id(p_listing_id, 'listing'));
  v_status := storefront.shop_resolve_listing_status(v_req, COALESCE(v_l.qty_available, 0),
                CASE WHEN v_req = 'active' THEN storefront.shop_has_wallet(p_seller_id) ELSE true END);
  IF v_status = v_l.status THEN
    RETURN QUERY SELECT v_l.id, v_l.status::text, COALESCE(v_l.qty_available, 0), 'No change.'::text;
    RETURN;
  END IF;
  UPDATE storefront.store_listings l SET status = v_status WHERE l.id = v_l.id AND l.seller_id = p_seller_id;
  PERFORM storefront.shop_audit('storefront.store_listings', v_l.id, 'listing_status_changed', p_actor,
    jsonb_build_object('status', v_l.status), jsonb_build_object('status', v_status));
  RETURN QUERY SELECT v_l.id, v_status::text, COALESCE(v_l.qty_available, 0),
    CASE v_status WHEN 'active' THEN 'Listing is live.' WHEN 'sold_out' THEN 'Listing is live and shows sold out until you add stock.'
                  WHEN 'draft' THEN 'Listing moved to draft.' ELSE 'Listing archived.' END;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_set_listing_status(bigint, text, text, text) FROM PUBLIC;

-- set stock, compare-and-set against the count the seller was looking at; a
-- live listing flips between active and sold out with it
DROP FUNCTION IF EXISTS storefront.shop_set_listing_stock(bigint, text, text, text, text);
CREATE FUNCTION storefront.shop_set_listing_stock(p_seller_id bigint, p_actor text, p_listing_id text, p_expected_qty text, p_qty text) RETURNS SETOF storefront.shop_listing_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_l storefront.store_listings%ROWTYPE; v_cur int; v_qty int; v_expected int; v_status storefront.listing_status;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_qty := storefront.shop_parse_stock(p_qty, 'qty');
  v_expected := storefront.shop_parse_stock(p_expected_qty, 'qty');
  v_l := storefront.shop_lock_listing(p_seller_id, storefront.shop_parse_id(p_listing_id, 'listing'));
  v_cur := COALESCE(v_l.qty_available, 0);
  IF v_cur <> v_expected THEN
    RAISE EXCEPTION 'Stock changed while you were editing — it''s % now. Check the number and save again.', v_cur
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:qty';
  END IF;
  IF v_qty = v_cur THEN
    RETURN QUERY SELECT v_l.id, v_l.status::text, v_cur, 'No change.'::text;
    RETURN;
  END IF;
  -- statusAfterStockChange: only live listings flip; a restock with no wallet stays sold out
  v_status := CASE WHEN v_l.status NOT IN ('active', 'sold_out') THEN v_l.status
                   WHEN v_qty > 0 AND storefront.shop_has_wallet(p_seller_id) THEN 'active'::storefront.listing_status
                   ELSE 'sold_out'::storefront.listing_status END;
  UPDATE storefront.store_listings l SET qty_available = v_qty, status = v_status WHERE l.id = v_l.id AND l.seller_id = p_seller_id;
  PERFORM storefront.shop_audit('storefront.store_listings', v_l.id, 'listing_stock_set', p_actor,
    jsonb_build_object('qtyAvailable', v_l.qty_available, 'status', v_l.status), jsonb_build_object('qtyAvailable', v_qty, 'status', v_status));
  RETURN QUERY SELECT v_l.id, v_status::text, v_qty, 'Stock set to ' || v_qty || '.';
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_set_listing_stock(bigint, text, text, text, text) FROM PUBLIC;

-- ── wallets ──
DROP FUNCTION IF EXISTS storefront.shop_list_wallets(bigint);
CREATE FUNCTION storefront.shop_list_wallets(p_seller_id bigint) RETURNS SETOF storefront.shop_wallet_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT w.id, w.rail::text, w.token, w.address, w.label, w.is_default_settlement,
         w.token = 'USDC', storefront.shop_wallet_removal_block(p_seller_id, w.id), w.created_at
    FROM storefront.seller_wallets w
   WHERE w.seller_id = p_seller_id AND w.active AND w.rail <> 'cash'
   ORDER BY w.is_default_settlement DESC, w.created_at, w.id
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_wallets(bigint) FROM PUBLIC;

-- Add a payout wallet. A wallet removed earlier comes back on the same row
-- (old orders keep pointing at it). The first USDC wallet becomes the default.
DROP FUNCTION IF EXISTS storefront.shop_add_wallet(bigint, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_add_wallet(p_seller_id bigint, p_actor text, p_rail text, p_token text, p_address text, p_label text, p_make_default text)
RETURNS SETOF storefront.shop_wallet_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_rail text := lower(btrim(COALESCE(p_rail, ''))); v_token text := upper(btrim(COALESCE(p_token, '')));
        v_addr text := btrim(COALESCE(p_address, '')); v_label text := NULLIF(btrim(COALESCE(p_label, '')), '');
        v_mk boolean := lower(btrim(COALESCE(p_make_default, ''))) IN ('true', 'on', '1', 'yes');
        v_key text; v_same storefront.seller_wallets%ROWTYPE; v_def bigint; v_n int; v_isdef boolean; v_id bigint;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  IF v_rail NOT IN ('eth', 'sol') THEN
    RAISE EXCEPTION 'Pick the network this wallet is on.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:rail';
  END IF;
  IF v_token NOT IN ('USDC', 'USDT') THEN
    RAISE EXCEPTION 'Pick USDC or USDT.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:token';
  END IF;
  IF char_length(COALESCE(v_label, '')) > 40 THEN
    RAISE EXCEPTION 'Keep the label to 40 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:label';
  END IF;
  IF v_addr = '' THEN
    RAISE EXCEPTION 'Paste your wallet address.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:address';
  END IF;
  IF v_rail = 'sol' AND v_addr !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
    RAISE EXCEPTION '%', CASE WHEN v_addr ~ '^0x[0-9a-fA-F]{40}$'
      THEN 'That''s an Ethereum-style address. Pick Ethereum, or paste your Solana address.'
      ELSE 'A Solana address is 32–44 letters and numbers (never 0, O, I or l). Copy it again from your wallet.' END
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:address';
  END IF;
  IF v_rail = 'eth' AND v_addr !~ '^0x[0-9a-fA-F]{40}$' THEN
    RAISE EXCEPTION '%', CASE WHEN v_addr ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      THEN 'That looks like a Solana address. Pick Solana, or paste your Ethereum address (0x…).'
      ELSE 'An Ethereum address is 0x followed by 40 letters and numbers (0–9, a–f). Copy it again from your wallet.' END
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:address';
  END IF;
  IF v_mk AND v_token <> 'USDC' THEN
    RAISE EXCEPTION 'Only a USDC wallet can be the default — pay-with-any-token settles in USDC.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:makeDefault';
  END IF;
  v_key := CASE WHEN v_rail = 'sol' THEN v_addr ELSE lower(v_addr) END;

  PERFORM 1 FROM storefront.seller_wallets w WHERE w.seller_id = p_seller_id ORDER BY w.id FOR UPDATE;
  SELECT w.* INTO v_same FROM storefront.seller_wallets w
   WHERE w.seller_id = p_seller_id AND w.rail::text = v_rail AND w.token = v_token
     AND (CASE WHEN w.rail = 'sol' THEN btrim(w.address) ELSE lower(btrim(w.address)) END) = v_key
   ORDER BY w.active DESC, w.id LIMIT 1;
  IF v_same.id IS NOT NULL AND v_same.active THEN
    RAISE EXCEPTION 'That wallet is already on your list.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:address';
  END IF;
  SELECT count(*) INTO v_n FROM storefront.seller_wallets w WHERE w.seller_id = p_seller_id AND w.active AND w.rail <> 'cash';
  IF v_n >= 8 THEN
    RAISE EXCEPTION 'You can keep up to 8 wallets. Remove one you no longer use first.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT w.id INTO v_def FROM storefront.seller_wallets w WHERE w.seller_id = p_seller_id AND w.is_default_settlement;
  v_isdef := v_token = 'USDC' AND (v_mk OR v_def IS NULL);
  IF v_isdef AND v_def IS NOT NULL THEN
    -- clear first: the one-default index is checked row by row
    UPDATE storefront.seller_wallets SET is_default_settlement = false WHERE id = v_def AND seller_id = p_seller_id;
  END IF;
  BEGIN
    IF v_same.id IS NOT NULL THEN
      UPDATE storefront.seller_wallets SET active = true, address = v_addr, label = v_label, is_default_settlement = v_isdef
       WHERE id = v_same.id AND seller_id = p_seller_id;
      v_id := v_same.id;
    ELSE
      INSERT INTO storefront.seller_wallets (seller_id, rail, token, address, label, is_default_settlement)
      VALUES (p_seller_id, v_rail::public.payment_rail, v_token, v_addr, v_label, v_isdef) RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That wallet is already on your list.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:address';
  END;
  PERFORM storefront.shop_audit('storefront.seller_wallets', v_id,
    CASE WHEN v_same.id IS NOT NULL THEN 'wallet_restored' ELSE 'wallet_added' END, p_actor, NULL,
    jsonb_build_object('rail', v_rail, 'token', v_token, 'address', v_addr, 'label', v_label, 'isDefault', v_isdef,
                       'previousDefault', CASE WHEN v_isdef THEN v_def END));
  RETURN QUERY SELECT v_id, v_isdef, v_same.id IS NOT NULL, CASE WHEN v_isdef THEN v_def END,
    CASE WHEN v_isdef THEN 'Wallet added as your default.' ELSE 'Wallet added.' END;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_add_wallet(bigint, text, text, text, text, text, text) FROM PUBLIC;

-- soft removal: the row stays (orders reference it) with active = false and no default flag
DROP FUNCTION IF EXISTS storefront.shop_remove_wallet(bigint, text, text);
CREATE FUNCTION storefront.shop_remove_wallet(p_seller_id bigint, p_actor text, p_wallet_id text) RETURNS SETOF storefront.shop_wallet_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_id bigint; v_w storefront.seller_wallets%ROWTYPE; v_block text;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_id := storefront.shop_parse_id(p_wallet_id, 'wallet');
  PERFORM 1 FROM storefront.seller_wallets w WHERE w.seller_id = p_seller_id ORDER BY w.id FOR UPDATE;
  SELECT * INTO v_w FROM storefront.seller_wallets w WHERE w.id = v_id AND w.seller_id = p_seller_id AND w.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That wallet isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  v_block := storefront.shop_wallet_removal_block(p_seller_id, v_w.id);
  IF v_block IS NOT NULL THEN
    RAISE EXCEPTION '%', v_block USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE storefront.seller_wallets SET active = false, is_default_settlement = false WHERE id = v_w.id AND seller_id = p_seller_id;
  PERFORM storefront.shop_audit('storefront.seller_wallets', v_w.id, 'wallet_removed', p_actor,
    jsonb_build_object('rail', v_w.rail, 'token', v_w.token, 'address', v_w.address, 'isDefault', v_w.is_default_settlement),
    jsonb_build_object('active', false));
  RETURN QUERY SELECT v_w.id, false, false, NULL::bigint, 'Wallet removed.'::text;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_remove_wallet(bigint, text, text) FROM PUBLIC;

-- move the default settlement wallet to this (live, USDC) wallet
DROP FUNCTION IF EXISTS storefront.shop_set_default_wallet(bigint, text, text);
CREATE FUNCTION storefront.shop_set_default_wallet(p_seller_id bigint, p_actor text, p_wallet_id text) RETURNS SETOF storefront.shop_wallet_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_id bigint; v_w storefront.seller_wallets%ROWTYPE; v_prev bigint;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  v_id := storefront.shop_parse_id(p_wallet_id, 'wallet');
  PERFORM 1 FROM storefront.seller_wallets w WHERE w.seller_id = p_seller_id ORDER BY w.id FOR UPDATE;
  SELECT * INTO v_w FROM storefront.seller_wallets w WHERE w.id = v_id AND w.seller_id = p_seller_id AND w.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That wallet isn''t on your list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_w.token <> 'USDC' THEN
    RAISE EXCEPTION 'Only a USDC wallet can be the default — pay-with-any-token settles in USDC.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_w.is_default_settlement THEN
    RETURN QUERY SELECT v_w.id, true, false, NULL::bigint, 'Already your default.'::text;
    RETURN;
  END IF;
  -- clear first: the one-default index is checked row by row
  UPDATE storefront.seller_wallets SET is_default_settlement = false
   WHERE seller_id = p_seller_id AND is_default_settlement AND id <> v_w.id RETURNING id INTO v_prev;
  UPDATE storefront.seller_wallets SET is_default_settlement = true WHERE id = v_w.id AND seller_id = p_seller_id;
  PERFORM storefront.shop_audit('storefront.seller_wallets', v_w.id, 'wallet_default_set', p_actor,
    jsonb_build_object('previousDefault', v_prev), jsonb_build_object('isDefault', true));
  RETURN QUERY SELECT v_w.id, true, false, v_prev, 'Default wallet updated.'::text;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_set_default_wallet(bigint, text, text) FROM PUBLIC;

-- ── ship-from + Shippo key ──
DROP FUNCTION IF EXISTS storefront.shop_get_ship_from(bigint);
CREATE FUNCTION storefront.shop_get_ship_from(p_seller_id bigint) RETURNS SETOF storefront.shop_ship_from_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT f.name, f.company, f.street1, f.street2, f.city, f.state, f.zip, f.country, f.phone, f.email,
         f.seller_id IS NOT NULL, f.shippo_api_key IS NOT NULL,
         CASE WHEN f.shippo_api_key IS NOT NULL THEN right(f.shippo_api_key, 4) END,
         COALESCE(f.shippo_api_key LIKE 'shippo\_test\_%', false), f.updated_at, NULL::text
    FROM storefront.sellers s
    LEFT JOIN storefront.seller_ship_from f ON f.seller_id = s.id
   WHERE s.id = p_seller_id
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_get_ship_from(bigint) FROM PUBLIC;

-- the ship-from address (upsert); the Shippo key is untouched here
DROP FUNCTION IF EXISTS storefront.shop_set_ship_from(bigint, text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.shop_set_ship_from(p_seller_id bigint, p_actor text, p_name text, p_company text, p_street1 text, p_street2 text, p_city text, p_state text, p_zip text, p_country text, p_phone text, p_email text)
RETURNS SETOF storefront.shop_ship_from_row
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_name text := btrim(COALESCE(p_name, '')); v_company text := NULLIF(btrim(COALESCE(p_company, '')), '');
        v_street1 text := btrim(COALESCE(p_street1, '')); v_street2 text := NULLIF(btrim(COALESCE(p_street2, '')), '');
        v_city text := btrim(COALESCE(p_city, '')); v_state text := upper(btrim(COALESCE(p_state, '')));
        v_zip text := btrim(COALESCE(p_zip, '')); v_country text := upper(btrim(COALESCE(NULLIF(p_country, ''), 'US')));
        v_phone_raw text := btrim(COALESCE(p_phone, '')); v_phone text; v_email text := lower(btrim(COALESCE(p_email, '')));
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  IF char_length(v_name) < 1 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'Enter the name on the return address (up to 80 characters).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:name';
  END IF;
  IF v_company IS NOT NULL AND char_length(v_company) > 80 THEN
    RAISE EXCEPTION 'Keep the company name to 80 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:company';
  END IF;
  IF char_length(v_street1) < 1 OR char_length(v_street1) > 100 OR (v_street2 IS NOT NULL AND char_length(v_street2) > 100) THEN
    RAISE EXCEPTION 'Enter the street address (up to 100 characters per line).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:street1';
  END IF;
  IF char_length(v_city) < 1 OR char_length(v_city) > 60 THEN
    RAISE EXCEPTION 'Enter the city.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:city';
  END IF;
  IF v_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'Country is a two-letter code, like US.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:country';
  END IF;
  IF v_country = 'US' AND v_state !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'State is the two-letter code, like TX.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:state';
  END IF;
  IF v_country = 'US' AND v_zip !~ '^[0-9]{5}(-[0-9]{4})?$' THEN
    RAISE EXCEPTION 'ZIP is 5 digits (or ZIP+4, like 78701-1234).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:zip';
  END IF;
  IF v_country <> 'US' AND (v_state = '' OR v_zip = '') THEN
    RAISE EXCEPTION 'Enter the region and postal code.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:zip';
  END IF;
  v_phone := CASE WHEN left(v_phone_raw, 1) = '+' THEN '+' || regexp_replace(substr(v_phone_raw, 2), '[^0-9]', '', 'g')
                  ELSE regexp_replace(v_phone_raw, '[^0-9]', '', 'g') END;
  IF v_phone !~ '^\+?[0-9]{10,15}$' THEN
    RAISE EXCEPTION 'Enter a phone number with area code — carriers require it on the label.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:phone';
  END IF;
  IF char_length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Enter the email Shippo may put on the label.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:email';
  END IF;
  INSERT INTO storefront.seller_ship_from (seller_id, name, company, street1, street2, city, state, zip, country, phone, email, updated_by)
  VALUES (p_seller_id, v_name, v_company, v_street1, v_street2, v_city, v_state, v_zip, v_country, v_phone, v_email, p_actor)
  ON CONFLICT (seller_id) DO UPDATE
     SET name = EXCLUDED.name, company = EXCLUDED.company, street1 = EXCLUDED.street1, street2 = EXCLUDED.street2,
         city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip, country = EXCLUDED.country,
         phone = EXCLUDED.phone, email = EXCLUDED.email, updated_by = EXCLUDED.updated_by;
  -- the address is the shop's return address, not member data; still kept out of the payload beyond city/state
  PERFORM storefront.shop_audit('storefront.seller_ship_from', p_seller_id, 'ship_from_set', p_actor, NULL,
    jsonb_build_object('city', v_city, 'state', v_state, 'country', v_country));
  RETURN QUERY SELECT r.name, r.company, r.street1, r.street2, r.city, r.state, r.zip, r.country, r.phone, r.email, r.complete,
                      r.has_shippo_key, r.shippo_key_last4, r.shippo_key_is_test, r.updated_at, 'Ship-from address saved.'::text
    FROM storefront.shop_get_ship_from(p_seller_id) r;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_set_ship_from(bigint, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- the shop's own Shippo key ('' clears it); audited as mode + last 4 only
DROP FUNCTION IF EXISTS storefront.shop_set_shippo_key(bigint, text, text);
CREATE FUNCTION storefront.shop_set_shippo_key(p_seller_id bigint, p_actor text, p_key text) RETURNS SETOF storefront.shop_ship_from_row
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_key text := NULLIF(btrim(COALESCE(p_key, '')), ''); v_old text; v_had boolean;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  IF v_key IS NOT NULL AND v_key !~ '^shippo_(live|test)_[A-Za-z0-9]{20,64}$' THEN
    RAISE EXCEPTION 'That doesn''t look like a Shippo API token (shippo_live_… or shippo_test_…). Copy it from Shippo → Settings → API.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:key';
  END IF;
  SELECT f.shippo_api_key INTO v_old FROM storefront.seller_ship_from f WHERE f.seller_id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Save your ship-from address first, then add the Shippo key.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_had := v_old IS NOT NULL;
  UPDATE storefront.seller_ship_from
     SET shippo_api_key = v_key, shippo_key_set_at = CASE WHEN v_key IS NULL THEN NULL ELSE now() END,
         shippo_key_set_by = CASE WHEN v_key IS NULL THEN NULL ELSE p_actor END, updated_by = p_actor
   WHERE seller_id = p_seller_id;
  PERFORM storefront.shop_audit('storefront.seller_ship_from', p_seller_id,
    CASE WHEN v_key IS NULL THEN 'shippo_key_cleared' ELSE 'shippo_key_set' END, p_actor,
    jsonb_build_object('hadKey', v_had, 'last4', CASE WHEN v_had THEN right(v_old, 4) END),
    jsonb_build_object('hasKey', v_key IS NOT NULL, 'last4', CASE WHEN v_key IS NOT NULL THEN right(v_key, 4) END,
                       'isTest', COALESCE(v_key LIKE 'shippo\_test\_%', false)));
  RETURN QUERY SELECT r.name, r.company, r.street1, r.street2, r.city, r.state, r.zip, r.country, r.phone, r.email, r.complete,
                      r.has_shippo_key, r.shippo_key_last4, r.shippo_key_is_test, r.updated_at,
                      CASE WHEN v_key IS NULL THEN 'Shippo key removed.' ELSE 'Shippo key saved.' END
    FROM storefront.shop_get_ship_from(p_seller_id) r;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_set_shippo_key(bigint, text, text) FROM PUBLIC;

-- the ONLY function that returns a key, to the shop it belongs to, for the
-- label panel's per-request Authorization header
DROP FUNCTION IF EXISTS storefront.shop_get_shippo_key(bigint);
CREATE FUNCTION storefront.shop_get_shippo_key(p_seller_id bigint) RETURNS SETOF storefront.shop_key_row
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_key text;
BEGIN
  SELECT f.shippo_api_key INTO v_key FROM storefront.seller_ship_from f WHERE f.seller_id = p_seller_id;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Add your Shippo key first.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN QUERY SELECT v_key;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_get_shippo_key(bigint) FROM PUBLIC;

-- ── 9. portal wrappers: storefront.portal_*(p_email, …) — the ONLY things the role may run
DROP FUNCTION IF EXISTS storefront.portal_me(text);
CREATE FUNCTION storefront.portal_me(p_email text)
RETURNS TABLE (seller_id bigint, slug text, display_name text, seller_status text, fee_pct numeric, managed_in_ops boolean,
               wallet_count int, has_default_wallet boolean, ship_from_complete boolean,
               has_shippo_key boolean, shippo_key_last4 text, shippo_key_is_test boolean, to_ship int, operator_email text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_seller bigint := storefront.portal_resolve_seller(p_email); v_email text := lower(btrim(p_email));
BEGIN
  UPDATE storefront.seller_operators o SET last_seen_at = now() WHERE lower(o.email) = v_email AND o.revoked_at IS NULL AND o.seller_id = v_seller;
  RETURN QUERY SELECT m.seller_id, m.slug, m.display_name, m.seller_status, m.fee_pct, m.managed_in_ops, m.wallet_count, m.has_default_wallet,
                      m.ship_from_complete, m.has_shippo_key, m.shippo_key_last4, m.shippo_key_is_test, m.to_ship, v_email
    FROM storefront.shop_me(v_seller) m;
END
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_order_counts(text);
CREATE FUNCTION storefront.portal_order_counts(p_email text) RETURNS SETOF storefront.shop_counts_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_order_counts(storefront.portal_resolve_seller(p_email))
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_list_orders(text, text, text);
CREATE FUNCTION storefront.portal_list_orders(p_email text, p_status text DEFAULT '', p_limit text DEFAULT '100') RETURNS SETOF storefront.shop_order_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_orders(storefront.portal_resolve_seller(p_email), p_status, p_limit)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_list_shipments(text, text);
CREATE FUNCTION storefront.portal_list_shipments(p_email text, p_order_id text) RETURNS SETOF storefront.shop_shipment_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_shipments(storefront.portal_resolve_seller(p_email), p_order_id)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_mark_shipped(text, text, text, text, text);
CREATE FUNCTION storefront.portal_mark_shipped(p_email text, p_order_id text, p_carrier text, p_tracking_number text, p_expected_status text) RETURNS SETOF storefront.shop_order_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_mark_shipped(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_order_id, p_carrier, p_tracking_number, p_expected_status)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_mark_delivered(text, text);
CREATE FUNCTION storefront.portal_mark_delivered(p_email text, p_order_id text) RETURNS SETOF storefront.shop_order_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_mark_delivered(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_order_id)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_begin_label(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS storefront.portal_begin_label(text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_begin_label(p_email text, p_order_id text, p_rate_id text, p_rate_amount text, p_carrier text, p_servicelevel text, p_key_fingerprint text) RETURNS SETOF storefront.shop_label_begin_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_begin_label(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_order_id, p_rate_id, p_rate_amount, p_carrier, p_servicelevel, p_key_fingerprint)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_record_label(text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_record_label(p_email text, p_shipment_id text, p_transaction_id text, p_carrier text, p_tracking_number text, p_label_url text, p_label_cost_usd text) RETURNS SETOF storefront.shop_label_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_record_label(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_shipment_id, p_transaction_id, p_carrier, p_tracking_number, p_label_url, p_label_cost_usd)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_void_shipment(text, text, text, text);
CREATE FUNCTION storefront.portal_void_shipment(p_email text, p_shipment_id text, p_refund_status text, p_refund_object_id text) RETURNS SETOF storefront.shop_void_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_void_shipment(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_shipment_id, p_refund_status, p_refund_object_id)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_set_refund_status(text, text, text, text, text);
CREATE FUNCTION storefront.portal_set_refund_status(p_email text, p_shipment_id text, p_refund_status text, p_refund_object_id text, p_note text) RETURNS SETOF storefront.shop_refund_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_set_refund_status(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_shipment_id, p_refund_status, p_refund_object_id, p_note)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_list_listings(text);
CREATE FUNCTION storefront.portal_list_listings(p_email text) RETURNS SETOF storefront.shop_listing_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_listings(storefront.portal_resolve_seller(p_email))
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_create_listing(text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_create_listing(p_email text, p_title text, p_mass_label text, p_description_md text, p_price_usd text, p_shipping_usd text, p_qty text, p_status text) RETURNS SETOF storefront.shop_listing_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_create_listing(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_status)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_update_listing(text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_update_listing(p_email text, p_listing_id text, p_title text, p_mass_label text, p_description_md text, p_price_usd text, p_shipping_usd text, p_qty text, p_expected_qty text, p_status text) RETURNS SETOF storefront.shop_listing_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_update_listing(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_listing_id, p_title, p_mass_label, p_description_md, p_price_usd, p_shipping_usd, p_qty, p_expected_qty, p_status)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_set_listing_status(text, text, text);
CREATE FUNCTION storefront.portal_set_listing_status(p_email text, p_listing_id text, p_status text) RETURNS SETOF storefront.shop_listing_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_set_listing_status(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_listing_id, p_status)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_set_listing_stock(text, text, text, text);
CREATE FUNCTION storefront.portal_set_listing_stock(p_email text, p_listing_id text, p_expected_qty text, p_qty text) RETURNS SETOF storefront.shop_listing_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_set_listing_stock(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_listing_id, p_expected_qty, p_qty)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_list_wallets(text);
CREATE FUNCTION storefront.portal_list_wallets(p_email text) RETURNS SETOF storefront.shop_wallet_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_wallets(storefront.portal_resolve_seller(p_email))
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_add_wallet(text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_add_wallet(p_email text, p_rail text, p_token text, p_address text, p_label text, p_make_default text) RETURNS SETOF storefront.shop_wallet_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_add_wallet(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_rail, p_token, p_address, p_label, p_make_default)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_remove_wallet(text, text);
CREATE FUNCTION storefront.portal_remove_wallet(p_email text, p_wallet_id text) RETURNS SETOF storefront.shop_wallet_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_remove_wallet(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_wallet_id)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_set_default_wallet(text, text);
CREATE FUNCTION storefront.portal_set_default_wallet(p_email text, p_wallet_id text) RETURNS SETOF storefront.shop_wallet_result
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_set_default_wallet(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_wallet_id)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_get_ship_from(text);
CREATE FUNCTION storefront.portal_get_ship_from(p_email text) RETURNS SETOF storefront.shop_ship_from_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_get_ship_from(storefront.portal_resolve_seller(p_email))
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_set_ship_from(text, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION storefront.portal_set_ship_from(p_email text, p_name text, p_company text, p_street1 text, p_street2 text, p_city text, p_state text, p_zip text, p_country text, p_phone text, p_ship_email text) RETURNS SETOF storefront.shop_ship_from_row
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_set_ship_from(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_name, p_company, p_street1, p_street2, p_city, p_state, p_zip, p_country, p_phone, p_ship_email)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_set_shippo_key(text, text);
CREATE FUNCTION storefront.portal_set_shippo_key(p_email text, p_key text) RETURNS SETOF storefront.shop_ship_from_row
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_set_shippo_key(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_key)
$fn$;

DROP FUNCTION IF EXISTS storefront.portal_get_shippo_key(text);
CREATE FUNCTION storefront.portal_get_shippo_key(p_email text) RETURNS SETOF storefront.shop_key_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_get_shippo_key(storefront.portal_resolve_seller(p_email))
$fn$;

-- ── 10. grants: exactly the portal_* entry points ──────────────────────────
DO $mig$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'storefront' AND p.proname LIKE 'portal\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    IF r.sig::text NOT IN ('storefront.portal_resolve_seller(text)', 'storefront.portal_actor(text)') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO p2_seller_portal', r.sig);
    END IF;
  END LOOP;
END
$mig$;

-- ── 11. the untracked least-privilege STOREFRONT role (1790101500) must never
-- see these tables: its blanket GRANT SELECT ON ALL TABLES IN SCHEMA
-- storefront and its default privileges would hand the storefront the Shippo
-- keys, operator emails, return addresses and label URLs (a label PDF carries
-- the buyer's address). 1790101500 carries the mirror-image REVOKE for the
-- case where it is applied after this file.
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_storefront') THEN
    REVOKE ALL ON storefront.seller_operators, storefront.seller_ship_from, storefront.store_shipments FROM p2_storefront;
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103600_seller_portal.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103600_seller_portal.sql');
