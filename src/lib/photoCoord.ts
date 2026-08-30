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

export const announce = (kind: CoordKind, orderId: number, active: boolean): void => {
  const msg: CoordMsg = { kind, order_id: orderId, active, tab: TAB_ID };
  if (channel) {
    try { channel.postMessage(msg); } catch { /* channel closed */ }
    return;
  }
  try { localStorage.setItem(LS_MSG_KEY, JSON.stringify({ ...msg, nonce: Math.random() })); } catch { /* storage down: single-tab behavior */ }
};

const anyActive = (kind: CoordKind, orderId: number): boolean => {
  const now = Date.now();
  for (const [tab, v] of remote[kind]) {
    if (now - v.ts > STALE_MS) { remote[kind].delete(tab); continue; }
    if (v.order_id === orderId) return true;
  }
  return false;
};

export const remoteCaptureActive = (orderId: number): boolean => anyActive('capture', orderId);
export const remoteLandingActive = (orderId: number): boolean => anyActive('landing', orderId);

// subscribe to remote coordination events (returns an unsubscribe)
export const subscribeCoord = (cb: (m: CoordMsg) => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
