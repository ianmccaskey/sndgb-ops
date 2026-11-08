-- Per-member access to the storefront's two sections.
--
-- Ian, 2026-11-08: the organizers can turn Group buys and the Store off for
-- one member from the P2 Collective Orders Members page, without suspending
-- the sign-in. The store keeps its rule — it opens only to members verified
-- on Telegram or Discord — and `store = false` closes it to a member that
-- rule would admit. `group_buys = false` closes browsing and placing (and
-- adding lines to an order); the member's existing orders stay visible and
-- payable, because the money is theirs to settle.
--
-- One row per member who has ever been limited; no row means both sections
-- open. Keyed by the Neon Auth user id with no FK on purpose: the profile
-- may not exist yet, and neon_auth is a managed schema (same reasoning as
-- customer_profiles.auth_user_id). Written only by P2 Collective Orders
-- (setStoreMemberAccess, audited into public.audit_log); the storefront
-- reads it on every request to a gated page or write action
-- (lib/customers/access.ts there) and never writes it. The storefront role
-- (1790101500, when applied) gets SELECT through "ALL TABLES IN SCHEMA
-- storefront"; no write grant is to be added.

CREATE TABLE IF NOT EXISTS storefront.member_access (
  auth_user_id UUID PRIMARY KEY,
  group_buys   BOOLEAN NOT NULL DEFAULT true,
  -- true: the verification rule decides; false: closed whatever the handles say
  store        BOOLEAN NOT NULL DEFAULT true,
  note         TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

COMMENT ON TABLE storefront.member_access IS
  'Per-member switches for the storefront sections (P2 Collective Orders writes, the storefront reads). No row = both open. store=true means the Telegram/Discord rule decides.';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103500_member_access.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103500_member_access.sql');
