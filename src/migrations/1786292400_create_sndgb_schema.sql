-- SND Group Buy Ops — core schema
-- Money is numeric(12,2) USD. All derived numbers live in views, never in columns.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE group_buy_status AS ENUM ('draft','open','closed','ordering','fulfillment','complete');
CREATE TYPE gb_product_status AS ENUM ('active','cancelled');
CREATE TYPE order_status AS ENUM ('imported','verified','flagged','refunded','cancelled');
CREATE TYPE payment_rail AS ENUM ('eth','sol','base','cash');
CREATE TYPE payment_method AS ENUM ('eth','sol','base','zelle','venmo','paypal','cash','other');
CREATE TYPE payment_status AS ENUM ('pending','verified','mismatch','rejected');
CREATE TYPE verify_source AS ENUM ('auto','manual');
CREATE TYPE expense_category AS ENUM ('supplies','shipping','reship','testing','other');
CREATE TYPE shipment_status AS ENUM ('pending','packed','shipped','delivered','reshipped');
CREATE TYPE wallet_chain AS ENUM ('eth','sol','base','fiat');

-- updated_at trigger helper
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============ Reference / campaign ============

CREATE TABLE vendors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id TEXT UNIQUE,          -- ObjectId from the ordering app
  sku_code TEXT NOT NULL UNIQUE,    -- T60, R20, KLOW 80... (join key in imports)
  name TEXT NOT NULL,
  mass_label TEXT,                  -- '60mg', '50/20mg'
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_buys (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id TEXT UNIQUE,          -- ObjectId from the ordering app
  name TEXT NOT NULL UNIQUE,
  status group_buy_status NOT NULL DEFAULT 'draft',
  starts_on DATE,
  ends_on DATE,
  admin_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 10.00,
  shipping_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 10.00,
  cash_processor_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 4.50,
  reconcile_tolerance_usd NUMERIC(12,2) NOT NULL DEFAULT 1.00,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_buy_products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_id BIGINT NOT NULL REFERENCES group_buys(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  vendor_id BIGINT NOT NULL REFERENCES vendors(id),
  unit_cost_usd NUMERIC(12,2) NOT NULL CHECK (unit_cost_usd >= 0),
  margin_usd NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (margin_usd >= 0),
  gb_price_usd NUMERIC(12,2) GENERATED ALWAYS AS (unit_cost_usd + margin_usd) STORED,
  target_moq INTEGER NOT NULL DEFAULT 0 CHECK (target_moq >= 0),
  testing_cost_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  freight_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  status gb_product_status NOT NULL DEFAULT 'active',
  ordered_from_vendor_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_buy_id, product_id)
);

-- Organizer personal units on top of customer demand ("P & P R30 x 100"),
-- each with a required reason so final counts stay explainable.
CREATE TABLE admin_adjustments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_product_id BIGINT NOT NULL REFERENCES group_buy_products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty <> 0),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Customers & orders ============

CREATE TABLE customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email CITEXT UNIQUE,
  display_name TEXT NOT NULL,
  discord_username TEXT,
  phone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id TEXT UNIQUE,          -- ObjectId from the ordering app; upsert key for re-imports
  order_number TEXT NOT NULL UNIQUE, -- '2026-107', '2026-MB4-140'
  group_buy_id BIGINT NOT NULL REFERENCES group_buys(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  status order_status NOT NULL DEFAULT 'imported',
  payment_rail payment_rail,
  -- contact snapshot as imported (customer row may be cleaned up later)
  contact_name TEXT,
  contact_email CITEXT,
  contact_phone TEXT,
  discord_username TEXT,
  -- shipping address (zip is TEXT: leading zeros are data)
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state_code TEXT,
  postal_code TEXT,
  -- money
  subtotal_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  tip_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  admin_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  processor_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  placed_at TIMESTAMPTZ,
  customer_note TEXT,
  admin_note TEXT,
  hold_shipping BOOLEAN NOT NULL DEFAULT false,
  raw_import JSONB,                 -- the original imported row, untouched, forever
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_group_buy_idx ON orders (group_buy_id);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  group_buy_product_id BIGINT NOT NULL REFERENCES group_buy_products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_usd NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, group_buy_product_id)
);
CREATE INDEX order_items_gbp_idx ON order_items (group_buy_product_id);

