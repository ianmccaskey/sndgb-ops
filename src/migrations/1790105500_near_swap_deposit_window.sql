-- Token swaps (NEAR Intents): a swap's saved deadline is the deposit window
-- 1Click enforces, not the moment it stops watching the address.
--
-- storefront.near_swaps.deadline held the quote's own deadline
-- (quote.deadline = quote.timeWhenInactive), 72 hours after the deadline the
-- storefront asks 1Click for (quote.quoteRequest.deadline), which 1Click's
-- docs define as "when the user refund begins if the swap isn't completed by
-- then". The order page showed the later time as the time to pay by, so
-- ST-2026-0058's Bitcoin arrived 7 hours into a 3-hour window the page had
-- shown as 3 days and came back as QUOTE_EXPIRED. The store's hold on the
-- order, the clock expiry and P2 Collective Orders' member orders list read
-- the same wrong time.
--
-- The storefront saves the requested deadline from p2collective-app 95d9868
-- on (lib/near/units.ts depositWindowEnd). This corrects every row saved
-- before it from the quote request the row carries: only where that request
-- names a well-formed deadline earlier than the one stored, so a re-run
-- changes nothing, and it is run once more after the storefront deploys to
-- catch a row the old code wrote in between. Each corrected swap gets an
-- audit row with both times. Nothing else on the row changes; the sweep
-- keeps watching a pending address until the quote's timeWhenInactive.
DO $fix$
DECLARE
  v_n int;
BEGIN
  WITH r AS (
    SELECT n.id, n.deadline AS was,
           -- only an absolute ISO 8601 instant with its zone, as the storefront
           -- writes it (never 'infinity', 'yesterday' or a bare date), that
           -- Postgres also accepts (no month 99, no zone +99:99): checked in
           -- CASE, not a WHERE beside the cast, so the cast never sees
           -- anything else, and such a row is left as it is
           CASE WHEN n.quote->'quoteRequest'->>'deadline' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                 AND pg_input_is_valid(n.quote->'quoteRequest'->>'deadline', 'timestamptz')
                THEN (n.quote->'quoteRequest'->>'deadline')::timestamptz END AS requested,
           n.created_at
      FROM storefront.near_swaps n
     FOR UPDATE
  ), fixed AS (
    UPDATE storefront.near_swaps n
       SET deadline = r.requested
      FROM r
     -- a deadline after the swap was quoted and before the one stored: the
     -- window can only shrink to what was asked, never to before it opened
     WHERE n.id = r.id AND r.requested IS NOT NULL AND r.requested > r.created_at AND r.requested < r.was
    RETURNING n.id, r.was, r.requested
  )
  INSERT INTO public.audit_log (table_name, row_pk, action, actor, old_data, new_data)
  SELECT 'storefront.near_swaps', f.id::text, 'deadline_corrected', 'migration 1790105500',
         jsonb_build_object('deadline', f.was),
         jsonb_build_object('deadline', f.requested, 'why', 'the deposit window 1Click enforces (quoteRequest.deadline), not when it stops watching the address')
    FROM fixed f;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'near_swaps deadlines corrected: %', v_n;
END
$fix$;
