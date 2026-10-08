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
  items: { sku: string | null; qty: string | number; direct_ship: boolean; name: string | null; unit_price_usd?: string | number | null; split_fee_usd?: string | number | null }[] | string;
  payments: { rail: string; method: string; tx_hash: string | null; receipt_ref: string | null; status: string; verified_usd: string | null; verify_error?: string | null }[] | string;
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
    // the member's order-time prices travel with the line so a later campaign
    // price or split-fee edit never rewrites what they were charged
    const unitPriceUsd = Number(it.unit_price_usd);
    const splitFeeUsd = Number(it.split_fee_usd);
    items.push({
      sku, qty, directShip: !!it.direct_ship,
      unitPriceUsd: Number.isFinite(unitPriceUsd) && it.unit_price_usd != null ? unitPriceUsd : undefined,
      splitFeeUsd: Number.isFinite(splitFeeUsd) && it.split_fee_usd != null ? splitFeeUsd : undefined,
    });
  }
  if (items.length === 0) {
    errors.push({ line: index + 1, text: orderNumber, reason: 'No line items — skipped (importing would erase any existing items for this order)' });
    return null;
  }

  // Each claim carries its own rail/method (a member may have paid on a rail
  // other than the order's — a corrected claim, a NEAR settlement): it is
  // imported on THAT network, never the order header's. A hash that does not
  // fit its rail is an identity failure, not something to guess at.
  const payments: ParsedPayment[] = [];
  // claims the storefront has since REJECTED (failed on-chain, wrong wallet,
  // never found): not evidence — and a local payment imported while the
  // claim was still pending must be rejected here too, or it keeps the
  // hash slot and blocks reconciliation. Travels as raw.rejected_claims.
  const rejected: { hash: string; reason: string }[] = [];
  for (const p of json(r.payments)) {
    const rail = String(p.rail || '');
    const method = String(p.method || '');
    if (p.status === 'rejected') {
      if (p.tx_hash) rejected.push({ hash: String(p.tx_hash).trim(), reason: String(p.verify_error || 'rejected by the storefront') });
      continue;
    }
    if (p.tx_hash) {
      const hash = String(p.tx_hash).trim();
      const fits = rail === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash) : (rail === 'eth' || rail === 'base') && /^0x[0-9a-fA-F]{64}$/.test(hash);
      if (!fits) {
        errors.push({ line: index + 1, text: orderNumber, reason: `Payment claim ${hash.slice(0, 12)}… does not fit its rail '${rail || '?'}'` });
        return null;
      }
      payments.push({ kind: 'tx_hash', value: hash, method: rail as ParsedPayment['method'] });
    } else if (p.receipt_ref) {
      const m = (['zelle', 'venmo', 'paypal'].includes(method) ? method : 'other') as ParsedPayment['method'];
      payments.push({ kind: 'receipt', value: String(p.receipt_ref).trim(), method: m });
    }
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
      ...(rejected.length > 0 ? { rejected_claims: JSON.stringify(rejected) } : {}),
    },
  };
}

export function mapStorefrontOrders(rowsIn: StorefrontOrderRow[]): MappedOrders {
  const result: MappedOrders = { orders: [], errors: [], cancellations: [] };
  rowsIn.forEach((r, i) => {
    if (r.status === 'cancelled') {
      const orderNumber = String(r.order_number || '').trim();
      if (orderNumber) {
        const c: B44Cancellation = { orderNumber, status: 'cancelled', sourceStatus: r.cancel_reason ? `cancelled — ${r.cancel_reason}` : 'cancelled', source: 'storefront' };
        result.cancellations.push(c);
      }
      return;
    }
    const mapped = mapOne(r, i, result.errors);
    if (mapped) result.orders.push(mapped);
  });

  // The storefront lets two orders claim one tx hash (a shared wallet gives
  // neither member proof); this app holds a hash on ONE order and skips the
  // rest at import. Make the duplicate visible: in the preview, and on each
  // involved order as an admin-note line the runner writes.
  const byHash = new Map<string, string[]>();
  const canon = (h: string) => (/^0x[0-9a-fA-F]{64}$/.test(h) ? h.toLowerCase() : h);
  for (const o of result.orders) {
    for (const p of o.payments) {
      if (p.kind !== 'tx_hash') continue;
      byHash.set(canon(p.value), [...(byHash.get(canon(p.value)) || []), o.orderNumber]);
    }
  }
  // A CANCELLED storefront order's live claims count too: an earlier import
  // may have landed its hash here, where it blocks the live claimant while
  // sitting on an order the views exclude. Name it, marked, so the conflict
  // is seen from the live order.
  for (const r of rowsIn) {
    if (r.status !== 'cancelled') continue;
    const num = String(r.order_number || '').trim();
    for (const p of json(r.payments)) {
      if (!p.tx_hash || p.status === 'rejected') continue;
      const key = canon(String(p.tx_hash).trim());
      byHash.set(key, [...(byHash.get(key) || []), `${num} (cancelled)`]);
    }
  }
  // only conflicts that touch at least one LIVE order matter (two cancelled
  // orders sharing a hash is history, not a reconciliation problem)
  const conflicts = [...byHash.entries()]
    .filter(([, nums]) => nums.length > 1 && nums.some(n => !n.endsWith('(cancelled)')))
    .map(([txHash, orderNumbers]) => ({ txHash, orderNumbers }));
  if (conflicts.length > 0) {
    result.conflicts = conflicts;
    for (const o of result.orders) {
      const mine = conflicts.filter(c => c.orderNumbers.includes(o.orderNumber)).map(c => ({ txHash: c.txHash, others: c.orderNumbers.filter(n => n !== o.orderNumber) }));
      if (mine.length > 0) o.raw.claim_conflicts = JSON.stringify(mine);
    }
  }
  return result;
}
