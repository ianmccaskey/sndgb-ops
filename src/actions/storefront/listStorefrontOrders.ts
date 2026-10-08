import { action } from '@uibakery/data';

/**
 * Every storefront order for a campaign (the P² Collective app writes
 * storefront.orders; this app imports them through the same ParsedOrder →
 * importUpsertOrder pipeline base44 orders use). One row per order with its
 * lines (SKU resolved through group_buy_products → products) and its live
 * payment claims as JSON. Cancelled orders are included so the import can
 * apply the cancellation locally; rejected payment claims are not.
 */
function listStorefrontOrders() {
  return action('listStorefrontOrders', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id, o.order_number, o.status::text AS status, o.payment_rail::text AS payment_rail,
             o.contact_name, o.contact_email::text AS contact_email, o.contact_phone,
             o.telegram_username, o.discord_username,
             o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code,
             o.subtotal_usd, o.split_fees_usd, o.admin_fee_usd, o.shipping_fee_usd,
             o.insurance_usd, o.tip_usd, o.processor_fee_usd, o.total_usd,
             o.placed_at, o.cancelled_at, o.cancel_reason, o.customer_note, o.updated_at,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'sku', p.sku_code, 'qty', i.qty, 'direct_ship', i.direct_ship, 'name', i.product_name_snapshot)
                      ORDER BY i.id)
               FROM storefront.order_items i
               JOIN group_buy_products gbp ON gbp.id = i.group_buy_product_id
               JOIN products p ON p.id = gbp.product_id
               WHERE i.order_id = o.id
             ), '[]'::json) AS items,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'rail', pay.rail::text, 'method', pay.method::text, 'tx_hash', pay.tx_hash,
                        'receipt_ref', pay.receipt_ref, 'status', pay.status::text, 'verified_usd', pay.verified_usd)
                      ORDER BY pay.id)
               FROM storefront.payments pay
               WHERE pay.gb_order_id = o.id
                 -- claim states and what they mean for THIS app:
                 --   pending  — the storefront could not reach/index it yet: evidence to verify here
                 --   verified — confirmed transfer to our wallet covering the total
                 --   mismatch — confirmed transfer to our wallet, amount differs: real money,
                 --              recon must see the shortfall/overpayment
                 --   rejected — failed on-chain, paid someone else's wallet, or never found
                 --              in a week: NOT a payment, never imported
                 AND pay.status IN ('pending', 'verified', 'mismatch')
             ), '[]'::json) AS payments
      FROM storefront.orders o
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY o.placed_at, o.id
    `,
  });
}

export default listStorefrontOrders;
