-- A member shop can have each PAID order posted to its own webhook, once.
--
-- Ian, 2026-11-10, for ELPEPPYJOE BREWERY: the seller buys labels in his own
-- system ("the same way I do for Telegram") and asked for one call per order
-- carrying the order id, the customer's name, the full ship-to, the items with
-- quantities and the shipping paid. Ian chose the store-built design over a
-- UI Bakery automation: the seller enters his OWN webhook URL and
-- Authorization header in P2 Seller Portal → Settings (like his own Shippo
-- key), and the storefront posts the order the moment it turns paid.
--
--   seller_order_webhooks        one per shop: url (https, a host name, never an
--                                IP literal or localhost), auth_header (sent
--                                verbatim as Authorization; shown as last 4
--                                only, never returned by any granted function),
--                                set_at — only orders paid at or after the
--                                latest save are sent, so saving a webhook never
--                                replays orders already being handled.
--   store_order_webhook_sends    the send-once ledger: a row is CLAIMED before
--                                the POST (order_webhook_claim) and finished
--                                after it (order_webhook_finish). One row per
--                                order, ever: a send is never repeated, whatever
--                                the outcome, because a webhook that answered
--                                badly may still have bought the label. The
--                                seller sees each outcome in Settings; the
--                                seller's own daily check covers a miss.
--
-- Writers: the storefront (owner) through order_webhook_claim / _finish /
-- _due (lib/store/order-webhook.ts: on the paid transition and in the
-- worker's sweep); the seller through portal_set_order_webhook; the
-- organizers could through shop_set_order_webhook (core, owner-only, as every
-- shop_* rule). The buyer's email is never in the payload. Audit rows carry
-- the host and the header's last 4, never the URL path or the header.

DO $mig$
BEGIN
  IF current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION '1790105000 must be applied as neondb_owner (function ownership is the security model), not %', current_user;
  END IF;
END
$mig$;

-- ── tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS storefront.seller_order_webhooks (
  seller_id    bigint PRIMARY KEY REFERENCES storefront.sellers(id) ON DELETE CASCADE,
  url          text NOT NULL,
  auth_header  text NOT NULL,
  set_at       timestamptz NOT NULL DEFAULT now(),
  set_by       text NOT NULL,
  CONSTRAINT seller_order_webhooks_url_shape CHECK (
    char_length(url) <= 1000 AND url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^\s]*)?$'),
  CONSTRAINT seller_order_webhooks_header_shape CHECK (
    char_length(auth_header) BETWEEN 8 AND 1000 AND auth_header ~ '^[\x21-\x7e][\x20-\x7e]*[\x21-\x7e]$')
);
COMMENT ON TABLE storefront.seller_order_webhooks IS
  'A shop''s own webhook for paid orders (1790105000). auth_header is a secret: no granted function returns it; the storefront reads it to send.';

CREATE TABLE IF NOT EXISTS storefront.store_order_webhook_sends (
  store_order_id  bigint PRIMARY KEY REFERENCES storefront.store_orders(id) ON DELETE CASCADE,
  seller_id       bigint NOT NULL REFERENCES storefront.sellers(id) ON DELETE CASCADE,
  url_host        text NOT NULL,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  outcome         text,
  http_status     integer,
  note            text,
  CONSTRAINT store_order_webhook_sends_outcome CHECK (
    (finished_at IS NULL AND outcome IS NULL)
    OR (finished_at IS NOT NULL AND outcome IN ('sent', 'refused', 'unreachable'))),
  CONSTRAINT store_order_webhook_sends_status CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT store_order_webhook_sends_note CHECK (note IS NULL OR char_length(note) <= 300)
);
CREATE INDEX IF NOT EXISTS store_order_webhook_sends_seller_idx
  ON storefront.store_order_webhook_sends (seller_id, claimed_at DESC);
COMMENT ON TABLE storefront.store_order_webhook_sends IS
  'One row per store order ever posted to its shop''s webhook (1790105000): claimed before the POST, finished after it; never repeated.';

