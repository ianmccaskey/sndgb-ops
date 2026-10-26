-- A vendor payment can be sent on more than one rail.
--
-- Ian, 2026-10-26: "sometimes we are ordering across multiple product
-- lines and are forced to do one send on sol and another on ethereum to
-- make up the total of the send to vendor."
--
-- Until now one vendor_payments row was BOTH the product attribution (kits,
-- freight, amount per product) AND the money's origin (wallet_id, receipt
-- ref). A send that covers several products could be recorded only by
-- splitting each product's kits across the wallets by hand (Mixed Buy #1
-- carries "Split Lobster ETH" / "Split Lobster SOL" pairs for exactly this).
--
-- The two concerns now separate:
--
--  * vendor_payment_batches — ONE recorded vendor payment: vendor, campaign,
--    date, note. Its product lines stay in vendor_payments (batch_id set,
--    wallet_id NULL: the money is on the sends, never on the line, so the
--    rail cards cannot double count); its money is in vendor_payment_sends.
--  * vendor_payment_sends — one row per on-chain send: wallet (rail),
--    amount, token/method, tx ref. A batch may have any number of sends on
--    any mix of wallets.
--  * The ledgers keep reading what they read: kits/freight/amount owed per
--    product from the LINES (v_vendor_balances, per-product progress, the
--    kit caps), money out of each wallet from the SENDS (rail cards).
--
-- Invariant, enforced by a deferred constraint trigger on both tables and
-- re-checked at every commit: a batch's sends total exactly its lines'
-- total, and a batch has at least one line and one send. A line or send
-- can therefore never leave a batch on its own — the whole batch is
-- removed together (deleteVendorPaymentBatch), audited with every row.
--
-- A vendor_payments row WITHOUT a batch is what it always was: a single
-- send from its own wallet_id (the stock-plan commit and the at-cost
-- reallocation still write those). v_vendor_outflows is the ONE view of
-- money that left a wallet for a vendor, over both shapes — rail readers
-- read it instead of vendor_payments.wallet_id.

CREATE TABLE vendor_payment_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id),
  group_buy_id BIGINT NOT NULL REFERENCES group_buys(id),
  paid_on DATE NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- lines and sends bind to the batch's vendor AND campaign (composite FKs
  -- below), so a batch can never hold another vendor's line or another
  -- campaign's send
  UNIQUE (id, vendor_id, group_buy_id)
);
CREATE INDEX vendor_payment_batches_gb_idx ON vendor_payment_batches (group_buy_id, vendor_id);

CREATE TABLE vendor_payment_sends (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES vendor_payment_batches(id) ON DELETE CASCADE,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id),
  group_buy_id BIGINT NOT NULL REFERENCES group_buys(id),
  wallet_id BIGINT NOT NULL REFERENCES wallets(id),
  amount_usd NUMERIC(12,2) NOT NULL CHECK (amount_usd > 0),
  method TEXT,            -- 'USDC', 'USDT', 'wire', ...
  tx_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id, vendor_id, group_buy_id)
    REFERENCES vendor_payment_batches (id, vendor_id, group_buy_id) ON DELETE CASCADE
);
CREATE INDEX vendor_payment_sends_batch_idx ON vendor_payment_sends (batch_id);
CREATE INDEX vendor_payment_sends_wallet_idx ON vendor_payment_sends (group_buy_id, wallet_id);

ALTER TABLE vendor_payments
  ADD COLUMN batch_id BIGINT REFERENCES vendor_payment_batches(id) ON DELETE CASCADE,
  ADD CONSTRAINT vendor_payments_batch_fk
    FOREIGN KEY (batch_id, vendor_id, group_buy_id)
    REFERENCES vendor_payment_batches (id, vendor_id, group_buy_id) ON DELETE CASCADE,
  -- a batched line's money is on its sends: a wallet on the line too would
  -- count the same dollars twice on the rail cards
  ADD CONSTRAINT vendor_payments_batch_money_on_sends
    CHECK (batch_id IS NULL OR wallet_id IS NULL);
CREATE INDEX vendor_payments_batch_idx ON vendor_payments (batch_id) WHERE batch_id IS NOT NULL;

