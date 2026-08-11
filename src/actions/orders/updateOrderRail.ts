import { action } from '@uibakery/data';

/**
 * Correct an order's payment rail — the "customer selected ETH at checkout
 * but actually paid on Solana" case, after the payment itself was re-opened
 * and verified on the real network. Rail change, admin-note line, and audit
 * row are one statement. Guards (all return no rows when violated):
 *  - eth/sol ONLY — the networks the ordering app can represent (usdc_sol /
 *    paige-usdc-eth). This is enforced HERE, not just in the UI: a local
 *    rail without an upstream counterpart (base today) would be silently
 *    reverted by the next import, so the write primitive refuses to create
 *    that state for any caller;
 *  - the current rail must still equal what the operator was looking at
 *    (expected_rail) — a concurrent import/edit invalidates the click;
 *  - the evidence is re-checked IN the transaction: the order's verified
 *    tx-hash payments must sit on exactly one network and it must be the
 *    requested target — the UI's premise, proven at write time.
 *
 * Divergence recovery: if the upstream PUT landed but this refuses (stale
 * click), the next import converges local state — importUpsertOrder sets
 * payment_rail from the source's payment_method on every re-import.
 */
function updateOrderRail() {
  return action('updateOrderRail', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE orders SET
          payment_rail = {{params.rail}}::payment_rail,
          admin_note = CASE
            WHEN admin_note IS NULL OR admin_note = '' THEN {{params.note}}
            ELSE admin_note || E'\\n' || {{params.note}}
          END
        WHERE id = {{params.order_id}}::bigint
          AND {{params.rail}} IN ('eth','sol')
          AND payment_rail = {{params.expected_rail}}::payment_rail
          AND payment_rail IS DISTINCT FROM {{params.rail}}::payment_rail
          AND (SELECT COUNT(DISTINCT p.method) FROM payments p
               WHERE p.order_id = {{params.order_id}}::bigint
                 AND p.status = 'verified' AND p.tx_hash IS NOT NULL AND p.tx_hash <> '') = 1
          AND (SELECT MIN(p.method::text) FROM payments p
               WHERE p.order_id = {{params.order_id}}::bigint
                 AND p.status = 'verified' AND p.tx_hash IS NOT NULL AND p.tx_hash <> '') = {{params.rail}}
        RETURNING id, payment_rail, admin_note
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'orders', upd.id::text, 'payment_rail_corrected', {{params.actor}},
               jsonb_build_object('new_rail', upd.payment_rail, 'note', {{params.note}})
        FROM upd
        RETURNING row_pk
      )
      SELECT id, payment_rail, admin_note FROM upd
    `,
  });
}

export default updateOrderRail;
