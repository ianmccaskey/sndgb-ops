import type { ShippoHttp } from './useShippoHttp';

/*
 * Shippo client. TRANSPORT: every call runs on UI Bakery's BACKEND via
 * the 'Shippo API' HTTP datasource (see useShippoHttp) — Shippo removed
 * browser CORS support in 2026-08, so the browser never talks to
 * api.goshippo.com directly any more. Key lives in app_settings as
 * shippo_api_key, entered by the operator in Settings, and travels with
 * each call as an action param (same client-trust model as before).
 *
 * REAL-MONEY DISCIPLINE (unchanged):
 *  - purchaseLabel and requestRefund make a SINGLE attempt — one action
 *    invocation is one backend request, never retried here: a retry
 *    after Shippo already charged would buy a SECOND label (Shippo has
 *    no idempotency key). Reads and rate creation retry freely.
 *  - a QUEUED/WAITING transaction is polled by GET (never re-POSTed).
 *  - test keys (shippo_test_...) return SIMULATED tracking — callers must
 *    check isTestKey() and suppress auto-receive so fake DELIVERED events
 *    can never move real inventory.
 *
 * ERROR SHAPE: the platform throws on non-2xx responses; the HTTP status
 * is recovered from the error text when present. A missing status means
 * the failure is AMBIGUOUS (backend/network) — money paths treat it as
 * possibly-charged.
 */

const BASE = 'https://api.goshippo.com';

/**
 * A recipient phone worth sending to Shippo, or undefined. The upstream
 * order form lets customers type anything into the phone box — a dozen
 * MB5 orders carry their STREET ADDRESS there ("87 Royal RD"), which
 * Shippo digit-strips and rejects ("87 is not a valid US phone
 * number"). Recipient phone is optional, so anything that isn't a
 * plausible US number (10 digits, or 11 starting with 1) is omitted
 * rather than sent — no warning, and no garbage printed on UPS labels.
 * Ship-FROM phones must NOT pass through this: Shippo requires one at
 * purchase, so an invalid one should refuse loudly, not vanish.
 */
export function usPhoneOrUndefined(v: unknown): string | undefined {
  const digits = (v == null ? '' : String(v)).replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return undefined;
}

export function isTestKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith('shippo_test');
}

/**
 * One cheap read that proves the whole chain: 'Shippo API' datasource
 * present and pointed correctly, backend path working, key accepted,
 * response in the expected Shippo shape. Wired to the Settings "Test
 * Shippo connection" button so a missing/misconfigured datasource fails
 * FAST and visibly, per environment, before any operator relies on
 * tracking, rates, or labels.
 */
export async function testShippoConnection(http: ShippoHttp, key: string): Promise<{ ok: boolean; message: string }> {
  // 1/2: GET probe with the SAME positive listing schema the recovery
  // walks demand (results array + next present as string-or-null)
  try {
    const body = unwrap(await http.get(key.trim(), '/transactions/?results=1'));
    const b = body as { results?: unknown; next?: unknown } | null;
    if (!(b && typeof b === 'object' && Array.isArray(b.results) && 'next' in b
        && (b.next === null || typeof b.next === 'string'))) {
      return { ok: false, message: 'GET reached the backend, but the response shape was unrecognized — check the "Shippo API" datasource base URL (must be https://api.goshippo.com with no path).' };
    }
  } catch (e: unknown) {
    const { status, message } = normalizeError(e);
    if (status === 401) return { ok: false, message: 'Shippo appears to have rejected the key (the error mentions 401) — re-check it above.' };
    return { ok: false, message: `GET could not reach Shippo through the backend (${message.slice(0, 160)}). Verify the workspace has an HTTP datasource named exactly "Shippo API" with base URL https://api.goshippo.com — see src/actions/shippo/DATASOURCE.md.` };
  }
  // 2/2: POST probe through the EXACT shippoPost path the rate/label/
  // refund flows use — registering a track is free and side-effect-light
  // (no shipment, no money), and the response must be a structurally
  // recognizable track object. Carrier depends on key mode: LIVE keys
  // are refused Shippo's test carrier (verified live: their 400 "Test
  // mode requires a test token"), so live probes register a USPS track
  // for a syntactically valid dummy number instead.
  try {
    const probe = isTestKey(key)
      ? { carrier: 'shippo', tracking_number: 'SHIPPO_TRANSIT' }
      : { carrier: 'usps', tracking_number: '9400100000000000000000' };
    const body = unwrap(await http.post(key.trim(), '/tracks/', probe));
    if (!(body && typeof body === 'object' && 'tracking_status' in (body as Record<string, unknown>))) {
      return { ok: false, message: 'GET works, but the POST response shape was unrecognized — rates/labels/refunds would fail. Check the shippoPost action and datasource config (src/actions/shippo/DATASOURCE.md).' };
    }
  } catch (e: unknown) {
    const { message } = normalizeError(e);
    return { ok: false, message: `GET works, but the POST path failed (${message.slice(0, 160)}) — rates/labels/refunds would fail until this is fixed.` };
  }
  return { ok: true, message: `Connected — GET listing schema and generic POST transport both verified${isTestKey(key) ? ' (TEST key)' : ''}. Endpoint-specific response contracts (rates/labels/refunds) are validated fail-closed at their point of use.` };
}

