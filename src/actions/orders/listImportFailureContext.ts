import { action } from '@uibakery/data';

/**
 * Triage facts for the read-only assistant: the campaign's OPEN import
 * failures, each with the evidence needed to say which side of a hash
 * conflict is wrong. Read-only, campaign-scoped on the failures.
 * focus_order (blank = all) narrows to one order's failure, so a row's
 * Ask always gets that row however many are open; unfocused, the oldest
 * 50 are listed and open_total says how many exist.
 *
 * - local_order / local_payments: the failing order as this app holds it
 *   (null = never imported here). No member fields are selected.
 * - upstream_refs: the tx refs the ordering-app record listed at its last
 *   import (base44 only — storefront and paste snapshots don't keep them).
 * - hash_holders: every payment carrying a hash the message names. The
 *   runner's messages label a hash "tx <first 10>…<last 6>" whatever the
 *   source, so matching on that label finds the holder for every source.
 *   A holder may sit in ANOTHER campaign (a member re-using an earlier
 *   buy's signature) — only the order the message already names is read,
 *   with its reconciliation, never its member data; same_customer is a
 *   boolean, not the customer.
 * - resolved_by_hand: earlier hand resolutions of the same order's
 *   failures — a failure that keeps returning means its cause is still in
 *   the source.
 */
function listImportFailureContext() {
  return action('listImportFailureContext', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.group_buy_id}}::text, '')::bigint AS gb,
               NULLIF(btrim({{params.focus_order}}::text), '') AS focus
      ), f AS (
        SELECT f.id, f.order_number, f.message, f.seen_count, f.first_seen_at, f.last_seen_at
        FROM import_failures f, inp
        WHERE f.group_buy_id = inp.gb AND f.resolved_at IS NULL
          AND (inp.focus IS NULL OR f.order_number = inp.focus)
        ORDER BY f.first_seen_at
        LIMIT 50
      ), o AS (
        SELECT f.id AS failure_id, ord.*
        FROM f, inp
        LEFT JOIN LATERAL (
          SELECT x.id, x.customer_id, x.status, x.payment_rail, x.total_usd, x.admin_note,
                 COALESCE(x.raw_import->>'source', 'paste') AS source,
                 CASE WHEN x.raw_import->>'source' = 'base44'
                      THEN (x.raw_import->>'json')::jsonb->>'transaction_hashtags' END AS upstream_hashtags
          FROM orders x
          WHERE x.order_number = f.order_number AND x.group_buy_id = inp.gb
        ) ord ON true
      ), labels AS (
        SELECT f.id AS failure_id, m[1] AS pre, m[2] AS suf
        FROM f, LATERAL regexp_matches(f.message, 'tx ([0-9A-Za-z]{10})…([0-9A-Za-z]{6})', 'g') AS m
      )
      SELECT f.id, f.order_number, f.message, f.seen_count, f.first_seen_at, f.last_seen_at,
             -- every open failure in the campaign, whatever the focus/cap, so
             -- the caller can say when the listed set is a subset
             (SELECT count(*) FROM import_failures a, inp
               WHERE a.group_buy_id = inp.gb AND a.resolved_at IS NULL) AS open_total,
             (SELECT jsonb_agg(jsonb_build_object('resolved_at', h.resolved_at, 'note', h.resolution) ORDER BY h.resolved_at)
                FROM import_failures h, inp
               WHERE h.group_buy_id = inp.gb AND h.order_number = f.order_number
                 AND h.resolved_at IS NOT NULL AND COALESCE(h.resolution, '') NOT LIKE 'auto:%') AS resolved_by_hand,
             CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
               'status', o.status, 'source', o.source, 'payment_rail', o.payment_rail, 'total_usd', o.total_usd,
               'admin_note', o.admin_note,
               'recon_status', r.recon_status, 'due_usd', r.due_usd, 'effective_received_usd', r.effective_received_usd,
               'diff_usd', r.diff_usd, 'pending_payment_count', r.pending_payment_count) END AS local_order,
             (SELECT jsonb_agg(jsonb_build_object('method', p.method, 'tx_hash', p.tx_hash, 'receipt_ref', p.receipt_ref,
                       'status', p.status, 'amount_usd', p.amount_usd, 'verified_at', p.verified_at, 'notes', p.notes) ORDER BY p.id)
                FROM payments p WHERE p.order_id = o.id) AS local_payments,
             (SELECT jsonb_agg(btrim(t)) FROM regexp_split_to_table(o.upstream_hashtags, '\\|') t WHERE btrim(t) <> '') AS upstream_refs,
             (SELECT jsonb_agg(jsonb_build_object(
                       'tx_hash', p.tx_hash, 'held_by_order', ho.order_number, 'held_by_campaign', g.name,
                       'is_this_order', p.order_id = o.id,
                       'same_customer', ho.customer_id IS NOT DISTINCT FROM o.customer_id,
                       'holder_placed_at', ho.placed_at,
                       'payment_status', p.status, 'payment_amount_usd', p.amount_usd, 'payment_verified_at', p.verified_at,
                       'payment_notes', p.notes,
                       'holder_recon_status', hr.recon_status, 'holder_due_usd', hr.due_usd,
                       'holder_effective_received_usd', hr.effective_received_usd, 'holder_diff_usd', hr.diff_usd) ORDER BY p.id)
                FROM labels l
                JOIN payments p ON p.tx_hash IS NOT NULL
                 AND CASE WHEN l.pre ~* '^0x'
                          THEN lower(left(p.tx_hash, 10)) = lower(l.pre) AND lower(right(p.tx_hash, 6)) = lower(l.suf)
                          ELSE left(p.tx_hash, 10) = l.pre AND right(p.tx_hash, 6) = l.suf END
                JOIN orders ho ON ho.id = p.order_id
                JOIN group_buys g ON g.id = ho.group_buy_id
                LEFT JOIN v_order_reconciliation hr ON hr.order_id = ho.id
               WHERE l.failure_id = f.id) AS hash_holders
      FROM f
      JOIN o ON o.failure_id = f.id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      ORDER BY f.first_seen_at
    `,
  });
}

export default listImportFailureContext;
