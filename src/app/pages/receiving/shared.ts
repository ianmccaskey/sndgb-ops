/*
 * Shared types + display helpers for the Receiving page family — a
 * separate module (not the page file) so react-refresh stays happy and
 * every tab renders the same statuses and product colors.
 */

export type RxAddress = {
  id: number; label: string; name: string; street1: string; street2: string | null;
  city: string; state: string; zip: string; country: string;
  phone: string | null; email: string | null; active: boolean;
  // only listReceiveAddresses selects these; saved destinations reuse the
  // type and never carry them
  is_default_ship_from?: boolean;
  // the group ORIGIN this address's transfers ship from (null = itself)
  transfer_origin_id?: number | null;
};
export type PkgItem = { id: number; product_id: number; sku_code: string; name?: string; qty: string };
export type Pkg = {
  id: number; receive_address_id: number; address_label: string; address_active: boolean;
  vendor_code: string | null; carrier: string; tracking_number: string; note: string | null;
  committed_at: string | null; tracking_status: string | null; tracking_substatus: string | null;
  tracking_detail: string | null; tracking_error: string | null;
  tracking_location: { city?: string; state?: string } | null;
  eta: string | null; status_date: string | null; last_checked_at: string | null;
  received_at: string | null; received_by: string | null; auto_receive_suppressed: boolean;
  created_by: string; created_at: string;
  items: PkgItem[] | null;
  // set at the row boundary (ReceivingPage): the transport re-typed the
  // tracking number to a JS number past Number.MAX_SAFE_INTEGER, so the
  // exact DB text is unrecoverable client-side — refresh and correction
  // fail closed on it instead of acting on a rounded value
  tracking_mangled?: boolean;
};
export type InvRow = {
  receive_address_id: number; address_label: string; product_id: number;
  sku_code: string; product_name: string;
  received_qty: string; transferred_qty: string; on_hand_qty: string;
};
export type TransferRow = {
  id: number; from_address_id: number; from_label: string;
  // the received package this transfer parted out (provenance; null =
  // not recorded via the box picker)
  source_package_id: number | null;
  from_address: Record<string, string | null> | null;
  destination_label: string; destination: Record<string, string | null>;
  parcel: Record<string, string>; carrier: string | null; servicelevel: string | null;
  rate_amount: string | null; rate_currency: string | null;
  shippo_rate_id: string | null; shippo_transaction_id: string | null;
  tracking_number: string | null; label_url: string | null; refund_status: string | null;
  note: string | null; finalized_at: string | null; created_by: string; created_at: string;
  purchase_attempted_at: string | null;
  // direct-ship link state: the order line this transfer completes when
  // it finalizes, and whether an expired reservation was RECLAIMED by a
  // newer draft (a reclaimed draft can recover an already-bought label
  // but can never buy a new one — and any label it recovers is ORPHANED
  // from the order line)
  direct_order_item_id: number | null; direct_link_reclaimed_at: string | null;
  items: { product_id: number; sku_code: string; qty: string }[] | null;
};
export type CatalogProduct = { id: number; sku_code: string; name: string; mass_label: string | null; active: boolean };
// one outstanding vendor-direct order line + its order's ship-to — a
// candidate destination for shipping a box straight to the customer
export type DirectShipCandidate = {
  item_id: number; order_id: number; order_number: string; customer_name: string;
  contact_name: string | null; contact_phone: string | null; contact_email: string | null;
  address_line1: string; address_line2: string | null; city: string; state_code: string; postal_code: string;
  product_id: number; sku_code: string; qty: string;
};
export type VendorRow = { id: number; code: string; active: boolean; shippable: boolean };

// stable per-product chip colors — LITERAL class strings (Tailwind purge
// cannot see dynamic names); assignment by product id so a product keeps
// its color everywhere. Chips always carry SKU text — color is never the
// only signal.
const PRODUCT_CHIP_CLASSES = [
  'bg-emerald-100 text-emerald-900',
  'bg-sky-100 text-sky-900',
  'bg-violet-100 text-violet-900',
  'bg-amber-100 text-amber-900',
  'bg-rose-100 text-rose-900',
  'bg-indigo-100 text-indigo-900',
  'bg-teal-100 text-teal-900',
  'bg-orange-100 text-orange-900',
  'bg-fuchsia-100 text-fuchsia-900',
  'bg-lime-100 text-lime-900',
];
export const productChipClass = (productId: number) =>
  PRODUCT_CHIP_CLASSES[Math.abs(Number(productId)) % PRODUCT_CHIP_CLASSES.length];

export const TRACK_STYLES: Record<string, string> = {
  PRE_TRANSIT: 'bg-gray-100 text-gray-700',
  TRANSIT: 'bg-blue-100 text-blue-800',
  DELIVERED: 'bg-green-100 text-green-800',
  RETURNED: 'bg-red-100 text-red-800',
  FAILURE: 'bg-red-100 text-red-800',
  UNKNOWN: 'bg-gray-200 text-gray-600',
};

export function trackLabel(p: Pkg): string {
  if (!p.committed_at) return 'draft';
  if (!p.tracking_status && !p.last_checked_at) return 'not checked';
  if (!p.tracking_status) return 'no scans yet';
  if (p.tracking_substatus === 'out_for_delivery' && p.tracking_status !== 'DELIVERED') return 'OUT FOR DELIVERY';
  return p.tracking_status;
}
export function trackClass(p: Pkg): string {
  if (!p.committed_at || !p.tracking_status) return 'bg-gray-100 text-gray-600';
  if (p.tracking_substatus === 'out_for_delivery' && p.tracking_status !== 'DELIVERED') return 'bg-amber-100 text-amber-900';
  return TRACK_STYLES[p.tracking_status] || 'bg-gray-200 text-gray-600';
}

export function isOutForDeliveryToday(p: Pkg): boolean {
  if (p.received_at || p.tracking_substatus !== 'out_for_delivery' || p.tracking_status === 'DELIVERED') return false;
  if (!p.status_date) return false;
  // "today" in the BROWSER'S local timezone — an 8pm scan is not tomorrow
  const d = new Date(p.status_date);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