/** Absolute Shippo pagination links become datasource-relative paths. */
function relativize(url: string): string {
  return url.startsWith(BASE) ? url.slice(BASE.length) : url;
}

/**
 * Every operator-facing slice of a thrown transport message passes
 * through here: token-shaped substrings are struck out FIRST, so even
 * if the platform ever echoes request headers into an error, the live
 * key cannot reach the UI, screenshots, or logs.
 */
function sanitize(text: string): string {
  return text
    .replace(/ShippoToken\s+[^\s"'\\)\]}]+/gi, 'ShippoToken ***')
    .replace(/shippo_(live|test)_[A-Za-z0-9]+/gi, 'shippo_$1_***');
}

type NormalizedError = { status: number | null; message: string };
function normalizeError(e: unknown): NormalizedError {
  const message = sanitize(e instanceof Error ? e.message : String(e));
  // EMPIRICALLY OBSERVED envelope (verified live 2026-08-24): the platform
  // throws "Action <name> request failed with status=NNN, response={json}"
  // — parse the structured status= field first; the loose word-boundary
  // match remains only as a fallback for unknown shapes
  const structured = message.match(/status=(\d{3})\b/);
  const loose = message.match(/\b([45]\d\d)\b/);
  const m = structured || loose;
  return { status: m ? Number(m[1]) : null, message };
}

/**
 * Some platforms hand back an axios-style envelope ({ data, status });
 * Shippo bodies never carry a `data` key themselves, so unwrapping on
 * that signature is safe either way.
 */
function unwrap(r: unknown): unknown {
  if (r && typeof r === 'object' && 'data' in (r as Record<string, unknown>)
      && ('status' in (r as Record<string, unknown>) || 'headers' in (r as Record<string, unknown>))) {
    return (r as Record<string, unknown>).data;
  }
  return r;
}

/**
 * Retry wrapper for READ paths only — never wraps money-moving POSTs.
 * Deliberately retries EVERY failure: the platform's thrown error shape
 * is unstructured, so a regexed status is never trusted for control
 * flow (a fake 4xx must not suppress retries). A genuine 4xx just fails
 * all attempts quickly; statuses are used for operator HINTS only.
 * Five attempts with exponential spacing (0.6/1.2/2.4/4.8s ≈ the old
 * fetchWithBackoff resilience) — Retry-After headers are not visible
 * through the action layer, so depth substitutes for header-awareness;
 * the proof paths fail closed and must not give up under brief
 * throttling or upstream blips.
 */
async function getWithRetry(http: ShippoHttp, token: string, path: string, attempts = 5): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return unwrap(await http.get(token, path));
    } catch (e: unknown) {
      last = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 600 * Math.pow(2, i)));
    }
  }
  throw last;
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

