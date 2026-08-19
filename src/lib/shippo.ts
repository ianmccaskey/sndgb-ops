import { fetchWithBackoff } from './http';

/*
 * Shippo client (browser-direct: api.goshippo.com serves ACAO * with the
 * authorization header allowed — verified). Key lives in app_settings as
 * shippo_api_key, entered by the operator in Settings.
 *
 * REAL-MONEY DISCIPLINE:
 *  - purchaseLabel and requestRefund use a SINGLE attempt (plain fetch,
 *    never fetchWithBackoff): a retried 5xx or dropped connection after
 *    Shippo already charged would buy a SECOND label — Shippo has no
 *    idempotency key. Rate creation and tracking are read-only-priced
 *    and retry freely.
 *  - a QUEUED/WAITING transaction is polled by GET (never re-POSTed).
 *  - test keys (shippo_test_...) return SIMULATED tracking — callers must
 *    check isTestKey() and suppress auto-receive so fake DELIVERED events
 *    can never move real inventory.
 */

const BASE = 'https://api.goshippo.com';

export function isTestKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith('shippo_test');
}

function headers(key: string): Record<string, string> {
  return { Authorization: `ShippoToken ${key.trim()}`, 'Content-Type': 'application/json' };
}

export type TrackResult = {
  status: string | null;        // PRE_TRANSIT | TRANSIT | DELIVERED | RETURNED | FAILURE | UNKNOWN | null (no scans yet)
  substatus: string | null;     // substatus.code, e.g. out_for_delivery
  detail: string | null;        // human status_details
  location: { city?: string; state?: string; zip?: string; country?: string } | null;
  statusDate: string | null;
  eta: string | null;
  error: string | null;         // human-readable fetch/lookup problem; row is not poisoned
};

export async function trackPackage(key: string, carrier: string, trackingNumber: string): Promise<TrackResult> {
  const empty: TrackResult = { status: null, substatus: null, detail: null, location: null, statusDate: null, eta: null, error: null };
  let res: Response;
  try {
    res = await fetchWithBackoff(`${BASE}/tracks/${encodeURIComponent(carrier.trim())}/${encodeURIComponent(trackingNumber.trim())}`, {
      headers: { Authorization: `ShippoToken ${key.trim()}` },
    });
  } catch {
    return { ...empty, error: 'Could not reach Shippo — check your network connection.' };
  }
  if (!res.ok) {
    if (res.status === 401) return { ...empty, error: 'Shippo rejected the API key (401) — check Settings.' };
    if (res.status === 404 || res.status === 400) return { ...empty, error: `Carrier/tracking not recognized by Shippo (HTTP ${res.status}) — check the carrier token and number.` };
    return { ...empty, error: `Shippo tracking failed (HTTP ${res.status}).` };
  }
  const body = await res.json().catch(() => null) as {
    tracking_status?: { status?: string; substatus?: { code?: string } | null; status_details?: string; status_date?: string; location?: TrackResult['location'] } | null;
    eta?: string | null;
  } | null;
  const ts = body?.tracking_status;
  return {
    status: ts?.status || null,
    substatus: ts?.substatus?.code || null,
    detail: ts?.status_details || null,
    location: ts?.location || null,
    statusDate: ts?.status_date || null,
    eta: body?.eta || null,
    error: null,
  };
}

export type ShippoAddress = {
  name: string; street1: string; street2?: string | null;
  city: string; state: string; zip: string; country: string;
  phone?: string | null; email?: string | null;
};
export type ShippoParcel = {
  length: string; width: string; height: string; distance_unit: 'in';
  weight: string; mass_unit: 'lb';
};
export type ShippoRate = {
  object_id: string; provider: string; servicelevel: { name?: string; token?: string };
  amount: string; currency: string; estimated_days?: number | null; duration_terms?: string;
};

const ALLOWED_PROVIDERS = ['USPS', 'UPS'];

export async function getRates(key: string, from: ShippoAddress, to: ShippoAddress, parcel: ShippoParcel): Promise<{ rates: ShippoRate[]; allRateCount: number; messages: string[] }> {
  let res: Response;
  try {
    // rate creation costs nothing — safe to retry
    res = await fetchWithBackoff(`${BASE}/shipments/`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ address_from: from, address_to: to, parcels: [parcel], async: false }),
    });
  } catch {
    throw new Error('Could not reach Shippo — check your network connection.');
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Shippo rejected the API key (401) — check Settings.');
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    throw new Error(`Shippo rate request failed (HTTP ${res.status})${body ? `: ${JSON.stringify(body).slice(0, 300)}` : ''}`);
  }
  const body = await res.json().catch(() => null) as {
    rates?: ShippoRate[];
    messages?: { source?: string; code?: string; text?: string }[];
  } | null;
  const all = body?.rates || [];
  return {
    rates: all.filter(r => ALLOWED_PROVIDERS.includes((r.provider || '').toUpperCase())),
    allRateCount: all.length,
    messages: (body?.messages || []).map(m => [m.source, m.code, m.text].filter(Boolean).join(' ')).filter(Boolean),
  };
}

