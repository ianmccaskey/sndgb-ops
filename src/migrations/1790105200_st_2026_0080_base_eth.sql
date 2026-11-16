-- ST-2026-0080 (PRT, $130, asked USDC on Ethereum): the buyer paid on Base.
--
-- Payment 82 is the buyer's claim, 0xa18f403f…3498. That transaction is on
-- Base (block 58,091,625, 2026-11-16 05:58 UTC), not Ethereum: a bridge
-- relayer (0x3dd42e54…a6aa, 340k+ transactions) delivered 0.07196594 native
-- ETH to the PRT receive wallet 0x7572918478Ba0cd6a64ca62Da42Fbf326aaa4E2e
-- by an internal call (no token transfer; the wallet's Base balance went
-- 0 → 0.07196594 ETH in that block). The storefront looks the claim up on the
-- order's network only, so it read "not indexed yet" on every attempt and
-- would have closed the claim as never found after 7 days — while the money
-- sat in the wallet on Base and no one was shown it.
--
-- Ian swapped that ETH to USDT on Ethereum (2026-11-16): the swap delivered
-- 129.996547 USDT to the same wallet in Ethereum transaction 0xd782443f…bc09
-- (block 26,425,881, filled by 0x9d56e8ef…b258; 0.129996 USDT went to the
-- swap's fee address, not counted). Ian: "Apply the tx hash … so that the
-- order goes through".
--
-- Recorded as what happened, the same way ST-2026-0017 was (1790104600 §7):
--  1. payment 82 becomes what the verifier would have written had it looked
--     on Base: found, a wrong-token payment (native ETH is never counted),
--     $0, flagged off_token with one sentence for the organizers, and no
--     longer re-checked on Ethereum. flag_notified_at is stamped: the
--     organizers already know (Ian did the swap), so no alert email goes out.
--  2. the swap is recorded through the organizers' own function,
--     store_record_conversion: a PENDING claim converting payment 82. The
--     storefront worker verifies it on Ethereum within a minute, credits only
--     the wallet's net stablecoin gain (USDT at face value), pays the order
--     once it covers $130 within the $1 tolerance, resolves payment 82's flag,
--     and writes the PRT order as for any paid PRT order.
-- Nothing here sets an amount the chain did not show or marks the order paid.
-- Guarded by the exact state found (payment 82 pending, unflagged, on that
-- hash and order), so a re-run, or a row the worker moved first, is left alone.
-- Locks in store_record_conversion's order: the claim's hash (42022), then
-- the order row, then the claim.
DO $fix$
DECLARE
  v_claim_hash constant text := '0xa18f403f572c5f542f8ca26bab4d48986d05f235daf64b5f318cedd47b7e3498';
  v_swap_hash  constant text := '0xd782443feece945a2eaf42ba47c0e6782a188b8526d51710bbbd379a0463bc09';
  v_n int;
BEGIN
  PERFORM pg_advisory_xact_lock(42022, hashtext(v_claim_hash));
  PERFORM 1 FROM storefront.store_orders WHERE id = 93 AND order_number = 'ST-2026-0080' FOR UPDATE;
  PERFORM 1 FROM storefront.payments WHERE id = 82 FOR UPDATE;

  UPDATE storefront.payments p
     SET status = 'mismatch',
         verified_usd = 0,
         verified_at = now(),
         next_verify_at = NULL,
         verify_attempts = p.verify_attempts + 1,
         verify_error = 'found on Base, not Ethereum: 0.07196594 ETH (native ETH is not counted)',
         onchain = jsonb_build_object(
           'network', 'base',
           'block', 58091625,
           'wallet', '0x7572918478ba0cd6a64ca62da42fbf326aaa4e2e',
           'gains', jsonb_build_array(jsonb_build_object('token', 'ETH', 'amount', 0.07196594)),
           'transfers', jsonb_build_array(jsonb_build_object('token', 'ETH', 'amount', 0.07196594, 'from', '0xbf2f1213f47e76f1c1d9b7a536f2cb8b347d59b4', 'internal', true)),
           'net', jsonb_build_object('ETH', 0.07196594),
           'senders', jsonb_build_array('0xbf2f1213f47e76f1c1d9b7a536f2cb8b347d59b4'),
           'signer', '0x3dd42e54a48c109643bbb8b230392a2c0abaa6aa',
           'flags', jsonb_build_array('off_token'),
           'recordedBy', 'migration 1790105200 (read from Base by hand; the storefront checks Ethereum only)'),
         flags = ARRAY['off_token'],
         flag_note = 'Paid 0.07196594 ETH on Base instead of USDC on Ethereum — native ETH isn''t counted.',
         flag_notified_at = now()
    FROM storefront.store_orders o
   WHERE p.id = 82
     AND o.id = p.store_order_id
     AND o.id = 93
     AND o.order_number = 'ST-2026-0080'
     AND o.status = 'payment_submitted'
     AND p.status = 'pending'
     AND cardinality(p.flags) = 0
     AND p.conversion_of IS NULL
     AND p.tx_hash_canonical = v_claim_hash;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE NOTICE '1790105200: payment 82 is not in the state this fix was written for; left alone.';
    RETURN;
  END IF;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('storefront.payments', '82', 'payment_corrected', 'Ian McCaskey',
          jsonb_build_object('status', 'pending', 'verifyError', 'The network hasn''t indexed that transaction yet.'),
          jsonb_build_object('orderNumber', 'ST-2026-0080', 'status', 'mismatch', 'verifiedUsd', 0, 'flags', jsonb_build_array('off_token'),
                             'why', 'the claim''s transaction is on Base (0.07196594 native ETH to the PRT wallet), not Ethereum, so the storefront could never find it'));

  PERFORM storefront.store_record_conversion('Ian McCaskey', '82', v_swap_hash,
                                             'swapped the 0.07196594 ETH on Base to USDT on Ethereum');
END
$fix$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790105200_st_2026_0080_base_eth.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790105200_st_2026_0080_base_eth.sql');