export async function trackPackage(http: ShippoHttp, key: string, carrier: string, trackingNumber: string): Promise<TrackResult> {
  const empty: TrackResult = { status: null, substatus: null, detail: null, location: null, statusDate: null, eta: null, error: null };
  let body: unknown;
  try {
    // SMALL retry budget by design: tracking is operator-driven, commonly
    // fails on bad input (typo'd number/carrier, wrong key), its failure
    // is harmless (error-only write preserves the snapshot), and
    // refreshAll runs rows sequentially — a deep budget would turn one
    // deterministic failure into minutes of stalls. The fail-closed PROOF
    // walks keep the deep budget; this differentiation is by caller
    // stakes, never by text-derived status.
    // String() guards: an all-numeric tracking number can reach here as a
    // JS number (action transport re-types digit-only text columns)
    body = await getWithRetry(http, key.trim(), `/tracks/${encodeURIComponent(String(carrier).trim())}/${encodeURIComponent(String(trackingNumber).trim())}`, 2);
  } catch (e: unknown) {
    // statuses below are HINTS parsed from unstructured error text, never
    // control flow — phrased accordingly
    const { status, message } = normalizeError(e);
    if (status === 401) return { ...empty, error: 'Shippo appears to have rejected the API key (the error mentions 401) — check Settings.' };
    if (status === 404 || status === 400) return { ...empty, error: `Carrier/tracking not recognized (the error mentions HTTP ${status}) — check the carrier token and number.` };
    return { ...empty, error: `Could not reach Shippo through the backend (${message.slice(0, 140)}).` };
  }
  // POSITIVE schema gate: a Shippo track object always carries the
  // tracking_status key (possibly null) plus its identity fields. An
  // unrecognized success envelope returns as an ERROR — the error-aware
  // tracking update then preserves the last good snapshot instead of
  // being wiped by blanks.
  if (!body || typeof body !== 'object'
      || !('tracking_status' in (body as Record<string, unknown>))
      || !('tracking_number' in (body as Record<string, unknown>) || 'carrier' in (body as Record<string, unknown>))
      // tracking_status itself must be null (no scans yet) or an object —
      // a string/other value means the payload drifted, and returning
      // success would blank the stored snapshot with nulls
      || !((body as Record<string, unknown>).tracking_status === null
           || typeof (body as Record<string, unknown>).tracking_status === 'object')) {
    return { ...empty, error: 'Shippo tracking came back in an unrecognized shape — refresh skipped, previous status kept.' };
  }
  const b = body as {
    tracking_status?: { status?: string; substatus?: { code?: string } | null; status_details?: string; status_date?: string; location?: TrackResult['location'] } | null;
    eta?: string | null;
  } | null;
  const ts = b?.tracking_status;
  return {
    status: ts?.status || null,
    substatus: ts?.substatus?.code || null,
    detail: ts?.status_details || null,
    location: ts?.location || null,
    statusDate: ts?.status_date || null,
    eta: b?.eta || null,
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

// the services the operator actually ships with sort ABOVE everything
// else (each group price-ascending): UPS Ground, UPS Ground Saver, USPS
// Ground Advantage, USPS Priority Mail. Matched by servicelevel token
// first, then by EXACT normalized name (never a prefix — "Priority
// Mail" must not drag "Priority Mail Express" up with it).
const PRIORITY_TOKENS = new Set(['ups_ground', 'ups_ground_saver', 'usps_ground_advantage', 'usps_priority']);
const normSvc = (s?: string) => (s || '').replace(/[®™]/g, '').trim().toLowerCase();
const isPriorityRate = (r: ShippoRate): boolean => {
  if (PRIORITY_TOKENS.has(normSvc(r.servicelevel?.token))) return true;
  const p = (r.provider || '').toUpperCase();
  const n = normSvc(r.servicelevel?.name);
  return (p === 'UPS' && (n === 'ground' || n === 'ground saver'))
    || (p === 'USPS' && (n === 'ground advantage' || n === 'priority mail'));
};

/** Declared-value insurance riding on the shipment: rates quoted from an
 * insured shipment carry the insurance through to the purchased label
 * (Shippo bills the premium with the label). amount is the INSURED VALUE
 * of the contents, not the premium. */
export type ShippoInsurance = { amount: string; currency: 'USD' };

export async function getRates(http: ShippoHttp, key: string, from: ShippoAddress, to: ShippoAddress, parcel: ShippoParcel, insurance?: ShippoInsurance | null): Promise<{ rates: ShippoRate[]; allRateCount: number; messages: string[] }> {
  let body: unknown;
  // rate creation costs nothing and every label depends on it — retry
  // EVERY failure with the old client's depth (4 attempts, 0.8/1.6/3.2s;
  // a regexed status is never trusted to suppress a retry — a genuine
  // 4xx just fails each attempt fast). Parsed statuses appear only as
  // hints in the final message, after the retry policy has run.
  for (let attempt = 0; ; attempt++) {
    try {
      body = unwrap(await http.post(key.trim(), '/shipments/', {
        address_from: from, address_to: to, parcels: [parcel], async: false,
        ...(insurance ? { extra: { insurance: { amount: insurance.amount, currency: insurance.currency } } } : {}),
      }));
      break;
    } catch (e: unknown) {
      if (attempt >= 3) {
        const { status, message } = normalizeError(e);
        const hint = status === 401 ? ' — the error mentions 401; re-check the key in Settings' : '';
        throw new Error(`Could not get rates from Shippo (${message.slice(0, 250)})${hint}.`);
      }
      await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
    }
  }
  // POSITIVE schema gate: a synchronous shipment always carries a rates
  // ARRAY (possibly empty) — anything else is an unrecognized envelope,
  // not a legitimate zero-rate answer.
  if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).rates)) {
    throw new Error('Shippo rates came back in an unrecognized shape — nothing was quoted; try again.');
  }
  const b = body as {
    rates?: ShippoRate[];
    messages?: { source?: string; code?: string; text?: string }[];
  } | null;
  const all = b?.rates || [];
  return {
    rates: all
      .filter(r => ALLOWED_PROVIDERS.includes((r.provider || '').toUpperCase()))
      .sort((a, b2) => {
        const pa = isPriorityRate(a), pb = isPriorityRate(b2);
        if (pa !== pb) return pa ? -1 : 1;
        return Number(a.amount) - Number(b2.amount);
      }),
    allRateCount: all.length,
    // UPS/USPS messages ALWAYS stay (account failures included). For the
    // rest, drop other-carrier noise two ways: structurally — Shippo's
    // own account tokens (shippo_<carrier>_account / <CARRIER>_SHIPPO_TIER)
    // for any non-UPS/USPS carrier, which catches carriers we never
    // enumerated — plus a name blocklist for prose mentions. A message
    // naming no carrier at all (generic errors, address warnings) stays.
    messages: (b?.messages || [])
      .filter(m => {
        const joined = [m.source, m.code, m.text].filter(Boolean).join(' ');
        // known-inconsequential informational alerts are silenced even
        // for allowed carriers (operator-confirmed noise): UPS 110920
        // (commercial->residential reclassification) and 110971
        // (invoice may vary from reference rates) fire on nearly every
        // residential quote and say nothing actionable
        if (/\b(110920|110971)\b/.test(joined)) return false;
        // \b can't see through underscores (shippo_ups_account), so the
        // allowed-carrier test runs on a separator-normalized copy — a
        // UPS/USPS account failure in token form MUST survive
        const norm = joined.replace(/[_-]+/g, ' ');
        if (/\b(ups|usps)\b/i.test(norm)) return true;
        if (/shippo_[a-z0-9_]+_(account|master)|[A-Za-z0-9]+_SHIPPO_TIER/i.test(joined)) return false;
        return !/dhl|fedex|sendle|deutsche|canada|couriersplease|fastway|globegistics|asendia|hermes|evri|parcelforce|purolator|canpar|ontrac|lasership|aramex|tnt|royal ?mail|\bgls\b|\bdpd\b|australia ?post|chronopost|colissimo|poste\b/i.test(norm);
      })
      .map(m => [m.source, m.code, m.text].filter(Boolean).join(' '))
      .filter(Boolean),
  };
}