/**
 * Thrown ONLY when Shippo returned an explicit ERROR-status transaction —
 * a DEFINITIVE refusal: no charge, no label. Callers may safely release
 * the purchase lease on this error. Every other purchase failure
 * (network drop, 5xx, poll timeout) throws a plain Error and must be
 * treated as AMBIGUOUS — money may have moved.
 */
export class ShippoPurchaseRefusedError extends Error {}

export type PurchaseResult = {
  transactionId: string; trackingNumber: string; labelUrl: string;
  // the rate the label was ACTUALLY purchased against — recovery flows
  // must match this to the draft's stored rate before attaching, or a
  // pasted transaction id could finalize the wrong transfer
  rateId: string | null;
};

/**
 * Buys a REAL label. Single attempt; QUEUED/WAITING is polled by GET.
 * Throws with operator-readable messages on failure — and when a
 * transaction id is known, the message INCLUDES it so a
 * purchased-but-unconfirmed label is manually recoverable.
 */
export async function purchaseLabel(key: string, rateObjectId: string): Promise<PurchaseResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/transactions/`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ rate: rateObjectId, label_file_type: 'PDF_4x6', async: false }),
    });
  } catch {
    throw new Error('Network dropped during the label purchase. DO NOT retry blindly — check the Shippo dashboard for a purchased label first, then retry from the draft if none exists.');
  }
  return await resolveTransaction(key, res);
}

async function resolveTransaction(key: string, res: Response): Promise<PurchaseResult> {
  type Txn = { object_id?: string; status?: string; tracking_number?: string; label_url?: string; rate?: string | { object_id?: string }; messages?: { text?: string; code?: string; source?: string }[] };
  if (!res.ok && res.status !== 400) {
    // 400s still carry a transaction body with messages; other statuses don't
    if (res.status === 401) throw new Error('Shippo rejected the API key (401) — check Settings.');
    throw new Error(`Shippo purchase failed (HTTP ${res.status}). Check the Shippo dashboard before retrying — the label may still have been created.`);
  }
  let txn = await res.json().catch(() => null) as Txn | null;
  // QUEUED/WAITING resolves within seconds — poll by GET, never re-POST
  for (let i = 0; i < 5 && txn && (txn.status === 'QUEUED' || txn.status === 'WAITING'); i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await fetch(`${BASE}/transactions/${txn.object_id}`, { headers: { Authorization: `ShippoToken ${key.trim()}` } }).catch(() => null);
    if (poll?.ok) txn = await poll.json().catch(() => txn) as Txn;
  }
  if (txn && txn.status === 'SUCCESS' && txn.label_url) {
    return {
      transactionId: txn.object_id || '', trackingNumber: txn.tracking_number || '', labelUrl: txn.label_url,
      rateId: (typeof txn.rate === 'string' ? txn.rate : txn.rate?.object_id) || null,
    };
  }
  const msgs = (txn?.messages || []).map(m => m.text || m.code || '').filter(Boolean).join('; ');
  if (txn && (txn.status === 'QUEUED' || txn.status === 'WAITING')) {
    throw new Error(`Label purchase is still processing at Shippo (transaction ${txn.object_id}). Do NOT purchase again — use "Retry purchase" in a minute; it will pick up this transaction.`);
  }
  if (txn && txn.status === 'ERROR') {
    // DEFINITIVE refusal — no charge, no label; safe to release the lease
    throw new ShippoPurchaseRefusedError(`Shippo refused the label purchase${msgs ? `: ${msgs}` : ''}${msgs.toLowerCase().includes('rate') ? ' — the rate may have expired; re-fetch rates.' : ''}`);
  }
  throw new Error(`Shippo did not confirm the label purchase${msgs ? ` (${msgs})` : ''} — treat it as UNKNOWN: check the Shippo dashboard or use "Check Shippo & retry" before buying again.`);
}

/**
 * RELOAD-SAFE recovery: Shippo itself is the durable store. Given a
 * draft's rate id, list transactions and find one purchased against that
 * rate — no browser memory or transaction-id note needed. Returns the
 * purchase when a SUCCESS transaction exists (may return early), null
 * ONLY after paginating the account's ENTIRE transaction history without
 * a match (safe to purchase or delete), and THROWS when a match is still
 * processing OR when the listing could not be walked to exhaustion — a
 * partial listing must never authorize a re-purchase or a delete.
 */
export async function findTransactionByRate(key: string, rateId: string): Promise<PurchaseResult | null> {
  // 50 pages × 100 = 5,000 transactions — far beyond this operation's
  // volume; hitting it means something is wrong, so refuse rather than
  // declare "no label" from an incomplete walk.
  const MAX_PAGES = 50;
  let url = `${BASE}/transactions/?results=100`;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      // read-only listing — retry freely
      res = await fetchWithBackoff(url, { headers: { Authorization: `ShippoToken ${key.trim()}` } });
    } catch {
      throw new Error('Could not reach Shippo to check for an existing label — do not re-purchase or delete until this check succeeds.');
    }
    if (!res.ok) throw new Error(`Shippo transaction lookup failed (HTTP ${res.status}) — do not re-purchase or delete until this check succeeds.`);
    const body = await res.json().catch(() => null) as {
      results?: { object_id?: string; status?: string; tracking_number?: string; label_url?: string; rate?: string | { object_id?: string } }[];
      next?: string | null;
    } | null;
    if (!body) throw new Error('Shippo transaction lookup returned an unreadable page — do not re-purchase or delete until this check succeeds.');
    const matches = (body.results || []).filter(t =>
      (typeof t.rate === 'string' ? t.rate : t.rate?.object_id) === rateId);
    const success = matches.find(t => t.status === 'SUCCESS' && t.label_url);
    if (success) return { transactionId: success.object_id || '', trackingNumber: success.tracking_number || '', labelUrl: success.label_url!, rateId };
    if (matches.some(t => t.status === 'QUEUED' || t.status === 'WAITING')) {
      throw new Error('A purchase for this rate is still processing at Shippo — wait a minute and check again; do NOT re-purchase or delete.');
    }
    // an ERROR-status match proves the purchase attempt failed — keep
    // walking in case a later retry succeeded on the same rate
    if (!body.next) return null; // walked every page — provably no label
    if (!body.next.startsWith(BASE)) {
      throw new Error('Shippo returned an unexpected pagination link — do not re-purchase or delete until this check succeeds.');
    }
    url = body.next;
  }
  throw new Error(`Shippo transaction history exceeds ${MAX_PAGES * 100} entries — the existing-label check could not complete. Do not re-purchase or delete; find the label in the Shippo dashboard instead.`);
}

/** Re-check a known transaction (recovery path for QUEUED timeouts). */
export async function getTransaction(key: string, transactionId: string): Promise<PurchaseResult> {
  const res = await fetch(`${BASE}/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `ShippoToken ${key.trim()}` },
  });
  return await resolveTransaction(key, res);
}

