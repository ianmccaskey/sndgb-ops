-- Payments to check lists every store payment a person must look at, not
-- only the ones the storefront flagged (Ian, 2026-11-16: "I need to be able
-- to see these issues. currently I cant see problem payments when they are
-- paying PRT").
--
-- ST-2026-0080 (PRT): the buyer paid on Base, the order asked for Ethereum.
-- The storefront looks a claim up on the order's network only, so it read
-- "not indexed yet" for 50 minutes and would have closed the claim as never
-- found after 7 days. Nothing flagged it, so Payments to check (1790104600,
-- flags only) stayed empty — and a PRT order is invisible everywhere else
-- until its payment verifies (the PRT app gets it only then; Store orders
-- holds P² house orders, Shop orders member shops). ST-2026-0028 (PRT, $640)
-- has sat unpaid since 2026-11-10 behind nine rejected claims, unseen.
--
-- A store claim is a PROBLEM when (storefront.store_payment_problem):
--   flagged      the storefront flagged it (wrong token, the shop's own
--                transaction) — unchanged, and first: a flag wins
--   not_found    still pending 30 minutes after it was pasted: the network
--                never showed it (often: paid on another network)
--   rejected     refused (failed on-chain, nothing to the wallet on this
--                network, never found in 7 days) and its order is still
--                unpaid — nothing else paid it; one row per ORDER (its
--                latest rejected claim, with the count)
--   short        counted, but the order is still waiting on the rest
--                30 minutes later
--   not_payable  money arrived after the order was paid or cancelled
--                (the storefront records "order was … when verified"):
--                a refund or credit to decide
-- A recorded swap (conversion_of) is never a problem row of its own: it is
-- shown on the flagged claim it converts. No threshold here moves money or
-- changes a claim; it only decides what the organizers are shown.
--
-- Handling an unflagged problem is recorded in handled_* — kept apart from
-- flag_resolved_*, which the storefront reads as "this FLAG was handled"
-- (alert email, buyer copy, conversion resolution). handled_problem names
-- what was handled, so a claim whose problem CHANGES (a not-found claim that
-- later expires and is rejected) comes back to the list. "Mark handled" on a
-- rejected row stamps every unhandled rejected claim of that order up to the
-- one shown (the card is one per order), never a later one.

-- ── 1. what an organizer did about an unflagged problem ─────────────────────
ALTER TABLE storefront.payments
  ADD COLUMN IF NOT EXISTS handled_at timestamptz,
  ADD COLUMN IF NOT EXISTS handled_by text,
  ADD COLUMN IF NOT EXISTS handled_note text,
  ADD COLUMN IF NOT EXISTS handled_problem text;

DO $$ BEGIN
  ALTER TABLE storefront.payments ADD CONSTRAINT payments_handled_shape CHECK (
    ((handled_at IS NULL) = (handled_by IS NULL))
    AND ((handled_at IS NULL) = (handled_note IS NULL))
    AND ((handled_at IS NULL) = (handled_problem IS NULL))
    AND (handled_problem IS NULL OR handled_problem IN ('not_found', 'rejected', 'short', 'not_payable'))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. the one rule for "a person must look at this claim" ──────────────────
-- STABLE (reads now()); the list, the count and "Mark handled" all use it, so
-- they agree on what is open.
CREATE OR REPLACE FUNCTION storefront.store_payment_problem(
  p_flags text[], p_conversion_of bigint, p_status text, p_created_at timestamptz, p_verified_at timestamptz,
  p_verified_usd numeric, p_verify_error text, p_order_status text)
RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT CASE
    WHEN cardinality(COALESCE(p_flags, '{}')) > 0 THEN 'flagged'
    WHEN p_conversion_of IS NOT NULL THEN NULL
    WHEN p_status = 'pending' AND p_created_at <= now() - interval '30 minutes' THEN 'not_found'
    WHEN p_status = 'rejected' AND p_order_status = 'unpaid' THEN 'rejected'
    WHEN p_status = 'mismatch' AND p_order_status = 'payment_submitted'
         AND COALESCE(p_verified_at, p_created_at) <= now() - interval '30 minutes' THEN 'short'
    WHEN p_status IN ('verified', 'mismatch') AND COALESCE(p_verified_usd, 0) > 0
         AND p_verify_error LIKE 'order was % when verified' THEN 'not_payable'
  END
$fn$;

-- "47 minutes", "3 hours", "2 days": how long a claim has waited, for the note
CREATE OR REPLACE FUNCTION storefront.store_age_text(p interval) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT CASE
    WHEN p < interval '2 hours' THEN GREATEST(floor(extract(epoch FROM p) / 60), 0)::int || ' minutes'
    WHEN p < interval '2 days' THEN floor(extract(epoch FROM p) / 3600)::int || ' hours'
    ELSE floor(extract(epoch FROM p) / 86400)::int || ' days'
  END
$fn$;

-- ── 3. the organizers' list (P2 Collective Orders → Payments to check) ──────
-- Same columns as 1790104600 plus problem / problem_note / rejected_count;
-- flag_resolved_* carry the flag's resolution OR the handling, so the
-- Handled tab reads one set (NULL on an open row). The buyer is named by the
-- handle they verified with — never their email or address.
DROP FUNCTION IF EXISTS storefront.store_payments_to_check(text);
CREATE FUNCTION storefront.store_payments_to_check(p_scope text DEFAULT 'open')
RETURNS TABLE (payment_id bigint, store_order_id bigint, order_number text, order_status text, order_total_usd numeric,
               shop_name text, shop_kind text, house_source text, telegram_username text, discord_username text,
               rail text, status text, flags text[], flag_note text, received text, verified_usd numeric,
               tx_hash text, created_at timestamptz, flag_notified_at timestamptz,
               flag_resolved_at timestamptz, flag_resolved_by text, flag_resolution text,
               conversion_id bigint, conversion_status text, conversion_tx_hash text, conversion_usd numeric,
               conversion_note text, conversion_recorded_by text, conversion_created_at timestamptz,
               problem text, problem_note text, rejected_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE v_scope text := lower(btrim(COALESCE(p_scope, 'open')));
BEGIN
  IF v_scope NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'Unknown list: %.', p_scope USING ERRCODE = 'invalid_parameter_value', HINT = 'field:scope';
  END IF;
  RETURN QUERY
    WITH cand AS (
      SELECT p.*, o.order_number AS o_number, o.status::text AS o_status, o.total_usd AS o_total,
             o.telegram_username AS o_tg, o.discord_username AS o_dc, o.seller_id AS o_seller,
             storefront.store_payment_problem(p.flags, p.conversion_of, p.status::text, p.created_at, p.verified_at,
                                              p.verified_usd, p.verify_error, o.status::text) AS prob
        FROM storefront.payments p
        JOIN storefront.store_orders o ON o.id = p.store_order_id
       WHERE p.store_order_id IS NOT NULL
         AND (cardinality(p.flags) > 0
              OR p.handled_at IS NOT NULL   -- stays on the Handled tab after the storefront counts it
              OR (p.conversion_of IS NULL AND p.status <> 'verified')
              OR (p.conversion_of IS NULL AND p.verify_error LIKE 'order was % when verified'))
    ), shown AS (
      SELECT c.*,
             -- open: a flag not yet resolved, or a problem not handled as THAT problem
             CASE WHEN c.prob = 'flagged' THEN c.flag_resolved_at IS NULL
                  ELSE c.prob IS NOT NULL AND c.handled_problem IS DISTINCT FROM c.prob END AS is_open,
             count(*) FILTER (WHERE c.prob = 'rejected' AND c.handled_problem IS DISTINCT FROM 'rejected')
               OVER (PARTITION BY c.store_order_id) AS rej_open,
             row_number() OVER (PARTITION BY c.store_order_id, (c.prob = 'rejected' AND c.handled_problem IS DISTINCT FROM 'rejected')
                                ORDER BY c.created_at DESC, c.id DESC) AS rej_rank
        FROM cand c
    )
    SELECT s.id, s.store_order_id, s.o_number, s.o_status, s.o_total,
           sl.display_name, sl.kind::text, sl.house_source::text, s.o_tg, s.o_dc,
           s.rail::text, s.status::text, s.flags, s.flag_note, storefront.payment_received_text(s.onchain), s.verified_usd,
           s.tx_hash, s.created_at, s.flag_notified_at,
           -- what was done about it: only on a row that is no longer open (an open row
           -- may carry the handling of an EARLIER problem, which would read as this one's)
           CASE WHEN s.is_open THEN NULL WHEN cardinality(s.flags) > 0 THEN s.flag_resolved_at ELSE s.handled_at END,
           CASE WHEN s.is_open THEN NULL WHEN cardinality(s.flags) > 0 THEN s.flag_resolved_by ELSE s.handled_by END,
           CASE WHEN s.is_open THEN NULL WHEN cardinality(s.flags) > 0 THEN s.flag_resolution ELSE s.handled_note END,
           cv.id, cv.status::text, cv.tx_hash, cv.verified_usd, cv.verify_error, cv.recorded_by, cv.created_at,
           CASE WHEN cardinality(s.flags) > 0 THEN 'flagged' ELSE COALESCE(s.prob, s.handled_problem) END,
           CASE
             -- handled, and the problem has gone since (counted, or its order moved on)
             WHEN cardinality(s.flags) = 0 AND s.prob IS NULL THEN
               format('Handled as %s. The payment is %s now; the order is %s.',
                      CASE s.handled_problem WHEN 'not_found' THEN 'not found on-chain' WHEN 'rejected' THEN 'rejected'
                                             WHEN 'short' THEN 'paid short' ELSE 'arrived after paid or cancelled' END,
                      s.status::text, replace(s.o_status, '_', ' '))
             WHEN s.prob = 'not_found' THEN format('Not found on %s %s after it was pasted (%s checks). The storefront only looks on %s — the buyer may have paid on another network.',
                                          net.name, storefront.store_age_text(now() - s.created_at), s.verify_attempts, net.name)
             WHEN s.prob = 'rejected' THEN format('%s: %s. The order is still unpaid.',
                                         CASE WHEN rc.n > 1 THEN rc.n || ' payments rejected' ELSE 'Payment rejected' END,
                                         COALESCE(s.verify_error, 'no reason recorded'))
             WHEN s.prob = 'short' THEN format('Counted $%s of $%s on %s — the order is still waiting on the rest.',
                                      to_char(COALESCE(s.verified_usd, 0), 'FM999999990.00'), to_char(s.o_total, 'FM999999990.00'), net.name)
             WHEN s.prob = 'not_payable' THEN format('$%s arrived after the %s — refund or credit it.',
                                            to_char(COALESCE(s.verified_usd, 0), 'FM999999990.00'),
                                            CASE WHEN s.verify_error LIKE 'order was cancelled%' THEN 'order was cancelled' ELSE 'order was already paid' END)
           END,
           rc.n
      FROM shown s
      JOIN storefront.sellers sl ON sl.id = s.o_seller
      CROSS JOIN LATERAL (SELECT CASE s.rail::text WHEN 'sol' THEN 'Solana' WHEN 'base' THEN 'Base' WHEN 'eth' THEN 'Ethereum' ELSE s.rail::text END AS name) net
      -- rejected claims behind a row: the order's open ones, or those handled together with it
      CROSS JOIN LATERAL (
        SELECT CASE WHEN cardinality(s.flags) > 0 THEN NULL
                    WHEN s.is_open AND s.prob = 'rejected' THEN GREATEST(s.rej_open, 1)::integer
                    WHEN NOT s.is_open AND s.handled_problem = 'rejected' THEN
                      (SELECT count(*)::integer FROM storefront.payments r
                        WHERE r.store_order_id = s.store_order_id AND r.handled_problem = 'rejected'
                          AND (r.id = s.id OR r.handled_note LIKE format('(with payment #%s) %%', s.id)))
               END AS n
      ) rc
      LEFT JOIN LATERAL (
        SELECT c1.* FROM storefront.payments c1
         WHERE c1.conversion_of = s.id
         ORDER BY (c1.status <> 'rejected') DESC, c1.created_at DESC, c1.id DESC
         LIMIT 1
      ) cv ON true
     WHERE CASE WHEN v_scope = 'open'
                THEN s.is_open AND (s.prob <> 'rejected' OR s.rej_rank = 1)
                ELSE (s.flag_resolved_at IS NOT NULL AND s.flag_resolved_at >= now() - interval '60 days')
                  OR (cardinality(s.flags) = 0 AND s.handled_at IS NOT NULL AND s.handled_at >= now() - interval '60 days'
                      AND NOT s.is_open
                      -- a rejected order's claims were handled together: show the one the organizer acted on
                      AND (s.handled_problem <> 'rejected' OR s.handled_note NOT LIKE '(with payment #%'))
           END
     ORDER BY CASE WHEN v_scope = 'open' THEN extract(epoch FROM s.created_at)
                   ELSE -extract(epoch FROM COALESCE(s.flag_resolved_at, s.handled_at)) END, s.id;
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.store_payments_to_check(text) FROM PUBLIC;

-- ── 4. close a problem: a flag as before, or an unflagged problem ───────────
-- Money and the claim's status are untouched: this records what a person did
-- and why, under the order's row lock and the claim's (taken without waiting)
-- so it cannot cross a claim the storefront is applying and never deadlocks
-- with it. A rejected row stands for its order's unhandled
-- rejected claims up to the one shown; the others carry "(with payment #N)".
DROP FUNCTION IF EXISTS storefront.store_resolve_payment_flag(text, text, text);
CREATE FUNCTION storefront.store_resolve_payment_flag(p_actor text, p_payment_id text, p_resolution text)
RETURNS TABLE (payment_id bigint, message text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, storefront, public, pg_temp AS $fn$
DECLARE
  v_actor text := btrim(COALESCE(p_actor, ''));
  v_why_raw text := btrim(COALESCE(p_resolution, ''));
  v_why text := storefront.scrub_organizer_text(p_resolution);
  v_pid bigint;
  v_p storefront.payments%ROWTYPE;
  v_o storefront.store_orders%ROWTYPE;
  v_prob text;
  v_others bigint[];
  v_oid bigint;
BEGIN
  IF v_actor = '' THEN
    RAISE EXCEPTION 'Sign in again — this app could not tell who you are.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(btrim(p_payment_id), '') !~ '^[1-9][0-9]{0,17}$' THEN
    RAISE EXCEPTION 'That payment isn''t on the list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  v_pid := btrim(p_payment_id)::bigint;
  IF char_length(v_why_raw) < 3 OR char_length(v_why_raw) > 300 THEN
    RAISE EXCEPTION 'Say what you did, in 3 to 300 characters (for example "refunded 1.87 SOL to the buyer").' USING ERRCODE = 'invalid_parameter_value', HINT = 'field:resolution';
  END IF;
  -- Locks: the ORDER first, like every organizer writer (store_record_conversion
  -- too), so two clicks on one order queue there and the batch below never meets a
  -- claim another handler holds. The storefront worker takes its claim BEFORE the
  -- order (applyStoreVerification: payments JOIN store_orders FOR UPDATE) and only
  -- then other claims of the order (a swap's flagged original). So, holding the
  -- order, never WAIT for a claim: NOWAIT, and a claim the worker is checking this
  -- very moment is refused with "try again" — no cycle either way.
  SELECT p.store_order_id INTO v_oid FROM storefront.payments p WHERE p.id = v_pid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'That payment isn''t on the list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_o FROM storefront.store_orders WHERE id = v_oid FOR UPDATE;
  BEGIN
    SELECT * INTO v_p FROM storefront.payments WHERE id = v_pid AND store_order_id = v_oid FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'The storefront is updating this payment right now. Try again in a minute.' USING ERRCODE = 'object_not_in_prerequisite_state';
  END;
  IF v_p.id IS NULL THEN
    RAISE EXCEPTION 'That payment isn''t on the list. Reload the page.' USING ERRCODE = 'no_data_found';
  END IF;
  v_prob := storefront.store_payment_problem(v_p.flags, v_p.conversion_of, v_p.status::text, v_p.created_at, v_p.verified_at,
                                             v_p.verified_usd, v_p.verify_error, v_o.status::text);

  IF v_prob = 'flagged' THEN
    IF v_p.flag_resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'That payment was already handled (%). Reload the page.', v_p.flag_resolution USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF EXISTS (SELECT 1 FROM storefront.payments c WHERE c.conversion_of = v_pid AND c.status = 'pending') THEN
      RAISE EXCEPTION 'A recorded swap for this payment is still being checked. Wait for it, then reload.' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE storefront.payments SET flag_resolved_at = now(), flag_resolved_by = v_actor, flag_resolution = v_why WHERE id = v_pid;
    INSERT INTO public.audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('storefront.payments', v_pid::text, 'payment_flag_resolved', v_actor,
            jsonb_build_object('orderNumber', v_o.order_number, 'storeOrderId', v_o.id, 'flags', to_jsonb(v_p.flags), 'resolution', v_why));
    RETURN QUERY SELECT v_pid, format('Marked handled on %s.', v_o.order_number);
    RETURN;
  END IF;

  IF v_prob IS NULL THEN
    RAISE EXCEPTION '%', CASE WHEN v_p.status::text = 'verified' THEN 'That payment has been counted since — there is nothing left to handle. Reload the page.'
                              WHEN v_o.status::text NOT IN ('unpaid', 'payment_submitted') THEN format('Order %s is %s now, so this payment no longer needs a look. Reload the page.', v_o.order_number, replace(v_o.status::text, '_', ' '))
                              ELSE 'That payment isn''t on the list. Reload the page.' END
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_p.handled_problem IS NOT DISTINCT FROM v_prob THEN
    RAISE EXCEPTION 'That payment was already handled (%). Reload the page.', v_p.handled_note USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_prob = 'rejected' AND EXISTS (
       SELECT 1 FROM storefront.payments r
        WHERE r.store_order_id = v_o.id AND r.id <> v_pid AND r.status = 'rejected' AND cardinality(r.flags) = 0
          AND r.conversion_of IS NULL AND r.handled_problem IS DISTINCT FROM 'rejected'
          AND (r.created_at, r.id) > (v_p.created_at, v_p.id)) THEN
    RAISE EXCEPTION 'A later payment on % was rejected too. Reload the page and handle the order from its latest payment.', v_o.order_number USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE storefront.payments
     SET handled_at = now(), handled_by = v_actor, handled_note = v_why, handled_problem = v_prob
   WHERE id = v_pid;
  IF v_prob = 'rejected' THEN
    -- the order's other claims too, without waiting while the order is held
    BEGIN
      PERFORM 1 FROM storefront.payments r
       WHERE r.store_order_id = v_o.id AND r.id <> v_pid AND r.status = 'rejected' AND cardinality(r.flags) = 0
         AND r.conversion_of IS NULL AND r.handled_problem IS DISTINCT FROM 'rejected'
         AND (r.created_at, r.id) < (v_p.created_at, v_p.id)
         FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'The storefront is updating a payment on % right now. Try again in a minute.', v_o.order_number USING ERRCODE = 'object_not_in_prerequisite_state';
    END;
    WITH upd AS (
      UPDATE storefront.payments r
         SET handled_at = now(), handled_by = v_actor, handled_note = format('(with payment #%s) %s', v_pid, v_why), handled_problem = 'rejected'
       WHERE r.store_order_id = v_o.id AND r.id <> v_pid AND r.status = 'rejected' AND cardinality(r.flags) = 0
         AND r.conversion_of IS NULL AND r.handled_problem IS DISTINCT FROM 'rejected'
         AND (r.created_at, r.id) < (v_p.created_at, v_p.id)
      RETURNING r.id
    )
    SELECT array_agg(id ORDER BY id) INTO v_others FROM upd;
  END IF;
  INSERT INTO public.audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('storefront.payments', v_pid::text, 'payment_problem_handled', v_actor,
          jsonb_build_object('orderNumber', v_o.order_number, 'storeOrderId', v_o.id, 'problem', v_prob, 'status', v_p.status,
                             'resolution', v_why, 'alsoHandled', to_jsonb(COALESCE(v_others, '{}'::bigint[]))));
  RETURN QUERY SELECT v_pid, format('Marked handled on %s%s.', v_o.order_number,
                                    CASE WHEN cardinality(COALESCE(v_others, '{}'::bigint[])) > 0
                                         THEN format(' (with %s earlier rejected payment%s)', cardinality(v_others), CASE WHEN cardinality(v_others) > 1 THEN 's' ELSE '' END)
                                         ELSE '' END);
END
$fn$;
REVOKE EXECUTE ON FUNCTION storefront.store_resolve_payment_flag(text, text, text) FROM PUBLIC;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790105300_store_payment_problems.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790105300_store_payment_problems.sql');
