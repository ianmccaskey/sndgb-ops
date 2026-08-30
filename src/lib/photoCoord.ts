/*
 * Cross-tab capture/landing coordination for package photos.
 *
 * The single-tab exclusion (capturingRef / landingRef in ShippingModal)
 * cannot see another tab: tab A can be mid-compression (its stash write
 * has not happened yet) while tab B lands a shipment for the same order
 * and snapshots the pending set without A's photo — which would then be
 * written as an ordinary pending entry and drift onto the next box. This
 * module broadcasts capture/landing activity per order over a
 * BroadcastChannel so each tab can (a) wait for the other's in-flight
 * capture before snapshotting and (b) learn that a landing happened
 * while its own capture was compressing.
 *
 * Entries carry timestamps and are considered stale after 30s, so a tab
 * that crashed mid-capture cannot wedge another tab's landing forever
 * (the landing's own bounded wait also caps the delay). Browsers
 * without BroadcastChannel simply degrade to single-tab behavior.
 */
type CoordKind = 'capture' | 'landing';
export type CoordMsg = { kind: CoordKind; order_id: number; active: boolean; tab: string };

const STALE_MS = 30_000;
const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sndgb-photo-coord') : null;

const remote: Record<CoordKind, Map<string, { order_id: number; ts: number }>> = {
  capture: new Map(),
  landing: new Map(),
};
const listeners = new Set<(m: CoordMsg) => void>();

const handleMsg = (m: CoordMsg): void => {
  if (!m || m.tab === TAB_ID) return;
  const map = remote[m.kind];
  if (!map) return;
  if (m.active) map.set(m.tab, { order_id: m.order_id, ts: Date.now() });
  else map.delete(m.tab);
  for (const cb of listeners) { try { cb(m); } catch { /* listener errors never break the channel */ } }
};

channel?.addEventListener('message', ev => handleMsg(ev.data as CoordMsg));

// fallback transport when BroadcastChannel is unavailable: localStorage
// 'storage' events fire in every OTHER tab of the origin, carrying the
// same messages — the cross-tab protection does not silently collapse
const LS_MSG_KEY = 'sndgb.photoCoordMsg';
if (!channel && typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', ev => {
      if (ev.key !== LS_MSG_KEY || !ev.newValue) return;
      try { handleMsg(JSON.parse(ev.newValue) as CoordMsg); } catch { /* malformed */ }
    });
  } catch { /* no window events: single-tab environment */ }
}

// live send health: a failed announce means other tabs may no longer
// see this tab's activity — coordAvailable() reflects it immediately so
// callers downgrade to conservative classification instead of assuming
// coordination that is not actually happening
let sendHealthy = true;
export const announce = (kind: CoordKind, orderId: number, active: boolean): void => {
  const msg: CoordMsg = { kind, order_id: orderId, active, tab: TAB_ID };
  persistHold(kind, orderId, active); // late-join visibility (heartbeats refresh ts)
  if (channel) {
    try { channel.postMessage(msg); sendHealthy = true; } catch { sendHealthy = false; }
    return;
  }
  try { localStorage.setItem(LS_MSG_KEY, JSON.stringify({ ...msg, nonce: Math.random() })); sendHealthy = true; } catch { sendHealthy = false; }
};

// persisted hold records: a tab that opens or reloads MID-operation has
// received no broadcast yet — it would be blind to an active hold until
// the next 10s heartbeat. Every announce also writes/removes its hold
// here (best-effort; the live broadcast rail is authoritative when
// localStorage is down), and anyActive() consults both, so late-joining
// tabs see current holds immediately. Each hold lives under its OWN
// (kind, tab) key — single setItem/removeItem per mutation, no shared
// array read-modify-write, so concurrent tabs cannot clobber each
// other's records. Same 30s staleness as broadcasts.
const HOLD_PREFIX = 'sndgb.photoCoordHold.';
const persistHold = (kind: CoordKind, orderId: number, active: boolean): void => {
  const key = `${HOLD_PREFIX}${kind}.${TAB_ID}`;
  try {
    if (active) localStorage.setItem(key, JSON.stringify({ order_id: orderId, ts: Date.now() }));
    else localStorage.removeItem(key);
  } catch { /* live broadcast rail still covers already-open tabs */ }
};
const persistedHoldActive = (kind: CoordKind, orderId: number, now: number): boolean => {
  try {
    const prefix = `${HOLD_PREFIX}${kind}.`;
    const stale: string[] = [];
    let found = false;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      if (k === `${prefix}${TAB_ID}`) continue; // own hold: not "remote"
      try {
        const v = JSON.parse(localStorage.getItem(k) || '') as { order_id: number; ts: number };
        if (now - v.ts > STALE_MS) { stale.push(k); continue; }
        if (v.order_id === orderId) found = true;
      } catch { stale.push(k); }
    }
    for (const k of stale) { try { localStorage.removeItem(k); } catch { /* prune later */ } }
    return found;
  } catch { return false; }
};

const anyActive = (kind: CoordKind, orderId: number): boolean => {
  const now = Date.now();
  for (const [tab, v] of remote[kind]) {
    if (now - v.ts > STALE_MS) { remote[kind].delete(tab); continue; }
    if (v.order_id === orderId) return true;
  }
  // late-join bootstrap: holds persisted by tabs whose broadcasts predate
  // this tab's existence
  return persistedHoldActive(kind, orderId, now);
};

export const remoteCaptureActive = (orderId: number): boolean => anyActive('capture', orderId);
export const remoteLandingActive = (orderId: number): boolean => anyActive('landing', orderId);

// hold a capture/landing signal ALIVE for the full operation: announces
// active immediately, re-announces every 10s (well inside the 30s
// staleness window, so a long-running operation never silently ages
// out of other tabs' view), and announces inactive on release. Callers
// must invoke the returned release in a finally.
export const announceHold = (kind: CoordKind, orderId: number): (() => void) => {
  announce(kind, orderId, true);
  const iv = setInterval(() => announce(kind, orderId, true), 10_000);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(iv);
    announce(kind, orderId, false);
  };
};

// true when SOME cross-tab transport actually works: BroadcastChannel,
// or a functional localStorage for the storage-event fallback. When
// false, remote activity is invisible — callers must fail CLOSED
// (conservative capture classification), never assume single-tab.
let lsProbe: boolean | null = null;
export const coordAvailable = (): boolean => {
  // not a sticky startup probe: a transport that existed but whose most
  // recent send FAILED counts as unavailable until a send succeeds again
  if (!sendHealthy) return false;
  if (channel) return true;
  // only POSITIVE probe results cache: a failed probe re-runs on the
  // next call, so fallback availability self-heals after a transient
  // storage failure instead of pinning the tab in degraded mode
  if (lsProbe !== true) {
    try {
      localStorage.setItem('sndgb.coordProbe', '1');
      localStorage.removeItem('sndgb.coordProbe');
      lsProbe = true;
    } catch { lsProbe = false; }
  }
  return lsProbe === true;
};

// subscribe to remote coordination events (returns an unsubscribe)
export const subscribeCoord = (cb: (m: CoordMsg) => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
