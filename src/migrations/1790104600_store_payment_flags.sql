-- Store payments that need a person: a flag, an organizer list, and the swap
-- an organizer records to convert a wrong-token payment (Ian, 2026-11-10).
--
-- ST-2026-0017 (PRT, $160, asked USDT on Solana): the buyer sent 1.8695957
-- SOL. The verifier stored that as an unexplained "mismatch" at $0 — no one
-- was told. Ian then swapped the SOL to USDT with Jupiter from the receiving
-- wallet and that swap's hash was pasted on the order; the verifier counted
-- every transfer INTO the wallet, so the swap's USDC hop (in and straight back
-- out) was added to the USDT and the order read $320.51 paid. Ian: "This
-- should throw a flag for us to look at when the TX reads a different
-- payment token … Only the USDT should have been recorded." Settled with Ian
-- the same day: the flag reaches the organizers as a list in P2 Collective
-- Orders AND an email; the organizer resolves it by recording the swap.
--
-- What the storefront now writes on a store claim (p2collective-app
-- lib/payments/classify.ts, lib/store/payments.ts):
--   onchain.gains   what the receiving wallet NETTED per token in that one
--                   transaction (in minus out), so a swap's pass-through hop
--                   counts zero; only stablecoin gains count as dollars.
--   flags           off_token     the wallet gained a token the order did not
--                                 ask for: the chain's native coin, an
--                                 unlisted token (never counted), or another
--                                 stablecoin (counted at face value)
--                   self_signed   the receiving wallet signed the transaction
--                                 itself — a swap or transfer the shop made,
--                                 never a buyer's payment: it pays nothing
--                                 (verified_usd 0) unless an organizer
--                                 records it as a conversion
--   flag_note       one plain sentence for the organizers (no buyer email,
--                   no address, no key — like every audit row here)
--   flag_notified_at  the storefront worker's stamp once the organizer email
--                   went out (the worker is the outbox: it retries until sent)
-- A conversion is a payment row whose conversion_of names the flagged claim
-- it converts, on the SAME order (composite FK); recorded_by is the organizer
-- who recorded it. The storefront worker verifies it like any pending claim
-- (a self-signed swap is expected there), credits the wallet's net stablecoin
-- gain, pays the order once claims cover the total, and resolves the flag.
--
-- Organizer entry points (owner-only; P2 Collective Orders → Payments to
-- check): store_payments_to_check, store_record_conversion,
-- store_resolve_payment_flag. Nothing here moves money by itself: a recorded
-- swap is a PENDING claim until the chain shows the wallet's gain.

-- ── 1. columns ──────────────────────────────────────────────────────────────
ALTER TABLE storefront.payments
  ADD COLUMN IF NOT EXISTS flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS flag_note text,
  ADD COLUMN IF NOT EXISTS flag_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS flag_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS flag_resolved_by text,
  ADD COLUMN IF NOT EXISTS flag_resolution text,
  ADD COLUMN IF NOT EXISTS conversion_of bigint,
  ADD COLUMN IF NOT EXISTS recorded_by text;