-- ============ Money in ============

CREATE TABLE payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method payment_method NOT NULL,
  tx_hash TEXT,                     -- full hash/signature, never truncated
  receipt_ref TEXT,                 -- PayPal/Venmo/Zelle receipt id
  amount_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  native_amount NUMERIC(24,9),
  native_symbol TEXT,
  value_at_pay_usd NUMERIC(12,2),   -- for drift tracking on native-token payments
  status payment_status NOT NULL DEFAULT 'pending',
  verify_source verify_source,
  verified_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE UNIQUE INDEX payments_tx_hash_uniq ON payments (tx_hash) WHERE tx_hash IS NOT NULL;

-- Manual reconciliation override: an auditable event, not a silent cell.
CREATE TABLE payment_overrides (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_usd NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_overrides_order_idx ON payment_overrides (order_id);

-- ============ Money out & holdings ============

CREATE TABLE wallets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  chain wallet_chain NOT NULL,
  address TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id BIGINT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  balance_usd NUMERIC(14,2) NOT NULL,
  native_balance NUMERIC(24,9),
  source verify_source NOT NULL DEFAULT 'manual',
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_snapshots_wallet_idx ON wallet_snapshots (wallet_id, taken_at DESC);

CREATE TABLE vendor_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id),
  group_buy_id BIGINT NOT NULL REFERENCES group_buys(id),
  paid_on DATE NOT NULL,
  amount_usd NUMERIC(12,2) NOT NULL CHECK (amount_usd > 0),
  wallet_id BIGINT REFERENCES wallets(id),
  method TEXT,                      -- 'USDC', 'wire', ...
  receipt_ref TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vendor_payments_vendor_idx ON vendor_payments (vendor_id, group_buy_id);

CREATE TABLE expenses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_id BIGINT NOT NULL REFERENCES group_buys(id),
  category expense_category NOT NULL,
  description TEXT NOT NULL,
  unit_cost_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  qty NUMERIC(12,2) NOT NULL DEFAULT 1,
  total_usd NUMERIC(14,2) GENERATED ALWAYS AS (unit_cost_usd * qty) STORED,
  incurred_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_group_buy_idx ON expenses (group_buy_id);

CREATE TABLE profit_splits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_id BIGINT NOT NULL REFERENCES group_buys(id),
  party TEXT NOT NULL,
  pct NUMERIC(5,2) NOT NULL CHECK (pct > 0 AND pct <= 100),
  UNIQUE (group_buy_id, party)
);

-- ============ Fulfillment ============

CREATE TABLE shipments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier TEXT,
  tracking_number TEXT,
  label_cost_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  box TEXT,
  status shipment_status NOT NULL DEFAULT 'pending',
  shipped_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shipments_order_idx ON shipments (order_id);

-- ============ Ops ============

CREATE TABLE audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_pk TEXT NOT NULL,
  action TEXT NOT NULL,             -- 'insert' | 'update' | 'delete' | domain events
  actor TEXT NOT NULL,
  old_data JSONB,
  new_data JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_table_idx ON audit_log (table_name, row_pk);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- updated_at triggers
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendors','products','group_buys','group_buy_products','customers','orders','payments','wallets','shipments']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ============ Views (single source of derived truth) ============

