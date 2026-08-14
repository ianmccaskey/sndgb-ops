/**
 * Maps ordering-app (base44) Order records onto the same ParsedOrder shape the
 * paste parser produces, so the Import page's validation, preview, and
 * idempotent upsert flow is shared between both sources.
 *
 * Item SKU resolution: base44 items carry product_id + product_name. The
 * catalog stores base44 ids in products.external_id (populated by the product
 * sync), so ids resolve to curated SKUs first and the name is only a fallback.
 */

import { B44Order } from '@/lib/base44';
import {
  ParsedOrder, ParsedItem, ParseResult,
  mapPaymentRail, normalizeState, normalizeZip, parseHashBlob,
} from '@/lib/parseOrderImport';

/**
 * Ordering-app statuses that must never become active local orders — the
 * local upsert always writes status 'imported', and every downstream number
 * (revenue, vendor demand, fulfillment) assumes imported orders are real.
 * They aren't dropped: they surface as cancellations so an order that was
 * imported while valid gets its local status corrected (the views exclude
 * cancelled/refunded orders, so demand and revenue self-heal).
 */
const NON_IMPORTABLE_STATUS = /cancel|refund|reject|void|denied/i;

// Any other status ('pending', 'verified', 'shipped', …) imports normally.
// Whether an order represents real money is decided by the on-chain payment
// reconciliation, NOT by this status field, so we deliberately do not gate
// imports on an allowlist of statuses — that only skips legitimate orders
// whenever the ordering app uses a status we didn't predict. Terminal-bad
// statuses (above) are the sole exception and reconcile as cancellations.

export type B44Cancellation = {
  orderNumber: string;
  /** Local order_status to apply. */
  status: 'cancelled' | 'refunded';
  sourceStatus: string;
};

export type MappedOrders = ParseResult & { cancellations: B44Cancellation[] };

function mapOne(o: B44Order, index: number, skuByExternalId: Map<string, string>, errors: ParseResult['errors']): ParsedOrder | null {
  const orderNumber = String(o.order_number || '').trim();
  if (!orderNumber) {
    errors.push({ line: index + 1, text: o.id, reason: 'Missing order number' });
    return null;
  }
  const customerName = String(o.customer_name || '').replace(/\s+/g, ' ').trim();
  if (!customerName) {
    errors.push({ line: index + 1, text: orderNumber, reason: 'Missing customer name' });
    return null;
  }
  const status = String(o.status || '').trim();
  if (!o.items || o.items.length === 0) {
    errors.push({ line: index + 1, text: orderNumber, reason: 'No line items — skipped (importing would erase any existing items for this order)' });
    return null;
  }

  const items: ParsedItem[] = [];
  for (const it of o.items ?? []) {
    const qty = Number(it.quantity ?? 0);
    const pid = String(it.product_id || '').trim();
    let sku: string;
    if (pid) {
      // An id the catalog doesn't know is an identity failure, not a excuse to
      // guess by name — a renamed/stale product could bind to the wrong SKU.
      const mapped = skuByExternalId.get(pid);
      if (!mapped) {
        errors.push({ line: index + 1, text: orderNumber, reason: `Product not synced: '${it.product_name || pid}' (ordering-app id ${pid}) — pull products on the Products → Ordering app tab first` });
        return null;
      }
      sku = mapped;
    } else {
      sku = String(it.product_name || '').trim();
    }
    if (!sku || !Number.isFinite(qty) || qty <= 0) {
      errors.push({ line: index + 1, text: orderNumber, reason: `Unusable item (${it.product_name || pid || '?'} × ${it.quantity ?? '?'})` });
      return null;
    }
    // qty is stored as NUMERIC(10,2) — reject finer fractions instead of
    // silently rounding them into demand/revenue math. Checked on the source
    // value's decimal string, not qty*100 arithmetic: binary floats make
    // 1.15*100 !== 115, which would reject perfectly valid cent-scale values.
    if (!/^\d+(?:\.\d{1,2})?$/.test(String(it.quantity ?? ''))) {
      errors.push({ line: index + 1, text: orderNumber, reason: `Quantity ${it.quantity} for '${it.product_name || pid}' has more than 2 decimal places — cannot store exactly` });
      return null;
    }
    const directShip = it.wants_direct_ship === true;
    // Duplicate-SKU lines get merged into ONE order_items row downstream, so
    // a SKU that is direct-shipped on one line and packed-by-us on another is
    // unrepresentable — refuse loudly rather than silently converting local
    // units into vendor-direct units (which would drop them from the pack
    // queue). Fix the routing in the ordering app and re-pull.
    const clash = items.find(prev => prev.sku === sku && prev.directShip !== directShip);
    if (clash) {
      errors.push({ line: index + 1, text: orderNumber, reason: `'${sku}' appears both direct-shipped and packed-by-us on this order — one SKU can only ship one way; fix it in the ordering app and re-pull` });
      return null;
    }
    items.push({ sku, qty, directShip });
  }

  const { payments } = parseHashBlob(o.transaction_hashtags);
  const placedMs = o.created_date ? Date.parse(o.created_date) : NaN;

  return {
    orderNumber,
    externalId: o.id,
    customerName,
    status: status || null,
    email: String(o.customer_email || '').toLowerCase() || null,
    phone: String(o.customer_phone || '').trim() || null,
    discord: String(o.discord_username || '').trim() || null,
    groupBuyName: null,
    paymentRail: mapPaymentRail(o.payment_method),
    addressLine1: String(o.shipping_address_line1 || '').trim() || null,
    addressLine2: String(o.shipping_address_line2 || '').trim() || null,
    city: String(o.shipping_city || '').trim() || null,
    stateCode: normalizeState(o.shipping_state),
    postalCode: normalizeZip(o.shipping_zip_code),
    subtotal: Number(o.subtotal ?? 0),
    tip: Number(o.tip ?? 0),
    adminFee: Number(o.admin_fee ?? 0),
    shippingFee: Number(o.shipping_fee ?? 0),
    shippingInsurance: Number(o.shipping_insurance_fee ?? 0),
    total: Number(o.total ?? 0),
    placedAt: isNaN(placedMs) ? null : new Date(placedMs).toISOString(),
    items,
    payments,
    customerNote: String(o.customer_notes || '') || null,
    adminNote: String(o.notes || '') || null,
    receivedAmount: null,
    raw: { source: 'base44', b44_id: o.id, json: JSON.stringify(o) },
  };
}

export function mapB44Orders(orders: B44Order[], skuByExternalId: Map<string, string>): MappedOrders {
  const result: MappedOrders = { orders: [], errors: [], cancellations: [] };
  orders.forEach((o, i) => {
    const sourceStatus = String(o.status || '').trim();
    if (NON_IMPORTABLE_STATUS.test(sourceStatus)) {
      const orderNumber = String(o.order_number || '').trim();
      if (!orderNumber) {
        result.errors.push({ line: i + 1, text: o.id, reason: `Status '${sourceStatus}' without an order number — cannot reconcile` });
      } else {
        result.cancellations.push({
          orderNumber,
          status: /refund/i.test(sourceStatus) ? 'refunded' : 'cancelled',
          sourceStatus,
        });
      }
      return;
    }
    const mapped = mapOne(o, i, skuByExternalId, result.errors);
    if (mapped) result.orders.push(mapped);
  });
  return result;
}
