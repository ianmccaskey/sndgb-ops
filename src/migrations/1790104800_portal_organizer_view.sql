-- Organizers can VIEW any member shop in the P2 Seller Portal, read-only.
--
-- Ian, 2026-11-10: "I'm trying to see what the p2 sellers portal looks like
-- but I have no shop assigned there nor do I want my shop assigned there.
-- Can I be setup as an admin so I can see everyone else's?" (asked twice;
-- the first answer pointed him at Shop orders in P2 Collective Orders).
--
-- The portal's trust model is unchanged: the identity is still UI Bakery's
-- server-substituted {{user.email}}, the role p2_seller_portal still holds
-- EXECUTE on portal_* wrappers only, and every wrapper still resolves the
-- shop itself. What changes is WHICH resolver the read wrappers call:
--
--   portal_resolve_seller(email)  operators only — every WRITE wrapper and
--                                 portal_get_shippo_key keep calling it, so an
--                                 organizer can never write, buy, void or
--                                 read a shop's Shippo key from the portal.
--                                 A live organizer it refuses gets its own
--                                 sentence ("…read-only…"), still 42501.
--   portal_resolve_viewer(email)  a live operator's shop (operator wins), else
--                                 the member shop a live ORGANIZER chose to
--                                 view. The ten read wrappers call it.
--
-- Organizers are listed in storefront.portal_organizers (owner-written; no
-- grant to the portal role; no email in this file). An organizer picks the
-- shop to view with portal_organizer_view (audited: viewing a shop shows its
-- buyers' handles and ship-to within the 30-day window, as Shop orders does)
-- and lists the choices with portal_organizer_shops (zero rows for anyone who
-- is not a live organizer, or who is a live operator). Only member shops are
-- viewable — kind 'individual', approved, NOT managed_in_ops: the organizer-
-- run shops are worked in P2 Collective Orders and never in the portal.
--
-- Every change to a member shop by an organizer stays in P2 Collective
-- Orders → Shop orders (storefront.shop_* under the organizer's name).

DO $mig$
BEGIN
  IF current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION '1790104800 must be applied as neondb_owner (function ownership is the security model), not %', current_user;
  END IF;
END
$mig$;

-- ── who may view ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS storefront.portal_organizers (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email             text NOT NULL,
  viewing_seller_id bigint REFERENCES storefront.sellers(id) ON DELETE SET NULL,
  added_by          text NOT NULL,
  added_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        text,
  CONSTRAINT portal_organizers_email_shape CHECK (
    email = lower(btrim(email)) AND char_length(email) <= 254
    AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT portal_organizers_revoked_by CHECK (
    revoked_at IS NULL OR (revoked_by IS NOT NULL AND btrim(revoked_by) <> ''))
);
COMMENT ON TABLE storefront.portal_organizers IS
  'UI Bakery logins that may VIEW any member shop in the P2 Seller Portal, read-only (1790104800). Owner-written; read by portal_resolve_viewer / portal_organizer_*. viewing_seller_id = the shop this organizer last chose.';

CREATE UNIQUE INDEX IF NOT EXISTS portal_organizers_live_email_uniq
  ON storefront.portal_organizers (lower(email)) WHERE revoked_at IS NULL;

REVOKE ALL ON storefront.portal_organizers FROM PUBLIC;

-- ── resolvers ───────────────────────────────────────────────────────────────

-- operators only (unchanged), with the organizer's own refusal sentence
CREATE OR REPLACE FUNCTION storefront.portal_resolve_seller(p_email text)
RETURNS bigint
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
    IF EXISTS (SELECT 1 FROM storefront.portal_organizers g WHERE lower(g.email) = v_email AND g.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'Organizers view shops read-only in the portal. Make changes in P2 Collective Orders → Shop orders.'
        USING ERRCODE = 'insufficient_privilege', HINT = 'organizer-read-only';
    END IF;
    RAISE EXCEPTION 'not an approved seller operator' USING ERRCODE = 'insufficient_privilege',
      HINT = 'Ask the organizers to add this exact login email to your shop.';
  END IF;
  RETURN v_id;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.portal_resolve_seller(text) FROM PUBLIC;

-- an operator's shop, else the member shop a live organizer chose to view
CREATE OR REPLACE FUNCTION storefront.portal_resolve_viewer(p_email text)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_email text := lower(btrim(COALESCE(p_email, ''))); v_id bigint;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'not an approved seller operator' USING ERRCODE = 'insufficient_privilege',
      HINT = 'This login carries no email. Sign out and in again.';
  END IF;
  -- a live operator is an operator, whatever else the email is
  IF EXISTS (SELECT 1 FROM storefront.seller_operators o WHERE lower(o.email) = v_email AND o.revoked_at IS NULL) THEN
    RETURN storefront.portal_resolve_seller(v_email);
  END IF;
  SELECT s.id INTO v_id
    FROM storefront.portal_organizers g
    JOIN storefront.sellers s ON s.id = g.viewing_seller_id
   WHERE lower(g.email) = v_email AND g.revoked_at IS NULL
     AND s.kind = 'individual' AND s.status = 'approved' AND NOT s.managed_in_ops;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not an approved seller operator' USING ERRCODE = 'insufficient_privilege',
      HINT = 'Ask the organizers to add this exact login email to your shop.';
  END IF;
  RETURN v_id;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.portal_resolve_viewer(text) FROM PUBLIC;

-- ── the organizer's shop picker ─────────────────────────────────────────────

-- The member shops a live organizer may view; zero rows for anyone else
-- (an operator, an unknown or revoked login), so a seller learns nothing.
CREATE OR REPLACE FUNCTION storefront.portal_organizer_shops(p_email text)
RETURNS TABLE (seller_id bigint, slug text, display_name text, viewing boolean, to_ship integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT s.id, s.slug, s.display_name, COALESCE(s.id = g.viewing_seller_id, false),
         (SELECT count(*)::int FROM storefront.store_orders so WHERE so.seller_id = s.id AND so.status = 'paid')
    FROM storefront.portal_organizers g
    JOIN storefront.sellers s ON s.kind = 'individual' AND s.status = 'approved' AND NOT s.managed_in_ops
   WHERE lower(g.email) = lower(btrim(COALESCE(p_email, ''))) AND g.revoked_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM storefront.seller_operators o
                      WHERE lower(o.email) = lower(btrim(COALESCE(p_email, ''))) AND o.revoked_at IS NULL)
   ORDER BY lower(s.display_name), s.id
$fn$;

-- Pick the member shop to view. Audited: it opens that shop's buyers' handles
-- and in-window ship-to to this organizer.
CREATE OR REPLACE FUNCTION storefront.portal_organizer_view(p_email text, p_seller_id text)
RETURNS TABLE (seller_id bigint, display_name text, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE v_email text := lower(btrim(COALESCE(p_email, ''))); v_org bigint; v_sid bigint; v_name text; v_prev bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM storefront.seller_operators o WHERE lower(o.email) = v_email AND o.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'This login runs a shop, so it can''t view other shops.' USING ERRCODE = 'insufficient_privilege', HINT = 'organizer-only';
  END IF;
  SELECT g.id, g.viewing_seller_id INTO v_org, v_prev
    FROM storefront.portal_organizers g
   WHERE lower(g.email) = v_email AND g.revoked_at IS NULL
   FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Only the organizers can view other shops.' USING ERRCODE = 'insufficient_privilege', HINT = 'organizer-only';
  END IF;
  v_sid := storefront.shop_parse_id(p_seller_id, 'shop');
  SELECT s.display_name INTO v_name
    FROM storefront.sellers s
   WHERE s.id = v_sid AND s.kind = 'individual' AND s.status = 'approved' AND NOT s.managed_in_ops;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'That shop isn''t a member shop the portal shows. Pick another.' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE storefront.portal_organizers g SET viewing_seller_id = v_sid WHERE g.id = v_org;
  IF v_prev IS DISTINCT FROM v_sid THEN
    INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
    VALUES ('storefront.sellers', v_sid::text, 'portal_organizer_viewing', storefront.portal_actor(v_email),
            CASE WHEN v_prev IS NULL THEN NULL ELSE jsonb_build_object('viewingSellerId', v_prev) END,
            jsonb_build_object('viewingSellerId', v_sid, 'readOnly', true));
  END IF;
  RETURN QUERY SELECT v_sid, v_name, 'Viewing ' || v_name || ', read-only.';
END
$fn$;

REVOKE EXECUTE ON FUNCTION storefront.portal_organizer_shops(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.portal_organizer_view(text, text) FROM PUBLIC;

-- ── the read wrappers: viewer resolver; bodies otherwise as before ──────────

CREATE OR REPLACE FUNCTION storefront.portal_me(p_email text)
RETURNS TABLE(seller_id bigint, slug text, display_name text, seller_status text, fee_pct numeric, managed_in_ops boolean, wallet_count integer, has_default_wallet boolean, ship_from_complete boolean, has_shippo_key boolean, shippo_key_last4 text, shippo_key_is_test boolean, to_ship integer, operator_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_seller bigint := storefront.portal_resolve_viewer(p_email); v_email text := lower(btrim(p_email));
BEGIN
  -- stamps an operator's own row only; an organizer has none on this shop
  UPDATE storefront.seller_operators o SET last_seen_at = now() WHERE lower(o.email) = v_email AND o.revoked_at IS NULL AND o.seller_id = v_seller;
  RETURN QUERY SELECT m.seller_id, m.slug, m.display_name, m.seller_status, m.fee_pct, m.managed_in_ops, m.wallet_count, m.has_default_wallet,
                      m.ship_from_complete, m.has_shippo_key, m.shippo_key_last4, m.shippo_key_is_test, m.to_ship, v_email
    FROM storefront.shop_me(v_seller) m;
END
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_order_counts(p_email text)
RETURNS SETOF storefront.shop_counts_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_order_counts(storefront.portal_resolve_viewer(p_email))
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_list_orders(p_email text, p_status text DEFAULT '', p_limit text DEFAULT '100', p_before_id text DEFAULT '')
RETURNS SETOF storefront.shop_order_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_orders(storefront.portal_resolve_viewer(p_email), p_status, p_limit, p_before_id)
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_get_order(p_email text, p_order_id text)
RETURNS SETOF storefront.shop_order_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_get_order(storefront.portal_resolve_viewer(p_email), p_order_id)
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_order_items(p_email text, p_order_ids text)
RETURNS SETOF storefront.shop_order_item_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_order_items(storefront.portal_resolve_viewer(p_email), p_order_ids)
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_list_shipments(p_email text, p_order_id text)
RETURNS SETOF storefront.shop_shipment_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_shipments(storefront.portal_resolve_viewer(p_email), p_order_id)
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_list_payments(p_email text, p_order_id text)
RETURNS TABLE(id bigint, store_order_id bigint, rail text, received text, status text, amount_claimed_usd numeric, verified_usd numeric, tx_hash text, paid_to text, note text, created_at timestamp with time zone, verified_at timestamp with time zone, flags text[], flag_note text, flag_resolved_at timestamp with time zone, flag_resolution text, conversion_of bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_payments(storefront.portal_resolve_viewer(p_email), p_order_id)
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_list_listings(p_email text)
RETURNS TABLE(id bigint, title text, description_md text, mass_label text, price_usd numeric, shipping_fee_usd numeric, qty_available integer, max_per_order integer, status text, effective_status text, organizer_managed boolean, created_at timestamp with time zone, updated_at timestamp with time zone, min_per_order integer, free_shipping_min_qty integer, product_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_listings(storefront.portal_resolve_viewer(p_email))
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_list_wallets(p_email text)
RETURNS SETOF storefront.shop_wallet_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_list_wallets(storefront.portal_resolve_viewer(p_email))
$fn$;

CREATE OR REPLACE FUNCTION storefront.portal_get_ship_from(p_email text)
RETURNS SETOF storefront.shop_ship_from_row
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
  SELECT * FROM storefront.shop_get_ship_from(storefront.portal_resolve_viewer(p_email))
$fn$;

-- ── grants: the two new wrappers only (CREATE OR REPLACE keeps the rest) ────

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_seller_portal') THEN
    GRANT EXECUTE ON FUNCTION storefront.portal_organizer_shops(text) TO p2_seller_portal;
    GRANT EXECUTE ON FUNCTION storefront.portal_organizer_view(text, text) TO p2_seller_portal;
  END IF;
  -- leak guard for the untracked 1790101500 (its blanket storefront grant)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_storefront') THEN
    REVOKE ALL ON storefront.portal_organizers FROM p2_storefront;
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790104800_portal_organizer_view.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790104800_portal_organizer_view.sql');