-- Per-SKU demand, adjustments, final count, MOQ progress (replaces Products tab)
CREATE VIEW v_moq_progress AS
SELECT
  gbp.id AS group_buy_product_id,
  gbp.group_buy_id,
  gb.name AS group_buy_name,
  p.sku_code,
  p.name AS product_name,
  p.mass_label,
  v.code AS vendor_code,
  gbp.unit_cost_usd,
  gbp.gb_price_usd,
  gbp.target_moq,
  COALESCE(d.demand_qty, 0) AS demand_qty,
  COALESCE(a.adjustment_qty, 0) AS adjustment_qty,
  COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) AS final_count,
  (COALESCE(d.demand_qty, 0) >= gbp.target_moq) AS moq_met,
  ROUND((COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0)) * gbp.unit_cost_usd, 2) AS vendor_order_value_usd,
  gbp.ordered_from_vendor_at,
  gbp.status
FROM group_buy_products gbp
JOIN group_buys gb ON gb.id = gbp.group_buy_id
JOIN products p ON p.id = gbp.product_id
JOIN vendors v ON v.id = gbp.vendor_id
LEFT JOIN (
  SELECT oi.group_buy_product_id, SUM(oi.qty) AS demand_qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status NOT IN ('cancelled','refunded')
  GROUP BY oi.group_buy_product_id
) d ON d.group_buy_product_id = gbp.id
LEFT JOIN (
  SELECT group_buy_product_id, SUM(qty) AS adjustment_qty
  FROM admin_adjustments
  GROUP BY group_buy_product_id
) a ON a.group_buy_product_id = gbp.id;

-- Per-SKU profit on ONE quantity basis: final count (replaces Profit tab)
CREATE VIEW v_product_profit AS
SELECT
  m.*,
  gbp.margin_usd,
  gbp.testing_cost_usd,
  gbp.freight_usd,
  CASE WHEN m.final_count > 0 THEN ROUND(gbp.testing_cost_usd / m.final_count, 4) ELSE 0 END AS testing_per_unit_usd,
  CASE WHEN m.final_count > 0 THEN ROUND(gbp.freight_usd / m.final_count, 4) ELSE 0 END AS freight_per_unit_usd,
  CASE WHEN m.final_count > 0
    THEN ROUND(gbp.margin_usd - gbp.testing_cost_usd / m.final_count - gbp.freight_usd / m.final_count, 4)
    ELSE 0 END AS net_profit_per_unit_usd,
  CASE WHEN m.final_count > 0
    THEN ROUND(m.final_count * gbp.margin_usd - gbp.testing_cost_usd - gbp.freight_usd, 2)
    ELSE 0 END AS total_product_profit_usd,
  ROUND(m.final_count * m.unit_cost_usd, 2) AS owed_to_vendor_usd,
  ROUND(m.final_count * m.gb_price_usd, 2) AS expected_revenue_usd
FROM v_moq_progress m
JOIN group_buy_products gbp ON gbp.id = m.group_buy_product_id;

-- Vendor balances; overpayment surfaces loudly (replaces Vendor Payments summary)
CREATE VIEW v_vendor_balances AS
SELECT
  v.id AS vendor_id,
  v.code AS vendor_code,
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  SUM(pp.owed_to_vendor_usd) AS owed_usd,
  COALESCE(vp.paid_usd, 0) AS paid_usd,
  SUM(pp.owed_to_vendor_usd) - COALESCE(vp.paid_usd, 0) AS balance_usd,
  CASE
    WHEN COALESCE(vp.paid_usd, 0) = 0 THEN 'unpaid'
    WHEN COALESCE(vp.paid_usd, 0) < SUM(pp.owed_to_vendor_usd) THEN 'partial'
    WHEN COALESCE(vp.paid_usd, 0) = SUM(pp.owed_to_vendor_usd) THEN 'paid'
    ELSE 'OVERPAID'
  END AS pay_status
FROM v_product_profit pp
JOIN vendors v ON v.code = pp.vendor_code
JOIN group_buys gb ON gb.id = pp.group_buy_id
LEFT JOIN (
  SELECT vendor_id, group_buy_id, SUM(amount_usd) AS paid_usd
  FROM vendor_payments
  GROUP BY vendor_id, group_buy_id
) vp ON vp.vendor_id = v.id AND vp.group_buy_id = gb.id
GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd;