/**
 * Refund reconciliation, same exhaustive discipline as
 * findTransactionByRate: list the account's refunds page by page and
 * find one for this transaction. Returns its status when found, null
 * ONLY after the FULL listing proves no refund exists (safe to
 * re-request), and THROWS when the walk could not complete — a partial
 * listing must never authorize a repeat refund request.
 */
export async function findRefundByTransaction(key: string, transactionId: string): Promise<string | null> {
  const MAX_PAGES = 50;
  let url = `${BASE}/refunds/?results=100`;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      // read-only listing — retry freely
      res = await fetchWithBackoff(url, { headers: { Authorization: `ShippoToken ${key.trim()}` } });
    } catch {
      throw new Error('Could not reach Shippo to check for an existing refund — do not re-request until this check succeeds.');
    }
    if (!res.ok) throw new Error(`Shippo refund lookup failed (HTTP ${res.status}) — do not re-request until this check succeeds.`);
    const body = await res.json().catch(() => null) as {
      results?: { object_id?: string; status?: string; transaction?: string | { object_id?: string } }[];
      next?: string | null;
    } | null;
    if (!body) throw new Error('Shippo refund lookup returned an unreadable page — do not re-request until this check succeeds.');
    const match = (body.results || []).find(r =>
      (typeof r.transaction === 'string' ? r.transaction : r.transaction?.object_id) === transactionId);
    if (match) return match.status || 'PENDING';
    if (!body.next) return null; // walked every page — provably no refund
    if (!body.next.startsWith(BASE)) {
      throw new Error('Shippo returned an unexpected pagination link — do not re-request until this check succeeds.');
    }
    url = body.next;
  }
  throw new Error(`Shippo refund history exceeds ${MAX_PAGES * 100} entries — the check could not complete; use the Shippo dashboard.`);
}

/** Request a refund for a purchased label. Single attempt. */
export async function requestRefund(key: string, transactionId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/refunds/`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ transaction: transactionId, async: false }),
    });
  } catch {
    throw new Error('Network dropped during the refund request — check the Shippo dashboard before retrying.');
  }
  const body = await res.json().catch(() => null) as { status?: string } | null;
  if (!res.ok) throw new Error(`Shippo refund request failed (HTTP ${res.status}).`);
  return body?.status || 'REFUNDPENDING';
}
