-- The order form mints a client token per load so a retried submission (lost
-- response, double tap) finds its order instead of minting another; the
-- storefront's placement path has always required one (zod uuid). The
-- database now requires it too: no placement path — present or future,
-- app or repair script — can insert a storefront order that a retry could
-- not find. The uniqueness index loses its NULL carve-out for the same
-- reason. Applied while storefront.orders held no rows.
ALTER TABLE storefront.orders ALTER COLUMN client_token SET NOT NULL;
DROP INDEX IF EXISTS storefront.sf_orders_client_token_uniq;
CREATE UNIQUE INDEX sf_orders_client_token_uniq ON storefront.orders (auth_user_id, client_token);
