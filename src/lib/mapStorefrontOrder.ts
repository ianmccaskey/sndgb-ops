/**
 * Storefront orders (p2collective.app, schema `storefront`) → ParsedOrder,
 * the same shape the ordering-app pull and the paste importer produce, so
 * importUpsertOrder / items / payments / cancellations all run unchanged.
 *
 * Differences from the base44 mapper, all deliberate:
 *  - no external id: storefront orders are ours, so every base44-only
 *    control (push changes, rail push, deleted-upstream diff) stays hidden
 *    by the existing `external_id` gates;
 *  - money comes split out already (the storefront prices in integer cents
 *    with the same rules this app uses), so the cash processor gross-up is
 *    passed explicitly instead of being derived from the total residual;
 *  - split-kit fees are NOT folded into the subtotal: this app snapshots
 *    them per line from group_buy_products.split_fee_usd at import, exactly
 *    as it does for base44 orders whose totals also carry the fee;
 *  - a cancelled storefront order arrives as a cancellation (status
 *    'cancelled'), never as an importable order.
 */
import type { ParsedItem, ParsedOrder, ParsedPayment, ParseResult } from '@/lib/parseOrderImport';
import type { B44Cancellation, MappedOrders } from '@/lib/mapB44Order';

export type StorefrontOrderRow = {
  id: number | string;
  order_number: string;
  status: 'unpaid' | 'payment_submitted' | 'paid' | 'cancelled' | string;
  payment_rail: 'eth' | 'sol' | 'base' | 'cash' | string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  telegram_username: string | null;
  discord_username: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_code: string | null;
  postal_code: string | null;
  subtotal_usd: string;
  split_fees_usd: string;
  admin_fee_usd: string;
  shipping_fee_usd: string;
  insurance_usd: string;
  tip_usd: string;
  processor_fee_usd: string;
  total_usd: string;
  placed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  customer_note: string | null;
  updated_at: string | null;
  items: { sku: string | null; qty: string | number; direct_ship: boolean; name: string | null }[] | string;
  payments: { rail: string; method: string; tx_hash: string | null; receipt_ref: string | null; status: string; verified_usd: string | null }[] | string;
};

const RAILS = new Set(['eth', 'sol', 'base', 'cash']);

function json<T>(v: T[] | string): T[] {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v) as T[]; } catch { return []; }
}

function mapOne(r: StorefrontOrderRow, index: number, errors: ParseResult['errors']): ParsedOrder | null {
  const orderNumber = String(r.order_number || '').trim();
  if (!orderNumber) {
    errors.push({ line: index + 1, text: String(r.id), reason: 'Missing order number' });
    return null;
  }
  const customerName = String(r.contact_name || '').replace(/\s+/g, ' ').trim();
  if (!customerName) {
    errors.push({ line: index + 1, text: orderNumber, reason: 'Missing customer name' });
    return null;
  }
  if (!RAILS.has(r.payment_rail)) {
    errors.push({ line: index + 1, text: orderNumber, reason: `Unknown payment rail '${r.payment_rail}'` });
    return null;
  }

  const items: ParsedItem[] = [];
  for (const it of json(r.items)) {
    const sku = String(it.sku || '').trim();
    const qtyText = String(it.qty ?? '');
    const qty = Number(qtyText);
    if (!sku) {
      errors.push({ line: index + 1, text: orderNumber, reason: `Line '${it.name || '?'}' has no catalog SKU — the campaign product is missing its product row` });
      return null;
    }
    if (!Number.isFinite(qty) || qty <= 0 || !/^\d+(?:\.\d{1,2})?$/.test(qtyText)) {
      errors.push({ line: index + 1, text: orderNumber, reason: `Unusable quantity ${qtyText} for '${sku}'` });
      return null;
    }
    items.push({ sku, qty, directShip: !!it.direct_ship });
  }
  if (items.length === 0) {
    errors.push({ line: index + 1, text: orderNumber, reason: 'No line items — skipped (importing would erase any existing items for this order)' });
    return null;
  }

  const payments: ParsedPayment[] = [];
  for (const p of json(r.payments)) {
    if (p.tx_hash) payments.push({ kind: 'tx_hash', value: String(p.tx_hash).trim() });
    else if (p.receipt_ref) payments.push({ kind: 'receipt', value: String(p.receipt_ref).trim() });
  }

  const placedMs = r.placed_at ? Date.parse(r.placed_at) : NaN;
  const n = (v: string | null | undefined) => Number(v ?? 0) || 0;

  return {
    orderNumber,
    externalId: null,
    customerName,
    status: r.status || null,
    email: String(r.contact_email || '').toLowerCase() || null,
    phone: String(r.contact_phone || '').trim() || null,
    discord: String(r.discord_username || '').trim() || null,
    groupBuyName: null,
    paymentRail: r.payment_rail as ParsedOrder['paymentRail'],
    addressLine1: String(r.address_line1 || '').trim() || null,
    addressLine2: String(r.address_line2 || '').trim() || null,
    city: String(r.city || '').trim() || null,
    stateCode: String(r.state_code || '').trim().toUpperCase() || null,
    postalCode: String(r.postal_code || '').trim() || null,
    subtotal: n(r.subtotal_usd),
    tip: n(r.tip_usd),
    adminFee: n(r.admin_fee_usd),
    shippingFee: n(r.shipping_fee_usd),
    shippingInsurance: n(r.insurance_usd),
    processorFee: n(r.processor_fee_usd),
    total: n(r.total_usd),
    placedAt: isNaN(placedMs) ? null : new Date(placedMs).toISOString(),
    items,
    payments,
    customerNote: String(r.customer_note || '') || null,
    adminNote: null,
    receivedAmount: null,
    raw: {
      source: 'storefront',
      storefront_order_id: String(r.id),
      storefront_status: String(r.status || ''),
      telegram_username: String(r.telegram_username || ''),
      split_fees_usd: String(r.split_fees_usd ?? ''),
      updated_at: String(r.updated_at || ''),
    },
  };
}

export function mapStorefrontOrders(rowsIn: StorefrontOrderRow[]): MappedOrders {
  const result: MappedOrders = { orders: [], errors: [], cancellations: [] };
  rowsIn.forEach((r, i) => {
    if (r.status === 'cancelled') {
      const orderNumber = String(r.order_number || '').trim();
      if (orderNumber) {
        const c: B44Cancellation = { orderNumber, status: 'cancelled', sourceStatus: r.cancel_reason ? `cancelled — ${r.cancel_reason}` : 'cancelled' };
        result.cancellations.push(c);
      }
      return;
    }
    const mapped = mapOne(r, i, result.errors);
    if (mapped) result.orders.push(mapped);
  });
  return result;
}
