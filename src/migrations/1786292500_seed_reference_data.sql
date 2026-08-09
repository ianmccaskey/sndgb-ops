-- Reference data carried over from the GB4 sheet (no historical orders — fresh start).

INSERT INTO vendors (code, name) VALUES
  ('HXTNT', 'HXTNT'),
  ('LOBSTER', 'Lobster'),
  ('UTHER', 'Uther'),
  ('CHANGSHA', 'Changsha'),
  ('CHANGSHA-MIA', 'Changsha-Mia');

-- external_id = product ObjectId from the ordering app's GB4 catalog
INSERT INTO products (external_id, sku_code, name, mass_label) VALUES
  ('69fe35e677dc41903ac504c6', 'T60', 'Tirzepatide', '60mg'),
  ('69fe38dd0023ebda06580db0', 'T15', 'Tirzepatide', '15mg'),
  ('69fe3573eaf09d01750bb144', 'R20', 'Retatrutide', '20mg'),
  ('6a0f49e040b080d581653fea', 'R30', 'Retatrutide', '30mg'),
  ('69fe36f49873d39e2dc3566e', 'MOTS-C 40', 'MOTS-C', '40mg'),
  ('69fe384f9c2d37e5c94dba6e', 'GHK50/KPV20', 'GHK/KPV', '50/20mg'),
  ('69fe38f08693516fb6ac6b3f', 'KLOW 80', 'KLOW', '80mg'),
  ('6a07c1075bd76541061a6c40', 'JM''s Pep Tin-BLUE', 'JM''s Pep Tin', 'BLUE'),
  ('6a07c0cef856b32ddb1f46c6', 'JM''S Pep Tin-RED', 'JM''s Pep Tin', 'RED');

INSERT INTO wallets (name, chain) VALUES
  ('Cash', 'fiat'),
  ('ETH Wallet', 'eth'),
  ('SOL Wallet', 'sol'),
  ('BASE Wallet', 'base');

-- Next campaign, ready to configure (rename/date as needed)
INSERT INTO group_buys (name, status, admin_fee_usd, shipping_fee_usd, cash_processor_fee_pct, reconcile_tolerance_usd)
VALUES ('Mixed Buy #5', 'draft', 10.00, 10.00, 4.50, 1.00);

INSERT INTO profit_splits (group_buy_id, party, pct)
SELECT id, 'Paige', 75 FROM group_buys WHERE name = 'Mixed Buy #5';
INSERT INTO profit_splits (group_buy_id, party, pct)
SELECT id, 'Porgy', 25 FROM group_buys WHERE name = 'Mixed Buy #5';

INSERT INTO app_settings (key, value) VALUES
  ('admins', 'Ian,Paige'),
  ('moralis_api_key', ''),
  ('helius_api_key', ''),
  ('eth_wallet_address', ''),
  ('sol_wallet_address', ''),
  ('base_wallet_address', '');
