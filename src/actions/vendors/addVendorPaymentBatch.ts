import { action } from '@uibakery/data';

/**
 * Record ONE vendor payment as a batch (1790102100): its product lines,
 * an optional freight portion, and the SENDS that carried the money — one
 * per on-chain transfer, each from its own wallet, so a payment made as
 * "$20,000 on SOL + $13,025 on ETH" is one record whose kits stay whole
 * per product while the rail cards see each wallet's own outflow.
 *
 * All or nothing: the batch, every line, the freight row and every send
 * insert together, or nothing inserts and the result row says why
 * (`refused`, one entry per problem). The caller never has to re-record
 * half a payment.
 *
 * The work is record_vendor_payment_batch() (1790102200), a plpgsql
 * function, because the per-vendor+campaign advisory lock (42002) must be
 * a statement of its OWN: a lock taken inside the statement that reads
 * kits/freight remaining does not refresh that statement's snapshot, so
 * a second recorder that waited on the lock could still pass the figure
 * the first one just consumed. Inside the function every statement takes
 * a fresh snapshot (Codex review, 2026-10-26).
 *
 * params.lines  jsonb [{group_buy_product_id, kits_qty, amount_usd,
 *                       allow_over, confirmed_owed}]
 * params.sends  jsonb [{wallet_id, amount_usd, method, tx_ref}]
 * params.freight_usd / allow_over_freight / confirmed_freight_owed as in
 * the single-row recorder this replaces.
 *
 * Guards (in the function):
 *  - a line's product must be THIS vendor's in THIS campaign; one line per
 *    product; positive whole-or-2dp kits and a positive $ value;
 *  - kits beyond what the product is still owed refuse unless the operator
 *    confirmed the over-buy AGAINST the owed figure sent with the line
 *    (confirmed_owed); if owed shrank meanwhile the confirmation is stale
 *    and refuses rather than widening the over-buy silently;
 *  - freight beyond the vendor's remaining freight refuses the same way
 *    (allow_over_freight + confirmed_freight_owed), and freight is never
 *    more than the batch total;
 *  - every send names an ACTIVE wallet and a positive 2dp amount;
 *  - the sends total EQUALS the lines total + freight, to the cent (the
 *    deferred DB trigger re-checks this at commit for every writer).
 *
 * Audited per line (`insert` on vendor_payments, same shape as before plus
 * batch_id) and once per batch (`vendor_payment_batch_recorded` with every
 * line, send and override).
 */
function addVendorPaymentBatch() {
  return action('addVendorPaymentBatch', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT r.batch_id, r.refused
      FROM record_vendor_payment_batch(
        {{params.vendor_id}}::text,
        {{params.group_buy_id}}::text,
        {{params.paid_on}}::text,
        {{params.note}}::text,
        {{params.lines}}::text,
        {{params.freight_usd}}::text,
        {{params.allow_over_freight}}::text,
        {{params.confirmed_freight_owed}}::text,
        {{params.sends}}::text,
        {{params.actor}}::text
      ) r
    `,
  });
}

export default addVendorPaymentBatch;
