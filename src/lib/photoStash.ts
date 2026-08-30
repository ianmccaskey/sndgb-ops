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
 * Storage is IndexedDB, not localStorage: full images run ~900KB each
 * and a shipment allows 5, which would exhaust the ~5MB per-origin
 * localStorage budget exactly when uploads fail in bulk — the case the
 * stash exists for. IndexedDB budgets are orders of magnitude larger,
 * and each photo is its OWN record (keyPath 'key'), so put/delete are
 * atomic per entry with no shared-array read-modify-write to clobber —
 * concurrent flows in one tab and across tabs cannot overwrite each
 * other's entries. Entries stashed under the old localStorage key are
 * imported once and the key cleared.
 *
 *   shipment_id = number: a failed upload bound to that shipment,
 *     auto-replayed (replay=true) when the ship dialog reopens, and
 *     retryable from the order detail sheet forever.
 *   shipment_id = null: order-scoped pending. Fresh captures (the box
 *     being packed right now) auto-attach to the shipment the operator
 *     creates. recovered=true entries — photos refused by the shipment
 *     they were CAPTURED FOR — NEVER auto-attach; each needs an
 *     explicit per-photo operator choice.
 *   actor: who CAPTURED the photo — a different admin may run the
 *     retry on a shared browser, and uploads must carry the original
 *     capturer or the audit trail would misattribute provenance.
 *
 * When IndexedDB itself is unavailable (rare: some private modes,
 * storage-blocked browsers), operations fall back to a page-lifetime
 * memory overlay — overrides per key plus removal tombstones, merged
 * into every read — and return false so callers tell the operator the
 * photo is NOT durable instead of lying. The server side is the last
 * line regardless: same-content dedupe means a re-offered photo can
 * never duplicate.
 */
export type StashedPhoto = CapturedPhoto & {
  shipment_id: number | null;
  order_id: number;
  ts: number;
  actor: string;
  key: string;
  recovered?: boolean;
};

export const newStashKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const DB_NAME = 'sndgb-photo-stash';
const STORE = 'photos';
const LEGACY_KEY = 'sndgb.pendingShipPhotos';

let dbPromise: Promise<IDBDatabase> | null = null;
const openDb = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      } catch (e) { reject(e); }
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
};

const idbOp = <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  openDb().then(db => new Promise<T>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  }));

// page-lifetime fallback when IndexedDB is unavailable: newest state per
// key plus removal tombstones, merged into every read
const memPhotos = new Map<string, StashedPhoto>();
const memRemoved = new Set<string>();

// one-time import of entries stashed by the old localStorage version
let legacyImported = false;
const importLegacy = async (): Promise<void> => {
  if (legacyImported) return;
  legacyImported = true;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const items = JSON.parse(raw) as StashedPhoto[];
    for (const i of items) {
      if (i && typeof i.key === 'string') await idbOp('readwrite', s => s.put(i));
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* leave the legacy key in place; retried next read */ legacyImported = false; }
};

export const readStash = async (): Promise<StashedPhoto[]> => {
  await importLegacy();
  let persisted: StashedPhoto[] = [];
  try { persisted = await idbOp('readonly', s => s.getAll() as IDBRequest<StashedPhoto[]>); } catch { persisted = []; }
  const merged = new Map<string, StashedPhoto>();
  for (const p of persisted) if (!memRemoved.has(p.key)) merged.set(p.key, p);
  for (const [k, v] of memPhotos) merged.set(k, v);
  return [...merged.values()];
};

// true = durably persisted; false = page-lifetime memory only
export const stashUpsert = async (entry: StashedPhoto): Promise<boolean> => {
  memRemoved.delete(entry.key);
  try {
    await idbOp('readwrite', s => s.put(entry));
    memPhotos.delete(entry.key);
    return true;
  } catch {
    memPhotos.set(entry.key, entry);
    return false;
  }
};

// true = durably removed; false = removal held only in page memory
export const stashRemove = async (key: string): Promise<boolean> => {
  memPhotos.delete(key);
  try {
    await idbOp('readwrite', s => s.delete(key));
    memRemoved.delete(key);
    return true;
  } catch {
    memRemoved.add(key);
    return false;
  }
};
