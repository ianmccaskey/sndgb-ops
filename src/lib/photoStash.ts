import type { CapturedPhoto } from '@/lib/imageCapture';

/*
 * The durable photo stash: the SINGLE backing store for every package
 * capture that is not yet attached to a shipment. Camera captures are
 * ephemeral File objects, so a capture enters this queue BEFORE any
 * upload is attempted and leaves it exactly two ways: a verified
 * successful attach, or an explicit operator removal. UI lists
 * (ShippingModal's pending section, OrderDetailSheet's stranded-photo
 * recovery) are only views over this queue.
 *
 *   shipment_id = number: a failed upload bound to that shipment,
 *     auto-replayed (replay=true) when the ship dialog reopens, and
 *     retryable from the order detail sheet after the order leaves the
 *     fulfillment queue.
 *   shipment_id = null: order-scoped pending. Fresh captures (the box
 *     being packed right now) auto-attach to the shipment the operator
 *     creates. recovered=true entries — photos refused by the shipment
 *     they were CAPTURED FOR — NEVER auto-attach; each needs an
 *     explicit per-photo operator choice.
 *   key: unique per entry; every mutation is a SYNCHRONOUS fresh
 *     read -> mutate -> write keyed by it, so overlapping async flows
 *     in one tab cannot clobber each other with stale snapshots (JS
 *     sync blocks are atomic). Cross-tab overlap on one browser
 *     profile keeps a millisecond residual window — localStorage has
 *     no CAS — accepted for a two-admin tool on separate machines.
 *   actor: who CAPTURED the photo — a different admin may run the
 *     retry on a shared browser, and uploads must carry the original
 *     capturer or the audit trail would misattribute provenance.
 *
 * When persistence itself fails (private mode, origin quota full), the
 * module keeps the DELTA against what localStorage actually holds — an
 * override map (newest version per key) plus removal tombstones — and
 * readStash merges the persisted snapshot through it, so updates AND
 * removals survive a failed write. The delta is page-lifetime only,
 * and callers surface that honestly via the boolean the write ops
 * return (true = durably persisted).
 */
export type StashedPhoto = CapturedPhoto & {
  shipment_id: number | null;
  order_id: number;
  ts: number;
  actor: string;
  key: string;
  recovered?: boolean;
};

const STASH_KEY = 'sndgb.pendingShipPhotos';

export const newStashKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

let memOverrides = new Map<string, StashedPhoto>();
let memRemovals = new Set<string>();

const readPersisted = (): StashedPhoto[] => {
  try { return JSON.parse(localStorage.getItem(STASH_KEY) || '[]') as StashedPhoto[]; } catch { return []; }
};

export const readStash = (): StashedPhoto[] => {
  const merged = new Map<string, StashedPhoto>();
  for (const p of readPersisted()) if (!memRemovals.has(p.key)) merged.set(p.key, p);
  for (const [k, v] of memOverrides) merged.set(k, v);
  return [...merged.values()];
};

// low-level commit; true = every entry durably persisted
const commitStash = (items: StashedPhoto[]): boolean => {
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify(items));
    memOverrides = new Map();
    memRemovals = new Set();
    return true;
  } catch {
    const itemKeys = new Set(items.map(i => i.key));
    memOverrides = new Map(items.map(i => [i.key, i]));
    memRemovals = new Set(readPersisted().map(p => p.key).filter(k => !itemKeys.has(k)));
    return false;
  }
};

// per-entry ops: each re-reads the latest queue synchronously, so a slow
// async flow never writes back a stale snapshot
export const stashUpsert = (entry: StashedPhoto): boolean =>
  commitStash([...readStash().filter(s => s.key !== entry.key), entry]);

export const stashRemove = (key: string): boolean =>
  commitStash(readStash().filter(s => s.key !== key));