/**
 * Thrown ONLY on a DEFINITIVE refusal proven STRUCTURALLY: a parsed
 * transaction object whose status is 'ERROR' — no charge, no label.
 * Never inferred from error text (a regexed status inside an
 * undocumented platform message is not proof), so every thrown transport
 * failure — including apparent 4xx — is treated as AMBIGUOUS: money may
 * have moved, and recovery goes through the verified "Check Shippo &
 * retry" walk. Callers may safely release the purchase lease on this
 * error and on nothing else.
 */
export class ShippoPurchaseRefusedError extends Error {}

export type PurchaseResult = {
  transactionId: string; trackingNumber: string; labelUrl: string;
  // the rate the label was ACTUALLY purchased against — recovery flows
  // must match this to the draft's stored rate before attaching, or a
  // pasted transaction id could finalize the wrong transfer
  rateId: string | null;
};

type Txn = { object_id?: string; status?: string; tracking_number?: string; label_url?: string; rate?: string | { object_id?: string }; messages?: { text?: string; code?: string; source?: string }[] };

/**
 * Buys a REAL label. Single POST; QUEUED/WAITING is polled by GET.
 * Throws with operator-readable messages on failure — and when a
 * transaction id is known, the message INCLUDES it so a
 * purchased-but-unconfirmed label is manually recoverable.
 */