DO $$ BEGIN
  ALTER TABLE storefront.payments ADD CONSTRAINT payments_flags_known
    CHECK (flags <@ ARRAY['off_token', 'self_signed']::text[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- a flag carries its sentence; a resolution needs a flag, a time, a person and a reason together
  ALTER TABLE storefront.payments ADD CONSTRAINT payments_flag_shape CHECK (
    (cardinality(flags) = 0 OR (flag_note IS NOT NULL AND btrim(flag_note) <> ''))
    AND ((flag_resolved_at IS NULL) = (flag_resolved_by IS NULL))
    AND ((flag_resolved_at IS NULL) = (flag_resolution IS NULL))
    AND (flag_resolved_at IS NULL OR cardinality(flags) > 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- a conversion is a store payment, converts another claim of the same order, never itself
  ALTER TABLE storefront.payments ADD CONSTRAINT payments_conversion_shape CHECK (
    conversion_of IS NULL OR (store_order_id IS NOT NULL AND conversion_of <> id AND recorded_by IS NOT NULL AND btrim(recorded_by) <> '')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sf_payments_id_store_order_uniq ON storefront.payments (id, store_order_id);
DO $$ BEGIN
  ALTER TABLE storefront.payments ADD CONSTRAINT payments_conversion_same_order
    FOREIGN KEY (conversion_of, store_order_id) REFERENCES storefront.payments (id, store_order_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS sf_payments_flag_open_idx ON storefront.payments (created_at)
  WHERE cardinality(flags) > 0 AND flag_resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS sf_payments_conversion_of_idx ON storefront.payments (conversion_of) WHERE conversion_of IS NOT NULL;

-- ── 1b. organizer free text, scrubbed before it is stored ───────────────────
-- An organizer's note on a recorded swap and the "what did you do" of a
-- handled flag land in audit_log and on the payment row, where the house rule
-- is that no buyer email, address or key is ever written. People explaining a
-- refund write such things, so they are replaced on the way in (Codex,
-- 2026-11-10): an email, a phone number, a street address and a key-shaped
-- secret (Stripe/Shippo/Anthropic/OpenAI-style sk-/pk- keys, GitHub, Slack,
-- AWS, PEM private keys, "api key: …"). Amounts of any precision, tokens,
-- wallet addresses, order numbers and transaction ids are left alone — they
-- are what a resolution is about. A bare 10-digit number reads as a phone
-- number and is removed: ambiguous, and privacy wins (the payment row keeps
-- the on-chain amounts anyway).
CREATE OR REPLACE FUNCTION storefront.scrub_organizer_text(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           btrim(COALESCE(p, '')),
           '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email removed]', 'g'),
           '(^|[^\w.])(\+?1[ -]?)?(\(\d{3}\)|\d{3})[ -]?\d{3}[ -]?\d{4}(?![\w.])', '\1[phone removed]', 'g'),
           '(^|[\s,(])\d{1,6}( [A-Za-z][A-Za-z0-9.''-]*){1,4} (street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|circle|cir|way|place|pl|parkway|pkwy|terrace|ter|trail|trl|highway|hwy)\M(?![-\w])\.?', '\1[address removed]', 'gi'),
           '\m(p\.?\s?o\.?\s?box|apt|suite|unit)\.?\s*#?\s*[A-Za-z0-9-]+', '[address removed]', 'gi'),
           '\m(shippo_(live|test)_[A-Za-z0-9]+|(sk|pk|rk)_(live|test)_[A-Za-z0-9]+|(sk|pk|rk)[-_][A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|(api|secret|private)[_-]?key[:= ]+\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]*(-----END [A-Z ]*PRIVATE KEY-----)?', '[key removed]', 'gi')
$fn$;

-- ── 2. what arrived, as one line (the drawers, the organizer list) ──────────
-- Prefers onchain.gains (net per token, written since this migration); older
-- rows fall back to the inbound transfers they recorded. Unlisted tokens are
-- named by contract, never priced.
CREATE OR REPLACE FUNCTION storefront.payment_received_text(p_onchain jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  WITH src AS (
    SELECT CASE WHEN jsonb_typeof(p_onchain->'gains') = 'array' THEN p_onchain->'gains'
                WHEN jsonb_typeof(p_onchain->'transfers') = 'array' THEN p_onchain->'transfers'
                ELSE '[]'::jsonb END AS arr
  ), known AS (
    SELECT t->>'token' AS token, sum((t->>'amount')::numeric) AS amount
      FROM src, jsonb_array_elements(src.arr) t
     WHERE jsonb_typeof(t) = 'object' AND COALESCE(t->>'token', '') <> '' AND jsonb_typeof(t->'amount') = 'number'
     GROUP BY 1
    HAVING sum((t->>'amount')::numeric) > 0
  ), other AS (
    SELECT count(*) AS n
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_onchain->'others') = 'array' THEN p_onchain->'others' ELSE '[]'::jsonb END) o
     WHERE jsonb_typeof(o) = 'object'
  )
  SELECT NULLIF(concat_ws(' + ',
           (SELECT string_agg(trim_scale(k.amount)::text || ' ' || k.token, ' + ' ORDER BY k.amount DESC, k.token) FROM known k),
           (SELECT CASE WHEN n = 1 THEN 'an unlisted token' WHEN n > 1 THEN n || ' unlisted tokens' END FROM other)), '')
$fn$;

-- ── 3. the shop drawers' read (1790104500), now with the flag ───────────────
DROP FUNCTION IF EXISTS storefront.portal_list_payments(text, text);
DROP FUNCTION IF EXISTS storefront.shop_list_payments(bigint, text);
CREATE FUNCTION storefront.shop_list_payments(p_seller_id bigint, p_order_id text)
RETURNS TABLE (id bigint, store_order_id bigint, rail text, received text, status text,
               amount_claimed_usd numeric, verified_usd numeric, tx_hash text, paid_to text,
               note text, created_at timestamptz, verified_at timestamptz,
               flags text[], flag_note text, flag_resolved_at timestamptz, flag_resolution text,
               conversion_of bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT p.id, p.store_order_id, p.rail::text,
         storefront.payment_received_text(p.onchain),
         p.status::text, p.amount_claimed_usd, p.verified_usd, p.tx_hash,
         CASE WHEN jsonb_typeof(p.onchain->'wallet') = 'string' THEN p.onchain->>'wallet' END,
         CASE WHEN p.status IN ('pending', 'rejected', 'mismatch') THEN p.verify_error END,
         p.created_at, p.verified_at,
         p.flags, p.flag_note, p.flag_resolved_at, p.flag_resolution, p.conversion_of
    FROM storefront.payments p
    JOIN storefront.store_orders o ON o.id = p.store_order_id
   WHERE p.store_order_id = storefront.shop_parse_id(p_order_id, 'order')
     AND o.seller_id = p_seller_id
   ORDER BY (p.status <> 'rejected') DESC, p.created_at DESC, p.id DESC
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_payments(bigint, text) FROM PUBLIC;

CREATE FUNCTION storefront.portal_list_payments(p_email text, p_order_id text)
RETURNS TABLE (id bigint, store_order_id bigint, rail text, received text, status text,
               amount_claimed_usd numeric, verified_usd numeric, tx_hash text, paid_to text,
               note text, created_at timestamptz, verified_at timestamptz,
               flags text[], flag_note text, flag_resolved_at timestamptz, flag_resolution text,
               conversion_of bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_payments(storefront.portal_resolve_seller(p_email), p_order_id)
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.portal_list_payments(text, text) FROM PUBLIC;
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_seller_portal') THEN
    GRANT EXECUTE ON FUNCTION storefront.portal_list_payments(text, text) TO p2_seller_portal;
  END IF;
END
$mig$;

-- ── 4. the organizers' list (P2 Collective Orders → Payments to check) ──────
-- p_scope 'open' = flagged and not resolved (oldest first); 'resolved' = the
-- last 60 days' resolved flags (newest first). Every shop: the houses (P²,
-- PRT), the organizer-run shops and member shops. The buyer is named by the
-- handle they verified with — never their email or address.
DROP FUNCTION IF EXISTS storefront.store_payments_to_check(text);
CREATE FUNCTION storefront.store_payments_to_check(p_scope text DEFAULT 'open')
RETURNS TABLE (payment_id bigint, store_order_id bigint, order_number text, order_status text, order_total_usd numeric,
               shop_name text, shop_kind text, house_source text, telegram_username text, discord_username text,
               rail text, status text, flags text[], flag_note text, received text, verified_usd numeric,
               tx_hash text, created_at timestamptz, flag_notified_at timestamptz,
               flag_resolved_at timestamptz, flag_resolved_by text, flag_resolution text,
               conversion_id bigint, conversion_status text, conversion_tx_hash text, conversion_usd numeric,
               conversion_note text, conversion_recorded_by text, conversion_created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_scope text := lower(btrim(COALESCE(p_scope, 'open')));
BEGIN
  IF v_scope NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'Unknown list: %.', p_scope USING ERRCODE = 'invalid_parameter_value', HINT = 'field:scope';
  END IF;
  RETURN QUERY
    SELECT p.id, o.id, o.order_number, o.status::text, o.total_usd,
           s.display_name, s.kind::text, s.house_source::text, o.telegram_username, o.discord_username,
           p.rail::text, p.status::text, p.flags, p.flag_note, storefront.payment_received_text(p.onchain), p.verified_usd,
           p.tx_hash, p.created_at, p.flag_notified_at,
           p.flag_resolved_at, p.flag_resolved_by, p.flag_resolution,
           c.id, c.status::text, c.tx_hash, c.verified_usd, c.verify_error, c.recorded_by, c.created_at
      FROM storefront.payments p
      JOIN storefront.store_orders o ON o.id = p.store_order_id
      JOIN storefront.sellers s ON s.id = o.seller_id
      LEFT JOIN LATERAL (
        SELECT c1.* FROM storefront.payments c1
         WHERE c1.conversion_of = p.id
         ORDER BY (c1.status <> 'rejected') DESC, c1.created_at DESC, c1.id DESC
         LIMIT 1
      ) c ON true
     WHERE cardinality(p.flags) > 0
       AND CASE WHEN v_scope = 'open' THEN p.flag_resolved_at IS NULL
                ELSE p.flag_resolved_at IS NOT NULL AND p.flag_resolved_at >= now() - interval '60 days' END
     ORDER BY CASE WHEN v_scope = 'open' THEN extract(epoch FROM p.created_at) ELSE -extract(epoch FROM p.flag_resolved_at) END, p.id;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.store_payments_to_check(text) FROM PUBLIC;

-- ── 5. record the swap that converts a flagged claim ────────────────────────
-- Under the storefront's own tx-hash lock (42022, the class lib/store/
-- payments.ts claims under) and the order's row lock, so a buyer pasting the
-- same hash and an organizer recording it serialize. The hash must back no
-- live claim anywhere — except the case Ian hit: the swap already sits on
-- THIS order as a buyer-pasted claim the verifier held as self-signed; that
-- claim is closed (rejected, its flag resolved, "recorded again") and the
-- swap recorded fresh. Recording again replaces a recorded swap still being
-- checked (a mistyped hash would otherwise sit there for the 7-day claim
-- life). The new conversion is PENDING: the storefront worker checks it
-- on-chain within a minute, credits the wallet's net stablecoin gain, and
-- pays the order once its claims cover the total.
DROP FUNCTION IF EXISTS storefront.store_record_conversion(text, text, text, text);
CREATE FUNCTION storefront.store_record_conversion(p_actor text, p_payment_id text, p_tx_hash text, p_note text)
RETURNS TABLE (conversion_id bigint, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE
  v_actor text := btrim(COALESCE(p_actor, ''));
  v_note_raw text := btrim(COALESCE(p_note, ''));
  v_note text := NULLIF(storefront.scrub_organizer_text(p_note), '');
  v_hash text := btrim(COALESCE(p_tx_hash, ''));
  v_pid bigint;
  v_p storefront.payments%ROWTYPE;
  v_o storefront.store_orders%ROWTYPE;
  v_canon text;
  v_held storefront.payments%ROWTYPE;
  v_id bigint;
BEGIN
  IF v_actor = '' THEN
    RAISE EXCEPTION 'Sign in again — this app could not tell who you are.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(btrim(p_payment_id), '') !~ '^[1-9][0-9]{0,17}$' THEN
    RAISE EXCEPTION 'That payment isn''t on the list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  v_pid := btrim(p_payment_id)::bigint;
  IF char_length(v_note_raw) > 300 THEN
    RAISE EXCEPTION 'Keep the note under 300 characters.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:note';
  END IF;

  SELECT * INTO v_p FROM storefront.payments WHERE id = v_pid;
  IF NOT FOUND OR v_p.store_order_id IS NULL OR cardinality(v_p.flags) = 0 THEN
    RAISE EXCEPTION 'That payment isn''t on the list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_p.rail::text NOT IN ('eth', 'base', 'sol') THEN
    RAISE EXCEPTION 'Only an on-chain payment can be converted by a swap.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:tx_hash';
  END IF;
  IF (v_p.rail::text IN ('eth', 'base') AND v_hash !~ '^0x[0-9a-fA-F]{64}$')
     OR (v_p.rail::text = 'sol' AND v_hash !~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$') THEN
    RAISE EXCEPTION '%', CASE v_p.rail::text WHEN 'sol' THEN 'That doesn''t look like a Solana transaction signature.'
                              WHEN 'base' THEN 'That doesn''t look like a Base transaction hash (0x + 64 hex characters).'
                              ELSE 'That doesn''t look like an Ethereum transaction hash (0x + 64 hex characters).' END
      USING ERRCODE = 'invalid_parameter_value', HINT = 'field:tx_hash';
  END IF;
  v_canon := CASE WHEN v_p.rail::text IN ('eth', 'base') THEN lower(v_hash) ELSE v_hash END;

  PERFORM pg_advisory_xact_lock(42022, hashtext(v_canon));                         -- 1. the hash
  SELECT * INTO v_o FROM storefront.store_orders WHERE id = v_p.store_order_id FOR UPDATE;   -- 2. the order
  SELECT * INTO v_p FROM storefront.payments WHERE id = v_pid FOR UPDATE;                    -- 3. the flagged claim
  IF v_p.conversion_of IS NOT NULL THEN
    RAISE EXCEPTION 'That payment is itself a recorded swap. Record the swap on the payment it converts.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_p.flag_resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'That payment was already handled (%). Reload the page.', v_p.flag_resolution USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_o.status::text NOT IN ('unpaid', 'payment_submitted') THEN
    RAISE EXCEPTION '%', CASE v_o.status::text WHEN 'cancelled' THEN 'This order was cancelled, so a swap can''t pay it. Mark the payment handled with what you did (refund, credit) instead.'
                              ELSE 'This order is already paid, so there is nothing for a swap to pay. Mark the payment handled with what you did instead.' END
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT * INTO v_held FROM storefront.payments h
   WHERE h.tx_hash_canonical = v_canon AND h.status <> 'rejected'
   ORDER BY h.id LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_held.conversion_of = v_pid AND v_held.status = 'pending' THEN
      RAISE EXCEPTION 'That swap is already recorded for this payment and is being checked. Reload in a minute.' USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:tx_hash';
    END IF;
    IF v_held.store_order_id IS DISTINCT FROM v_o.id OR NOT ('self_signed' = ANY (v_held.flags)) OR v_held.conversion_of IS NOT NULL OR v_held.id = v_pid THEN
      RAISE EXCEPTION 'That transaction is already on order % (payment #%). One transaction backs one payment.',
        COALESCE((SELECT so.order_number FROM storefront.store_orders so WHERE so.id = v_held.store_order_id), 'a campaign order'), v_held.id
        USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'field:tx_hash';
    END IF;
    -- the buyer already pasted this swap here and the verifier held it as self-signed (at $0): close that claim, record the swap fresh
    UPDATE storefront.payments
       SET status = 'rejected', verify_error = 'recorded again by the organizers as the swap converting payment #' || v_pid,
           flag_resolved_at = now(), flag_resolved_by = v_actor,
           flag_resolution = 'recorded again as the swap converting payment #' || v_pid
     WHERE id = v_held.id AND flag_resolved_at IS NULL;
    UPDATE storefront.payments
       SET status = 'rejected', verify_error = 'recorded again by the organizers as the swap converting payment #' || v_pid
     WHERE id = v_held.id AND status <> 'rejected';
  END IF;
  -- a recorded swap still being checked is replaced by this one
  UPDATE storefront.payments
     SET status = 'rejected', verify_error = 'replaced by a newer swap the organizers recorded'
   WHERE conversion_of = v_pid AND status = 'pending';
  INSERT INTO storefront.payments (store_order_id, method, rail, tx_hash, amount_claimed_usd, status, conversion_of, recorded_by)
  VALUES (v_o.id, v_p.rail::text::payment_method, v_p.rail, v_hash, v_o.total_usd, 'pending', v_pid, v_actor)
  RETURNING id INTO v_id;
  IF v_o.status::text = 'unpaid' THEN
    UPDATE storefront.store_orders SET status = 'payment_submitted' WHERE id = v_o.id AND status = 'unpaid';
  END IF;
  INSERT INTO public.audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('storefront.payments', v_id::text, 'conversion_recorded', v_actor,
          jsonb_build_object('orderNumber', v_o.order_number, 'storeOrderId', v_o.id, 'convertsPayment', v_pid,
                             'txHash', v_hash, 'replacesBuyerClaim', v_held.id, 'note', v_note));
  RETURN QUERY SELECT v_id, format('Swap recorded on %s. The storefront checks it on-chain within a minute; the order is paid once its payments cover $%s.',
                                   v_o.order_number, to_char(v_o.total_usd, 'FM999999990.00'));
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.store_record_conversion(text, text, text, text) FROM PUBLIC;

-- ── 6. close a flag without a swap (refunded, settled another way, false alarm)
-- Money is untouched: this records what a person did and why.
DROP FUNCTION IF EXISTS storefront.store_resolve_payment_flag(text, text, text);
CREATE FUNCTION storefront.store_resolve_payment_flag(p_actor text, p_payment_id text, p_resolution text)
RETURNS TABLE (payment_id bigint, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE
  v_actor text := btrim(COALESCE(p_actor, ''));
  v_why_raw text := btrim(COALESCE(p_resolution, ''));
  v_why text := storefront.scrub_organizer_text(p_resolution);
  v_pid bigint;
  v_p storefront.payments%ROWTYPE;
  v_order text;
BEGIN
  IF v_actor = '' THEN
    RAISE EXCEPTION 'Sign in again — this app could not tell who you are.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(btrim(p_payment_id), '') !~ '^[1-9][0-9]{0,17}$' THEN
    RAISE EXCEPTION 'That payment isn''t on the list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  v_pid := btrim(p_payment_id)::bigint;
  IF char_length(v_why_raw) < 3 OR char_length(v_why_raw) > 300 THEN
    RAISE EXCEPTION 'Say what you did, in 3 to 300 characters (for example "refunded 1.87 SOL to the buyer").' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:resolution';
  END IF;
  SELECT * INTO v_p FROM storefront.payments WHERE id = v_pid FOR UPDATE;
  IF NOT FOUND OR v_p.store_order_id IS NULL OR cardinality(v_p.flags) = 0 THEN
    RAISE EXCEPTION 'That payment isn''t on the list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_p.flag_resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'That payment was already handled (%). Reload the page.', v_p.flag_resolution USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (SELECT 1 FROM storefront.payments c WHERE c.conversion_of = v_pid AND c.status = 'pending') THEN
    RAISE EXCEPTION 'A recorded swap for this payment is still being checked. Wait for it, then reload.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE storefront.payments SET flag_resolved_at = now(), flag_resolved_by = v_actor, flag_resolution = v_why WHERE id = v_pid;
  SELECT so.order_number INTO v_order FROM storefront.store_orders so WHERE so.id = v_p.store_order_id;
  INSERT INTO public.audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('storefront.payments', v_pid::text, 'payment_flag_resolved', v_actor,
          jsonb_build_object('orderNumber', v_order, 'storeOrderId', v_p.store_order_id, 'flags', to_jsonb(v_p.flags), 'resolution', v_why));
  RETURN QUERY SELECT v_pid, format('Marked handled on %s.', v_order);
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.store_resolve_payment_flag(text, text, text) FROM PUBLIC;

-- ── 7. ST-2026-0017, recorded as what happened ──────────────────────────────
-- Payment 5: the buyer's 1.8695957 SOL — a wrong-token payment, flagged and
-- resolved by the swap. Payment 6: Ian's Jupiter swap (signed by the receiving
-- wallet ER9TS5…), now the conversion of payment 5, credited with the wallet's
-- net gain only: 160.339799 USDT ($160.34; the USDC hop netted to zero). The
-- order stays paid ($160.34 ≥ $160.00); PRT already books only the USDT row
-- (ORD-2026-0457: order_payments 431 stands, 430 marked failed there). Guarded
-- by the exact state found, so a re-run or a changed row is left alone.
DO $fix$
DECLARE v_n int;
BEGIN
  IF EXISTS (SELECT 1 FROM storefront.payments p JOIN storefront.store_orders o ON o.id = p.store_order_id
              WHERE p.id = 6 AND o.order_number = 'ST-2026-0017' AND p.verified_usd = 320.51 AND p.conversion_of IS NULL
                AND p.tx_hash = '24g3e7jQYfHj7JGsDv3HmEmAE49YpS1yCS5zT1RW63huTqoGP8oHramoWc2SFxERjsBHPzRsTPntD6h3dHyoTHNT')
     AND EXISTS (SELECT 1 FROM storefront.payments p WHERE p.id = 5 AND p.store_order_id = 25 AND p.status = 'mismatch' AND cardinality(p.flags) = 0
                   AND p.tx_hash = '2NTnEnpoTsNLAEG7FKqnjQHHJ9waqJ7yGtmVEDgXF6iCpt2WoJpgt2E79bcFHZxFh9s6owk61p2eFcwRccv4nBgn') THEN
    UPDATE storefront.payments
       SET flags = ARRAY['off_token'],
           flag_note = 'Paid 1.8695957 SOL instead of USDT on Solana — SOL isn''t counted.',
           onchain = onchain || jsonb_build_object('gains', jsonb_build_array(jsonb_build_object('token', 'SOL', 'amount', 1.8695957)),
                                                   'signer', 'GCRJD52pGwcCSs4oswYxTBCPatxY1P6WpxCC9R9zty6r', 'flags', jsonb_build_array('off_token')),
           flag_notified_at = now(),
           flag_resolved_at = now(), flag_resolved_by = 'Ian McCaskey',
           flag_resolution = 'converted by Jupiter swap (payment #6): +160.339799 USDT'
     WHERE id = 5;
    UPDATE storefront.payments
       SET conversion_of = 5, recorded_by = 'Ian McCaskey', verified_usd = 160.34,
           onchain = onchain || jsonb_build_object(
             'gains', jsonb_build_array(jsonb_build_object('token', 'USDT', 'amount', 160.339799)),
             'outgoing', jsonb_build_array(jsonb_build_object('token', 'USDC', 'amount', 160.169852)),
             'signer', 'ER9TS5MDG52FyQyRjWHxC47YehAhdAHZcc73UKrAA6Qm',
             'net', jsonb_build_object('USDT', 160.339799, 'USDC', 0, 'SOL', -1.8696337),
             'flags', jsonb_build_array('self_signed'))
     WHERE id = 6;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data) VALUES
      ('storefront.payments', '6', 'payment_corrected', 'Ian McCaskey',
       jsonb_build_object('verifiedUsd', 320.51),
       jsonb_build_object('orderNumber', 'ST-2026-0017', 'verifiedUsd', 160.34, 'conversionOf', 5,
                          'why', 'the Jupiter swap''s USDC hop (in and straight back out) was counted with the USDT; only the wallet''s net gain counts')),
      ('storefront.payments', '5', 'payment_flag_resolved', 'Ian McCaskey', NULL,
       jsonb_build_object('orderNumber', 'ST-2026-0017', 'flags', jsonb_build_array('off_token'),
                          'resolution', 'converted by Jupiter swap (payment #6): +160.339799 USDT'));
  END IF;
END
$fix$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104600_store_payment_flags.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104600_store_payment_flags.sql');