-- Per-order reconciliation (replaces both audit tabs)
CREATE VIEW v_order_reconciliation AS
SELECT
  o.id AS order_id,
  o.order_number,
  o.group_buy_id,
  o.customer_id,
  c.display_name AS customer_name,
  o.payment_rail,
  o.status AS order_status,
  o.total_usd AS billed_usd,
  COALESCE(pv.verified_usd, 0) AS received_usd,
  ov.override_usd,
  COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS effective_received_usd,
  o.total_usd - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS diff_usd,
  COALESCE(pp.pending_count, 0) AS pending_payment_count,
  CASE
    WHEN COALESCE(pv.verified_usd, 0) = 0 AND ov.override_usd IS NULL THEN 'awaiting'
    WHEN ABS(o.total_usd - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0))) <= gb.reconcile_tolerance_usd THEN 'matched'
    WHEN o.total_usd > COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) THEN 'short'
    ELSE 'over'
  END AS recon_status
FROM orders o
JOIN group_buys gb ON gb.id = o.group_buy_id
JOIN customers c ON c.id = o.customer_id
LEFT JOIN (
  SELECT order_id, SUM(amount_usd) AS verified_usd
  FROM payments
  WHERE status = 'verified'
  GROUP BY order_id
) pv ON pv.order_id = o.id
LEFT JOIN (
  SELECT order_id, COUNT(*) AS pending_count
  FROM payments
  WHERE status = 'pending'
  GROUP BY order_id
) pp ON pp.order_id = o.id
LEFT JOIN LATERAL (
  SELECT amount_usd AS override_usd
  FROM payment_overrides po
  WHERE po.order_id = o.id
  ORDER BY po.created_at DESC
  LIMIT 1
) ov ON true
WHERE o.status NOT IN ('cancelled','refunded');

-- Per-rail totals vs latest wallet snapshot
CREATE VIEW v_rail_reconciliation AS
SELECT
  r.group_buy_id,
  r.payment_rail,
  COUNT(*) AS order_count,
  SUM(r.billed_usd) AS billed_usd,
  SUM(r.effective_received_usd) AS received_usd,
  SUM(r.billed_usd) - SUM(r.effective_received_usd) AS gap_usd
FROM v_order_reconciliation r
GROUP BY r.group_buy_id, r.payment_rail;

-- Campaign P&L (replaces Profit tab summary; supplies finally included)
CREATE VIEW v_group_buy_pnl AS
SELECT
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  COALESCE(prod.expected_revenue_usd, 0) AS product_revenue_usd,
  COALESCE(ord.order_count, 0) AS order_count,
  COALESCE(ord.admin_fees_usd, 0) AS admin_fee_revenue_usd,
  COALESCE(ord.shipping_fees_usd, 0) AS shipping_fee_revenue_usd,
  COALESCE(ord.tips_usd, 0) AS tip_revenue_usd,
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0) AS net_profit_usd
FROM group_buys gb
LEFT JOIN (
  SELECT group_buy_id,
    SUM(expected_revenue_usd) AS expected_revenue_usd,
    SUM(total_product_profit_usd) AS product_profit_usd
  FROM v_product_profit
  GROUP BY group_buy_id
) prod ON prod.group_buy_id = gb.id
LEFT JOIN (
  SELECT group_buy_id, COUNT(*) AS order_count,
    SUM(admin_fee_usd) AS admin_fees_usd,
    SUM(shipping_fee_usd) AS shipping_fees_usd,
    SUM(tip_usd) AS tips_usd
  FROM orders
  WHERE status NOT IN ('cancelled','refunded')
  GROUP BY group_buy_id
) ord ON ord.group_buy_id = gb.id
LEFT JOIN (
  SELECT group_buy_id, SUM(total_usd) AS expenses_usd
  FROM expenses
  GROUP BY group_buy_id
) exp ON exp.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(s.label_cost_usd) AS label_costs_usd
  FROM shipments s
  JOIN orders o ON o.id = s.order_id
  GROUP BY o.group_buy_id
) ship ON ship.group_buy_id = gb.id;