export async function purchaseLabel(http: ShippoHttp, key: string, rateObjectId: string): Promise<PurchaseResult> {
  let txn: Txn | null;
  try {
    txn = unwrap(await http.post(key.trim(), '/transactions/', { rate: rateObjectId, label_file_type: 'PDF_4x6', async: false })) as Txn | null;
  } catch (e: unknown) {
    // EVERY thrown failure is ambiguous here — even an apparent 4xx: the
    // status is regexed from undocumented error text and is NOT proof the
    // POST never reached Shippo. Only a parsed ERROR-status transaction
    // (below, in resolveTransaction) proves a refusal.
    const { message } = normalizeError(e);
    throw new Error(`The label purchase did not confirm (${message.slice(0, 200)}). DO NOT retry blindly — use "Check Shippo & retry", which verifies whether a label was already bought.`);
  }
  return await resolveTransaction(http, key, txn);
}

async function resolveTransaction(http: ShippoHttp, key: string, initial: Txn | null): Promise<PurchaseResult> {
  let txn = initial;
  // QUEUED/WAITING resolves within seconds — poll by GET, never re-POST
  for (let i = 0; i < 5 && txn && (txn.status === 'QUEUED' || txn.status === 'WAITING'); i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      txn = unwrap(await http.get(key.trim(), `/transactions/${txn.object_id}`)) as Txn;
    } catch {
      // keep the last known state; the loop or the fallthrough handles it
    }
  }
  if (txn && txn.status === 'SUCCESS' && txn.label_url) {
    return {
      transactionId: txn.object_id || '', trackingNumber: txn.tracking_number || '', labelUrl: txn.label_url,
      rateId: (typeof txn.rate === 'string' ? txn.rate : txn.rate?.object_id) || null,
    };
  }
  const msgs = (txn?.messages || []).map(m => m.text || m.code || '').filter(Boolean).join('; ');
  if (txn && (txn.status === 'QUEUED' || txn.status === 'WAITING')) {
    throw new Error(`Label purchase is still processing at Shippo (transaction ${txn.object_id}). Do NOT purchase again — use "Check Shippo & retry" in a minute; it will pick up this transaction.`);
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
 * ONLY when the walk PROVES no label exists (safe to purchase or
 * delete), and THROWS when a match is still processing OR when the
 * listing could not be walked to proof — a partial listing must never
 * authorize a re-purchase or a delete.
 *
 * The walk stays bounded by the DRAFT's age, not the account's size:
 * a transaction against this rate cannot predate the draft that stored
 * it, and Shippo lists newest-first, so once a whole page is older than
 * createdAfter (minus a 24h clock-skew margin) the remaining history is
 * provably irrelevant. Old accounts therefore terminate in a page or
 * two; the page cap is a backstop that in practice only fires when no
 * createdAfter is available.
 */
export async function findTransactionByRate(http: ShippoHttp, key: string, rateId: string, createdAfter?: string): Promise<PurchaseResult | null> {
  const MAX_PAGES = 50;
  const cutoffMs = createdAfter ? Date.parse(createdAfter) - 24 * 3600 * 1000 : NaN;
  let path = '/transactions/?results=100';
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: unknown;
    try {
      // read-only listing — retry freely
      body = await getWithRetry(http, key.trim(), path);
    } catch (e: unknown) {
      const { message } = normalizeError(e);
      throw new Error(`Could not check Shippo for an existing label (${message.slice(0, 160)}) — do not re-purchase or delete until this check succeeds.`);
    }
    // POSITIVE schema check: a proof-of-absence may only come from a page
    // that is definitely a Shippo listing (results array + next present as
    // string-or-null). Any other successful-but-unrecognized envelope
    // fails CLOSED — it must never read as an empty history.
    const b = body as { results?: unknown; next?: unknown } | null;
    if (!b || typeof b !== 'object' || !Array.isArray(b.results) || !('next' in b)
        || (b.next !== null && typeof b.next !== 'string')) {
      throw new Error('Shippo transaction lookup came back in an unrecognized shape — do not re-purchase or delete until this check succeeds.');
    }
    const pageRows = b.results as (Txn & { object_created?: string })[];
    const pageNext = b.next as string | null;
    // ROW-LEVEL gate: every row this proof consumes must carry the fields
    // the decision depends on — a page whose rows renamed/dropped status
    // or rate is not semantically readable and must not prove absence
    for (const t of pageRows) {
      if (!t || typeof t !== 'object' || !('status' in t) || !('rate' in t)
          || !(typeof t.rate === 'string' || (typeof t.rate === 'object' && t.rate !== null))) {
        throw new Error('Shippo transaction rows came back in an unrecognized shape — do not re-purchase or delete until this check succeeds.');
      }
    }
    const matches = pageRows.filter(t =>
      (typeof t.rate === 'string' ? t.rate : t.rate?.object_id) === rateId);
    const success = matches.find(t => t.status === 'SUCCESS' && t.label_url);
    if (success) return { transactionId: success.object_id || '', trackingNumber: success.tracking_number || '', labelUrl: success.label_url!, rateId };
    if (matches.some(t => t.status === 'QUEUED' || t.status === 'WAITING')) {
      throw new Error('A purchase for this rate is still processing at Shippo — wait a minute and check again; do NOT re-purchase or delete.');
    }
    // an ERROR-status match proves the purchase attempt failed — keep
    // walking in case a later retry succeeded on the same rate
    if (!pageNext) return null; // walked every page — provably no label
    if (!Number.isNaN(cutoffMs) && pageRows.length > 0 &&
        pageRows.every(t => t.object_created && Date.parse(t.object_created) < cutoffMs)) {
      return null; // newest-first: everything beyond this page predates the draft
    }
    if (!pageNext.startsWith(BASE)) {
      throw new Error('Shippo returned an unexpected pagination link — do not re-purchase or delete until this check succeeds.');
    }
    path = relativize(pageNext);
  }
  throw new Error(`Shippo transaction history exceeds ${MAX_PAGES * 100} entries — the existing-label check could not complete. Do not re-purchase or delete; find the label in the Shippo dashboard instead.`);
}

