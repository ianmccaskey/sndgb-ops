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

  const items: ParsedItem[] = [];
  for (const it of o.items ?? []) {
    const qty = Number(it.quantity ?? 0);
    const sku = (it.product_id && skuByExternalId.get(it.product_id)) || String(it.product_name || '').trim();
    if (!sku || !Number.isFinite(qty) || qty <= 0) {
      errors.push({ line: index + 1, text: orderNumber, reason: `Unusable item (${it.product_name || it.product_id || '?'} × ${it.quantity ?? '?'})` });
      return null;
    }
    items.push({ sku, qty });
  }

  const { payments } = parseHashBlob(o.transaction_hashtags);
  const placedMs = o.created_date ? Date.parse(o.created_date) : NaN;

  return {
    orderNumber,
    externalId: o.id,
    customerName,
    email: String(o.customer_email || '').toLowerCase() || null,
    phone: String(o.customer_phone || '').trim() || null,
    discord: String(o.discord_username || '').trim() || null,
    groupBuyName: null,
    status: String(o.status || '') || null,
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

export function mapB44Orders(orders: B44Order[], skuByExternalId: Map<string, string>): ParseResult {
  const result: ParseResult = { orders: [], errors: [] };
  orders.forEach((o, i) => {
    const mapped = mapOne(o, i, skuByExternalId, result.errors);
    if (mapped) result.orders.push(mapped);
  });
  return result;
}
