/**
 * Parser for order exports pasted from the external ordering app (the same
 * 27-column layout the old Google Sheet's Orders tab used). Accepts
 * tab-separated rows with or without a header line; when a header is present
 * columns are matched by name so column reordering can't silently shift data.
 *
 * Everything messy in the old sheet is handled here, once:
 *  - `Items` blobs like "R20 (2); MOTS-C 40 (1); JM'S Pep Tin-RED (1)"
 *  - pipe-delimited transaction hashes mixed with PayPal/Venmo receipt ids
 *  - free-text states ("Ca", "Texas") normalized to 2-letter codes
 *  - zip codes that lost their leading zeros
 * Rows that can't be parsed are returned as errors, never silently dropped.
 */

import { parseMoney } from '@/lib/fmt';

export type ParsedItem = { sku: string; qty: number };

export type ParsedPayment = {
  /** 'eth' | 'sol' | 'base' rail hashes, or a receipt reference for P2P rails */
  kind: 'tx_hash' | 'receipt';
  value: string;
};

export type ParsedOrder = {
  orderNumber: string;
  externalId: string | null;
  customerName: string;
  email: string | null;
  phone: string | null;
  discord: string | null;
  groupBuyName: string | null;
  status: string | null;
  paymentRail: 'eth' | 'sol' | 'base' | 'cash';
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  subtotal: number;
  tip: number;
  adminFee: number;
  shippingFee: number;
  total: number;
  placedAt: string | null; // ISO
  items: ParsedItem[];
  payments: ParsedPayment[];
  customerNote: string | null;
  adminNote: string | null;
  receivedAmount: number | null;
  raw: Record<string, string>;
};

export type ParseResult = {
  orders: ParsedOrder[];
  errors: { line: number; text: string; reason: string }[];
};

const STATE_MAP: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'puerto rico': 'PR',
};

export function normalizeState(raw: string | null | undefined): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_MAP[s.toLowerCase()] || s.toUpperCase();
}

export function normalizeZip(raw: string | null | undefined): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  // Purely numeric zips that lost leading zeros in the sheet ("3825" → "03825")
  if (/^\d{3,4}$/.test(s)) return s.padStart(5, '0');
  return s;
}

export function mapPaymentRail(method: string | null | undefined): 'eth' | 'sol' | 'base' | 'cash' {
  const m = (method || '').toLowerCase();
  if (m.includes('base')) return 'base';
  if (m.includes('sol')) return 'sol';
  if (m.includes('eth')) return 'eth';
  return 'cash'; // 'not_available_', blank, Zelle/Venmo/PayPal
}

/** "R20 (2); MOTS-C 40 (1); JM'S Pep Tin-RED (1)" → [{sku, qty}] */
export function parseItemsBlob(blob: string | null | undefined): { items: ParsedItem[]; bad: string[] } {
  const items: ParsedItem[] = [];
  const bad: string[] = [];
  for (const part of String(blob || '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(.*?)\s*\((\d+)\)$/);
    if (m && m[1].trim()) items.push({ sku: m[1].trim(), qty: parseInt(m[2], 10) });
    else bad.push(p);
  }
  return { items, bad };
}

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/; // base58 signature
const EXPLORER = /(?:solscan\.io\/tx\/|etherscan\.io\/tx\/|basescan\.org\/tx\/)([0-9a-zA-Zx]+)/;

/** Pipe-delimited hash blob → typed payment references; junk is dropped with a note. */
export function parseHashBlob(blob: string | null | undefined): { payments: ParsedPayment[]; junk: string[] } {
  const payments: ParsedPayment[] = [];
  const junk: string[] = [];
  for (const part of String(blob || '').split('|')) {
    let p = part.trim();
    if (!p) continue;
    const ex = p.match(EXPLORER);
    if (ex) p = ex[1];
    if (EVM_HASH.test(p) || SOL_SIG.test(p)) payments.push({ kind: 'tx_hash', value: p });
    else if (/^[A-Z0-9-]{8,30}$/i.test(p) && /\d/.test(p)) payments.push({ kind: 'receipt', value: p });
    else junk.push(p);
  }
  return { payments, junk };
}

/** Canonical column order when no header row is supplied. */
const CANONICAL_COLUMNS = [
  'order #', 'order id', 'customer', 'email', 'phone', 'discord username', 'group buy',
  'status', 'payment method', 'address line 1', 'address line 2', 'city', 'state', 'zip',
  'total items', 'subtotal', 'tip', 'admin fee', 'shipping fee', 'total', 'date', 'items',
  'transaction hashes', 'customer notes', 'notes', 'linked orders', 'received amount',
];

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[\\#]/g, '#').replace(/\s+/g, ' ').trim();
}

export function parseOrderPaste(text: string): ParseResult {
  const result: ParseResult = { orders: [], errors: [] };
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return result;

  let columns = CANONICAL_COLUMNS;
  let start = 0;
  const firstCells = lines[0].split('\t').map(normHeader);
  if (firstCells.some(c => c === 'order #' || c === 'order id' || c === 'customer')) {
    columns = firstCells;
    start = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => { row[col] = (cells[idx] ?? '').trim(); });

    const orderNumber = row['order #'] || '';
    if (!orderNumber) {
      result.errors.push({ line: i + 1, text: lines[i].slice(0, 120), reason: 'Missing order number' });
      continue;
    }
    const customerName = row['customer'] || '';
    if (!customerName) {
      result.errors.push({ line: i + 1, text: lines[i].slice(0, 120), reason: 'Missing customer name' });
      continue;
    }

    const { items, bad } = parseItemsBlob(row['items']);
    if (bad.length > 0) {
      result.errors.push({ line: i + 1, text: lines[i].slice(0, 120), reason: `Unparseable item(s): ${bad.join(', ')}` });
      continue;
    }
    const { payments } = parseHashBlob(row['transaction hashes']);

    const placedRaw = row['date'] || '';
    const placedMs = placedRaw ? Date.parse(placedRaw) : NaN;

    const received = row['received amount'] ? parseMoney(row['received amount']) : null;

    result.orders.push({
      orderNumber,
      externalId: row['order id'] || null,
      customerName: customerName.replace(/\s+/g, ' ').trim(),
      email: (row['email'] || '').toLowerCase() || null,
      phone: row['phone'] || null,
      discord: (row['discord username'] || '').trim() || null,
      groupBuyName: row['group buy'] || null,
      status: row['status'] || null,
      paymentRail: mapPaymentRail(row['payment method']),
      addressLine1: row['address line 1'] || null,
      addressLine2: row['address line 2'] || null,
      city: (row['city'] || '').trim() || null,
      stateCode: normalizeState(row['state']),
      postalCode: normalizeZip(row['zip']),
      subtotal: parseMoney(row['subtotal']),
      tip: parseMoney(row['tip']),
      adminFee: parseMoney(row['admin fee']),
      shippingFee: parseMoney(row['shipping fee']),
      total: parseMoney(row['total']),
      placedAt: isNaN(placedMs) ? null : new Date(placedMs).toISOString(),
      items,
      payments,
      customerNote: row['customer notes'] || null,
      adminNote: row['notes'] || null,
      receivedAmount: received,
      raw: row,
    });
  }
  return result;
}
