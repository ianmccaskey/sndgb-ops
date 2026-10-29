-- A pending hash does not hold back an order that is already paid.
--
-- Ian, 2026-10-28, on 2026-ELO-378 (matched: $295 verified against $295
-- due, plus an imported SOL hash still pending at $0): "even if there is
-- that pending, her effective received matches what she owes so that
-- should not prevent the order from being able to be packed".
--
-- v_order_reconciliation counts only VERIFIED payments (or the operator's
-- override) as received, so a pending hash never makes an order read
-- matched or over. Once it does, verified money already covers what is
-- due, and the extra "AND r.pending_payment_count = 0" on every ship gate
-- protected nothing: it only parked paid orders off Ready to pack behind
-- hashes the auto-reconcile pass had already handed to the operator
-- (five Elora orders, every one a transfer that never paid our wallet).
-- The money gate everywhere is now recon_status IN ('matched', 'over'),
-- not held. A pending hash still shows on the order and in
-- Reconciliation, and on the Fulfillment row as a badge; if it later
-- verifies, the order reads over and the overpayment is handled there.
--
-- The write-off gate (setOrderWriteoff) keeps its pending check: a
-- write-off forgives money a pending hash may still turn out to be.
--
-- The four write-time functions are rewritten from their LIVE definitions
-- rather than re-typed: each carries the gate on exactly one line, the
-- line is removed and the definition re-executed (same signature, owner
-- and grants under CREATE OR REPLACE). The block refuses unless every
-- function had exactly one such line and none has one afterwards. The
-- app-side gates (listFulfillmentQueue ready/direct,
-- markShipmentPurchaseStarted, listDirectShipCandidates,
-- markTransferPurchaseStarted, finalizeTransfer) drop the same line.
DO $mig$
DECLARE
  v_fn regprocedure;
  v_def text;
  v_hits int;
  v_done int := 0;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('create_shipment_draft', 'create_manual_shipment',
                        'create_transfer_draft', 'create_manual_transfer')
  LOOP
    v_def := pg_get_functiondef(v_fn);
    SELECT count(*) INTO v_hits
    FROM regexp_matches(v_def, '\n[ \t]*AND r\.pending_payment_count = 0', 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% carries the pending-payment gate % times, expected exactly 1', v_fn, v_hits;
    END IF;
    EXECUTE regexp_replace(v_def, '\n[ \t]*AND r\.pending_payment_count = 0', '');
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 4 THEN
    RAISE EXCEPTION 'expected 4 ship-gate functions, rewrote %', v_done;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('create_shipment_draft', 'create_manual_shipment',
                        'create_transfer_draft', 'create_manual_transfer')
      AND p.prosrc LIKE '%pending_payment_count%'
  ) THEN
    RAISE EXCEPTION 'a ship-gate function still reads pending_payment_count';
  END IF;
END
$mig$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102900_ship_gate_ignores_pending_hashes.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102900_ship_gate_ignores_pending_hashes.sql');