-- Batch balance: sends total = lines total, at least one of each. Deferred
-- so a batch, its lines and its sends can be written in one transaction in
-- any order; checked once per touched batch at commit.
CREATE OR REPLACE FUNCTION vendor_payment_batch_check(p_batch BIGINT) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_lines NUMERIC;
  v_sends NUMERIC;
  v_line_n INT;
  v_send_n INT;
BEGIN
  IF p_batch IS NULL THEN
    RETURN;
  END IF;
  -- the batch itself may already be gone (whole-batch delete cascades):
  -- nothing left to balance
  IF NOT EXISTS (SELECT 1 FROM vendor_payment_batches b WHERE b.id = p_batch) THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM(vp.amount_usd), 0), COUNT(*) INTO v_lines, v_line_n
  FROM vendor_payments vp WHERE vp.batch_id = p_batch;
  SELECT COALESCE(SUM(s.amount_usd), 0), COUNT(*) INTO v_sends, v_send_n
  FROM vendor_payment_sends s WHERE s.batch_id = p_batch;
  IF v_line_n = 0 OR v_send_n = 0 OR v_lines <> v_sends THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('vendor payment batch %s is not balanced: lines %s (%s) vs sends %s (%s) — a batch is recorded and removed as a whole',
                       p_batch, v_lines, v_line_n, v_sends, v_send_n),
      CONSTRAINT = 'vendor_payment_batch_balanced';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION vendor_payment_batch_balanced() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- a row that LEAVES a batch (delete, or batch_id re-pointed / cleared)
  -- unbalances the batch it left as surely as one that joins unbalances
  -- the batch it joins: check both sides of an update
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM vendor_payment_batch_check(OLD.batch_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.amount_usd IS DISTINCT FROM OLD.amount_usd) THEN
    PERFORM vendor_payment_batch_check(NEW.batch_id);
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER vendor_payment_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON vendor_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vendor_payment_batch_balanced();

CREATE CONSTRAINT TRIGGER vendor_payment_sends_balanced
  AFTER INSERT OR UPDATE OR DELETE ON vendor_payment_sends
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vendor_payment_batch_balanced();

-- A batch row with no lines/sends is caught too (the trigger above only
-- fires on line/send rows): the batch insert itself must be followed by
-- its rows in the same transaction.
CREATE OR REPLACE FUNCTION vendor_payment_batch_has_rows() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vendor_payment_batches b WHERE b.id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vendor_payments vp WHERE vp.batch_id = NEW.id)
     OR NOT EXISTS (SELECT 1 FROM vendor_payment_sends s WHERE s.batch_id = NEW.id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('vendor payment batch %s has no lines or no sends', NEW.id),
      CONSTRAINT = 'vendor_payment_batch_has_rows';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER vendor_payment_batch_has_rows
  AFTER INSERT ON vendor_payment_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vendor_payment_batch_has_rows();

-- Every dollar that left a wallet for a vendor, whichever shape recorded
-- it. created_at is when the money was RECORDED (the rail cards compare
-- it to each wallet's snapshot time), so a batch's sends carry the batch's
-- recording time.
CREATE VIEW v_vendor_outflows AS
SELECT 'line'::text AS source, vp.id AS source_id, NULL::bigint AS batch_id,
       vp.vendor_id, vp.group_buy_id, vp.wallet_id, vp.amount_usd, vp.method,
       vp.receipt_ref AS tx_ref, vp.paid_on, vp.created_at
FROM vendor_payments vp
WHERE vp.batch_id IS NULL AND vp.wallet_id IS NOT NULL
UNION ALL
SELECT 'send', s.id, s.batch_id,
       s.vendor_id, s.group_buy_id, s.wallet_id, s.amount_usd, s.method,
       s.tx_ref, b.paid_on, s.created_at
FROM vendor_payment_sends s
JOIN vendor_payment_batches b ON b.id = s.batch_id;

COMMENT ON VIEW v_vendor_outflows IS
  'Money out of a wallet to a vendor (1790102100): unbatched vendor_payments rows with a wallet, plus every batch send. Rail readers read this, never vendor_payments.wallet_id.';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102100_vendor_payment_batches.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102100_vendor_payment_batches.sql');
