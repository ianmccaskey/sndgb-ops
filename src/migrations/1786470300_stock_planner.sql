-- Stock Planner: a saved, shared plan for distributing profit into
-- additional vendor orders (personal stock) for a campaign. One plan per
-- campaign; sources beyond the wallets are operator-entered (outside wallet
-- with a max attributable cap, and a hypothetical cash-profit figure).
-- Planning tables only — NO money view changes: planned values are computed
-- live (kits x (unit_cost + freight)); committing an allocation routes
-- through the existing guarded addVendorPayment, and the plan line then
-- snapshots what was actually paid (ordered_value_usd).

CREATE TABLE stock_plans (
  id bigserial PRIMARY KEY,
  group_buy_id bigint NOT NULL UNIQUE REFERENCES group_buys(id),
  outside_total_usd NUMERIC(12,2) NOT NULL DEFAULT 0
    CONSTRAINT stock_plans_outside_total_nonneg CHECK (outside_total_usd >= 0),
  outside_max_usd NUMERIC(12,2) NOT NULL DEFAULT 0
    CONSTRAINT stock_plans_outside_max_valid CHECK (outside_max_usd >= 0),
  cash_assignable_usd NUMERIC(12,2) NOT NULL DEFAULT 0
    CONSTRAINT stock_plans_cash_nonneg CHECK (cash_assignable_usd >= 0),
  updated_by TEXT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- the attributable slice can never exceed what the outside wallet holds
  CONSTRAINT stock_plans_outside_max_lte_total CHECK (outside_max_usd <= outside_total_usd)
);

CREATE TABLE stock_plan_items (
  id bigserial PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES stock_plans(id),
  group_buy_product_id bigint NOT NULL REFERENCES group_buy_products(id),
  -- whole kits only: that's what you order, and it matches the at-cost /
  -- over-buy ledgers the plan eventually feeds
  kits NUMERIC(10,2) NOT NULL
    CONSTRAINT stock_plan_items_kits_whole CHECK (kits > 0 AND kits % 1 = 0),
  ordered_at timestamptz,
  ordered_by TEXT,
  ordered_value_usd NUMERIC(12,2)
    CONSTRAINT stock_plan_items_ordered_value_nonneg CHECK (ordered_value_usd IS NULL OR ordered_value_usd >= 0),
  created_by TEXT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, group_buy_product_id)
);