REVOKE ALL ON storefront.seller_order_webhooks FROM PUBLIC;
REVOKE ALL ON storefront.store_order_webhook_sends FROM PUBLIC;

-- ── core rules (owner-only) ─────────────────────────────────────────────────

-- the shop's webhook, safe to show: host and the header's last 4, never the header or path
CREATE OR REPLACE FUNCTION storefront.shop_get_order_webhook(p_seller_id bigint)
RETURNS TABLE (has_webhook boolean, url_host text, header_last4 text, set_at timestamptz, set_by text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT w.seller_id IS NOT NULL,
         substring(w.url FROM '^https://([^/:]+)'),
         right(w.auth_header, 4),
         w.set_at, w.set_by
    FROM (SELECT p_seller_id AS sid) x
    LEFT JOIN storefront.seller_order_webhooks w ON w.seller_id = x.sid
$fn$;

-- the shop's last 50 sends, newest first
CREATE OR REPLACE FUNCTION storefront.shop_list_order_webhook_sends(p_seller_id bigint)
RETURNS TABLE (store_order_id bigint, order_number text, url_host text, claimed_at timestamptz, finished_at timestamptz,
               outcome text, http_status integer, note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT s.store_order_id, o.order_number, s.url_host, s.claimed_at, s.finished_at, s.outcome, s.http_status, s.note
    FROM storefront.store_order_webhook_sends s
    JOIN storefront.store_orders o ON o.id = s.store_order_id
   WHERE s.seller_id = p_seller_id
   ORDER BY s.claimed_at DESC, s.store_order_id DESC
   LIMIT 50
$fn$;

-- Save or clear (blank url) the shop's webhook. Every save moves set_at, so
-- only orders paid from now on are sent to the new address.
CREATE OR REPLACE FUNCTION storefront.shop_set_order_webhook(p_seller_id bigint, p_actor text, p_url text, p_auth_header text)
RETURNS TABLE (has_webhook boolean, url_host text, header_last4 text, set_at timestamptz, set_by text, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE v_url text := btrim(COALESCE(p_url, '')); v_hdr text := btrim(COALESCE(p_auth_header, ''));
        v_host text; v_old_host text; v_old_last4 text; v_had boolean;
BEGIN
  PERFORM storefront.shop_lock_seller(p_seller_id);
  SELECT substring(w.url FROM '^https://([^/:]+)'), right(w.auth_header, 4) INTO v_old_host, v_old_last4
    FROM storefront.seller_order_webhooks w WHERE w.seller_id = p_seller_id FOR UPDATE;
  v_had := FOUND;

  IF v_url = '' THEN
    DELETE FROM storefront.seller_order_webhooks w WHERE w.seller_id = p_seller_id;
    IF v_had THEN
      PERFORM storefront.shop_audit('storefront.seller_order_webhooks', p_seller_id, 'order_webhook_cleared', p_actor,
        jsonb_build_object('host', v_old_host, 'headerLast4', v_old_last4), NULL);
    END IF;
    RETURN QUERY SELECT g.has_webhook, g.url_host, g.header_last4, g.set_at, g.set_by,
                        CASE WHEN v_had THEN 'Webhook removed. New paid orders are no longer sent.' ELSE 'No webhook was set.' END
      FROM storefront.shop_get_order_webhook(p_seller_id) g;
    RETURN;
  END IF;

  IF char_length(v_url) > 1000 OR v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^\s]*)?$' THEN
    RAISE EXCEPTION 'The webhook URL must start with https:// and contain no spaces.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:url';
  END IF;
  v_host := lower(substring(v_url FROM '^https://([^/:]+)'));
  IF v_host = 'localhost' OR v_host LIKE '%.localhost' OR v_host LIKE '%.local' OR v_host LIKE '%.internal'
     OR v_host ~ '^[0-9.]+$' OR v_host !~ '\.[a-z]{2,}$' THEN
    RAISE EXCEPTION 'The webhook URL must use a public domain name (not an IP address or a local name).' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:url';
  END IF;
  IF v_hdr = '' THEN
    RAISE EXCEPTION 'Paste the Authorization header value your webhook expects.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:header';
  END IF;
  IF char_length(v_hdr) NOT BETWEEN 8 AND 1000 OR v_hdr !~ '^[\x21-\x7e][\x20-\x7e]*[\x21-\x7e]$' THEN
    RAISE EXCEPTION 'The Authorization header must be 8–1000 plain characters on one line.' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:header';
  END IF;

  INSERT INTO storefront.seller_order_webhooks AS w (seller_id, url, auth_header, set_at, set_by)
  VALUES (p_seller_id, v_url, v_hdr, now(), p_actor)
  ON CONFLICT ON CONSTRAINT seller_order_webhooks_pkey
  DO UPDATE SET url = EXCLUDED.url, auth_header = EXCLUDED.auth_header, set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by;
  PERFORM storefront.shop_audit('storefront.seller_order_webhooks', p_seller_id, 'order_webhook_set', p_actor,
    CASE WHEN v_had THEN jsonb_build_object('host', v_old_host, 'headerLast4', v_old_last4) END,
    jsonb_build_object('host', v_host, 'headerLast4', right(v_hdr, 4)));
  RETURN QUERY SELECT g.has_webhook, g.url_host, g.header_last4, g.set_at, g.set_by,
                      'Webhook saved. Each order paid from now on is sent once.'
    FROM storefront.shop_get_order_webhook(p_seller_id) g;
END
$fn$;

REVOKE EXECUTE ON FUNCTION storefront.shop_get_order_webhook(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.shop_list_order_webhook_sends(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.shop_set_order_webhook(bigint, text, text, text) FROM PUBLIC;

-- ── portal wrappers: resolve and delegate ───────────────────────────────────

CREATE OR REPLACE FUNCTION storefront.portal_get_order_webhook(p_email text, p_view text)
RETURNS TABLE (has_webhook boolean, url_host text, header_last4 text, set_at timestamptz, set_by text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_get_order_webhook(storefront.portal_resolve_viewer(p_email, p_view))
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_list_order_webhook_sends(p_email text, p_view text)
RETURNS TABLE (store_order_id bigint, order_number text, url_host text, claimed_at timestamptz, finished_at timestamptz,
               outcome text, http_status integer, note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_order_webhook_sends(storefront.portal_resolve_viewer(p_email, p_view))
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_set_order_webhook(p_email text, p_url text, p_auth_header text)
RETURNS TABLE (has_webhook boolean, url_host text, header_last4 text, set_at timestamptz, set_by text, message text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_set_order_webhook(storefront.portal_resolve_seller(p_email), storefront.portal_actor(p_email), p_url, p_auth_header)
$fn$;

REVOKE EXECUTE ON FUNCTION storefront.portal_get_order_webhook(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.portal_list_order_webhook_sends(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.portal_set_order_webhook(text, text, text) FROM PUBLIC;

-- ── the storefront's sender (owner-only) ────────────────────────────────────

-- Paid orders of shops with a webhook, paid since the webhook was saved and
-- within the last 7 days, never claimed: the worker sweep's work list.
CREATE OR REPLACE FUNCTION storefront.order_webhook_due(p_limit integer)
RETURNS TABLE (store_order_id bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT o.id
    FROM storefront.store_orders o
    JOIN storefront.seller_order_webhooks w ON w.seller_id = o.seller_id
   WHERE o.status = 'paid' AND o.paid_at IS NOT NULL
     AND o.paid_at >= w.set_at AND o.paid_at > now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM storefront.store_order_webhook_sends s WHERE s.store_order_id = o.id)
   ORDER BY o.paid_at, o.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
$fn$;

-- Claim ONE order for sending: zero rows unless it is paid now, its shop has a
-- webhook saved at or before its payment, and it was never claimed. The row
-- that comes back carries the secret header and the payload; the caller posts
-- once and then calls order_webhook_finish.
CREATE OR REPLACE FUNCTION storefront.order_webhook_claim(p_store_order_id bigint)
RETURNS TABLE (url text, auth_header text, payload jsonb)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE o storefront.store_orders%ROWTYPE; w storefront.seller_order_webhooks%ROWTYPE; v_items jsonb; v_claimed int;
BEGIN
  SELECT * INTO o FROM storefront.store_orders so WHERE so.id = p_store_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'paid' OR o.paid_at IS NULL THEN RETURN; END IF;
  SELECT * INTO w FROM storefront.seller_order_webhooks sw WHERE sw.seller_id = o.seller_id;
  IF NOT FOUND OR o.paid_at < w.set_at THEN RETURN; END IF;

  INSERT INTO storefront.store_order_webhook_sends (store_order_id, seller_id, url_host)
  VALUES (o.id, o.seller_id, lower(substring(w.url FROM '^https://([^/:]+)')))
  ON CONFLICT ON CONSTRAINT store_order_webhook_sends_pkey DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN RETURN; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('title', i.listing_title_snapshot, 'quantity', i.qty) ORDER BY i.sort, i.id), '[]'::jsonb)
    INTO v_items FROM storefront.store_order_items i WHERE i.store_order_id = o.id;
  IF v_items = '[]'::jsonb THEN
    -- an order written before 1790103900 carries its one line in its summary
    v_items := jsonb_build_array(jsonb_build_object('title', o.listing_title_snapshot, 'quantity', o.qty));
  END IF;

  RETURN QUERY SELECT w.url, w.auth_header, jsonb_build_object(
    'event', 'order.paid',
    'orderId', o.order_number,
    'paidAt', o.paid_at,
    'customer', jsonb_build_object('name', o.contact_name),
    'shipTo', jsonb_build_object(
      'name', o.contact_name,
      'street1', o.address_line1,
      'street2', NULLIF(btrim(COALESCE(o.address_line2, '')), ''),
      'city', o.city,
      'state', o.state_code,
      'zip', o.postal_code,
      'country', 'US'),
    'items', v_items,
    'shippingPaidUsd', to_char(o.shipping_fee_usd, 'FM9999990.00'));
END
$fn$;

-- Record how the one POST went. Only an unfinished claim is finished, once.
CREATE OR REPLACE FUNCTION storefront.order_webhook_finish(p_store_order_id bigint, p_outcome text, p_http_status integer, p_note text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_n int;
BEGIN
  IF p_outcome NOT IN ('sent', 'refused', 'unreachable') THEN
    RAISE EXCEPTION 'unknown webhook outcome %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE storefront.store_order_webhook_sends s
     SET finished_at = now(), outcome = p_outcome,
         http_status = CASE WHEN p_http_status BETWEEN 100 AND 599 THEN p_http_status END,
         note = left(NULLIF(btrim(COALESCE(p_note, '')), ''), 300)
   WHERE s.store_order_id = p_store_order_id AND s.finished_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$fn$;

REVOKE EXECUTE ON FUNCTION storefront.order_webhook_due(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.order_webhook_claim(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.order_webhook_finish(bigint, text, integer, text) FROM PUBLIC;

-- ── grants ──────────────────────────────────────────────────────────────────

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_seller_portal') THEN
    GRANT EXECUTE ON FUNCTION storefront.portal_get_order_webhook(text, text) TO p2_seller_portal;
    GRANT EXECUTE ON FUNCTION storefront.portal_list_order_webhook_sends(text, text) TO p2_seller_portal;
    GRANT EXECUTE ON FUNCTION storefront.portal_set_order_webhook(text, text, text) TO p2_seller_portal;
  END IF;
  -- leak guard for the untracked 1790101500 (its blanket storefront grant)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_storefront') THEN
    REVOKE ALL ON storefront.seller_order_webhooks FROM p2_storefront;
    REVOKE ALL ON storefront.store_order_webhook_sends FROM p2_storefront;
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790105000_shop_order_webhook.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790105000_shop_order_webhook.sql');