/** Re-check a known transaction (recovery path for QUEUED timeouts). */
export async function getTransaction(http: ShippoHttp, key: string, transactionId: string): Promise<PurchaseResult> {
  let txn: Txn | null;
  try {
    txn = unwrap(await http.get(key.trim(), `/transactions/${encodeURIComponent(transactionId)}`)) as Txn | null;
  } catch (e: unknown) {
    // AMBIGUOUS, always: a regexed status is not proof the transaction is
    // absent, and telling the operator "not found" here could steer them
    // toward a second purchase of an already-paid label
    const { message } = normalizeError(e);
    throw new Error(`Could not fetch that transaction from Shippo (${message.slice(0, 160)}) — this does NOT mean it doesn't exist. Check the Shippo dashboard; do not re-buy yet.`);
  }
  return await resolveTransaction(http, key, txn);
}

/**
 * Refund reconciliation, same discipline as findTransactionByRate: list
 * the account's refunds page by page and find one for this transaction.
 * Returns its status when found, null ONLY when the walk proves no
 * refund exists (safe to re-request), and THROWS when the walk could
 * not reach proof — a partial listing must never authorize a repeat
 * refund request. createdAfter (the transfer's creation time) bounds the
 * walk by the TRANSFER's age: a refund for this label cannot predate
 * it, so a page entirely older than that (minus 24h skew) ends the walk.
 */
