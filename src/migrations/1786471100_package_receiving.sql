-- PACKAGE RECEIVING & TRACKING: reusable receive addresses, inbound
-- vendor packages with itemized contents and Shippo tracking, per-address
-- inventory (received minus transferred-out), and Shippo-label transfers.
-- Deliberately a PARALLEL subsystem: touches NO money tables or views —
-- label costs are logged here, never auto-booked to P&L.
--
-- Invariants enforced at the DB:
--  * one ACTIVE package per (carrier, tracking_number) — a partial unique
--    index, because USPS recycles numbers (~120 days) and re-ships may
--    legitimately repeat a number once the old package is received;
--  * item quantities positive (named CHECKs);
--  * one transfer per purchased Shippo rate (UNIQUE shippo_rate_id) — the
--    DB backstop against a double-clicked label purchase creating two
--    transfer rows for one real-money label;
--  * transfers are DRAFT-FIRST (finalized_at NULL until the label purchase
--    lands) so a failed purchase never leaves phantom inventory movement:
--    the inventory view counts ONLY finalized transfers.

CREATE TABLE receive_addresses (
  id bigserial PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  street1 TEXT NOT NULL,
  street2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  phone TEXT,
  email TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbound_packages (
  id bigserial PRIMARY KEY,
  receive_address_id bigint NOT NULL REFERENCES receive_addresses(id),
  vendor_id bigint REFERENCES vendors(id),
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  note TEXT,
  committed_at timestamptz,
  -- Shippo tracking snapshot: ALL nullable — a fresh label has
  -- tracking_status null (no scans yet, distinct from UNKNOWN)
  tracking_status TEXT,
  tracking_substatus TEXT,          -- substatus.code (Shippo returns an object)
  tracking_detail TEXT,
  tracking_error TEXT,              -- last refresh error, human-readable
  tracking_location jsonb,          -- {city,state,zip,country}
  eta timestamptz,
  status_date timestamptz,
  last_checked_at timestamptz,
  received_at timestamptz,
  received_by TEXT,
  created_by TEXT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbound_packages_active_tracking_uniq
  ON inbound_packages (carrier, tracking_number)
  WHERE received_at IS NULL;

CREATE TABLE inbound_package_items (
  id bigserial PRIMARY KEY,
  package_id bigint NOT NULL REFERENCES inbound_packages(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  qty NUMERIC(10,2) NOT NULL
    CONSTRAINT inbound_package_items_qty_positive CHECK (qty > 0),
  UNIQUE (package_id, product_id)
);

CREATE TABLE transfer_destinations (
  id bigserial PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  street1 TEXT NOT NULL,
  street2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  phone TEXT,
  email TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id bigserial PRIMARY KEY,
  from_address_id bigint NOT NULL REFERENCES receive_addresses(id),
  destination_label TEXT NOT NULL,
  destination jsonb NOT NULL,       -- full address snapshot used on the label
  parcel jsonb NOT NULL,            -- Shippo keys: length,width,height,distance_unit,weight,mass_unit
  carrier TEXT,
  servicelevel TEXT,
  rate_amount NUMERIC(12,2),
  rate_currency TEXT,
  shippo_rate_id TEXT
    CONSTRAINT transfers_rate_unique UNIQUE,
  shippo_transaction_id TEXT,
  tracking_number TEXT,
  label_url TEXT,
  refund_status TEXT,
  note TEXT,
  finalized_at timestamptz,
  created_by TEXT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfer_items (
  id bigserial PRIMARY KEY,
  transfer_id bigint NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  qty NUMERIC(10,2) NOT NULL
    CONSTRAINT transfer_items_qty_positive CHECK (qty > 0),
  UNIQUE (transfer_id, product_id)
);

-- Per-address, per-product inventory. FULL OUTER JOIN is load-bearing:
-- an un-received package after a finalized transfer leaves a row with
-- transferred > 0 and received = 0 — that NEGATIVE on-hand must stay
-- visible (rendered amber in the UI), never silently dropped.
CREATE VIEW v_address_inventory AS
WITH rcv AS (
  SELECT p.receive_address_id, i.product_id, SUM(i.qty) AS received_qty
  FROM inbound_package_items i
  JOIN inbound_packages p ON p.id = i.package_id
  WHERE p.received_at IS NOT NULL
  GROUP BY p.receive_address_id, i.product_id
), xfr AS (
  SELECT t.from_address_id AS receive_address_id, ti.product_id, SUM(ti.qty) AS transferred_qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.finalized_at IS NOT NULL
  GROUP BY t.from_address_id, ti.product_id
)
SELECT COALESCE(rcv.receive_address_id, xfr.receive_address_id) AS receive_address_id,
       COALESCE(rcv.product_id, xfr.product_id) AS product_id,
       COALESCE(rcv.received_qty, 0) AS received_qty,
       COALESCE(xfr.transferred_qty, 0) AS transferred_qty,
       COALESCE(rcv.received_qty, 0) - COALESCE(xfr.transferred_qty, 0) AS on_hand_qty
FROM rcv
FULL OUTER JOIN xfr
  ON xfr.receive_address_id = rcv.receive_address_id
 AND xfr.product_id = rcv.product_id;