export async function findRefundByTransaction(http: ShippoHttp, key: string, transactionId: string, createdAfter?: string): Promise<string | null> {
  const MAX_PAGES = 50;
  const cutoffMs = createdAfter ? Date.parse(createdAfter) - 24 * 3600 * 1000 : NaN;
  let path = '/refunds/?results=100';
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: unknown;
    try {
      // read-only listing — retry freely
      body = await getWithRetry(http, key.trim(), path);
    } catch (e: unknown) {
      const { message } = normalizeError(e);
      throw new Error(`Could not check Shippo for an existing refund (${message.slice(0, 160)}) — do not re-request until this check succeeds.`);
    }
    // POSITIVE schema check — same fail-closed rule as the transaction
    // walk: an unrecognized success envelope must never read as an empty
    // refund history and reopen the request button.
    const b = body as { results?: unknown; next?: unknown } | null;
    if (!b || typeof b !== 'object' || !Array.isArray(b.results) || !('next' in b)
        || (b.next !== null && typeof b.next !== 'string')) {
      throw new Error('Shippo refund lookup came back in an unrecognized shape — do not re-request until this check succeeds.');
    }
    const pageRows = b.results as { object_id?: string; object_created?: string; status?: string; transaction?: string | { object_id?: string } }[];
    const pageNext = b.next as string | null;
    // ROW-LEVEL gate, same rule as the transaction walk
    for (const r of pageRows) {
      if (!r || typeof r !== 'object' || !('status' in r) || !('transaction' in r)
          || !(typeof r.transaction === 'string' || (typeof r.transaction === 'object' && r.transaction !== null))) {
        throw new Error('Shippo refund rows came back in an unrecognized shape — do not re-request until this check succeeds.');
      }
    }
    const match = pageRows.find(r =>
      (typeof r.transaction === 'string' ? r.transaction : r.transaction?.object_id) === transactionId);
    if (match) return match.status || 'PENDING';
    if (!pageNext) return null; // walked every page — provably no refund
    if (!Number.isNaN(cutoffMs) && pageRows.length > 0 &&
        pageRows.every(r => r.object_created && Date.parse(r.object_created) < cutoffMs)) {
      return null; // newest-first: everything beyond this page predates the transfer
    }
    if (!pageNext.startsWith(BASE)) {
      throw new Error('Shippo returned an unexpected pagination link — do not re-request until this check succeeds.');
    }
    path = relativize(pageNext);
  }
  throw new Error(`Shippo refund history exceeds ${MAX_PAGES * 100} entries — the check could not complete; use the Shippo dashboard.`);
}

/** Request a refund for a purchased label. Single attempt. */
export async function requestRefund(http: ShippoHttp, key: string, transactionId: string): Promise<string> {
  let body: unknown;
  try {
    body = unwrap(await http.post(key.trim(), '/refunds/', { transaction: transactionId, async: false }));
  } catch (e: unknown) {
    const { message } = normalizeError(e);
    throw new Error(`The refund request did not confirm (${message.slice(0, 160)}) — use "Re-check" to reconcile with Shippo before trying again.`);
  }
  // POSITIVE schema gate, like every other proof path: only a payload
  // that is structurally a Shippo refund object (status + transaction)
  // may be recorded as a real request — an unrecognized success envelope
  // throws, leaving the row in REQUESTING for verified reconciliation.
  if (!body || typeof body !== 'object'
      || typeof (body as Record<string, unknown>).status !== 'string'
      || !('transaction' in (body as Record<string, unknown>))) {
    throw new Error('The refund response came back in an unrecognized shape — use "Re-check" to reconcile with Shippo before trying again.');
  }
  return (body as { status: string }).status || 'REFUNDPENDING';
}
