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
const ORDER_INDEX = 'by_order';
const LEGACY_KEY = 'sndgb.pendingShipPhotos';

let dbPromise: Promise<IDBDatabase> | null = null;
const openDb = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          const store = db.objectStoreNames.contains(STORE)
            ? req.transaction!.objectStore(STORE)
            : db.createObjectStore(STORE, { keyPath: 'key' });
          // order-scoped reads: the hot path must scale with the order
          // being worked, never with the device's total photo backlog
          if (!store.indexNames.contains(ORDER_INDEX)) store.createIndex(ORDER_INDEX, 'order_id');
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

// Resolves on the TRANSACTION's oncomplete, never on the request's
// onsuccess: an IndexedDB request can succeed and its transaction still
// abort later (quota pressure, late errors). Durability is only real at
// commit, and every guarantee in the photo flow rides on this boolean.
const idbOp = <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  openDb().then(db => new Promise<T>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, mode);
      let result: T;
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('idb transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('idb transaction error'));
    } catch (e) { reject(e); }
  }));

// page-lifetime fallback when IndexedDB is unavailable: newest state per
// key plus removal tombstones, merged into every read
const memPhotos = new Map<string, StashedPhoto>();
const memRemoved = new Set<string>();

// one-time import of entries stashed by the old localStorage versions.
// Earlier stash shapes lacked key/actor/recovered — synthesize what is
// missing rather than dropping what may be the only copy of a capture;
// only rows with no image payload at all are skipped (warned, nothing
// recoverable in them).
let legacyImported = false;
const importLegacy = async (): Promise<void> => {
  if (legacyImported) return;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) { legacyImported = true; return; }
    const items = JSON.parse(raw) as Partial<StashedPhoto>[];
    let skipped = 0;
    const entries: StashedPhoto[] = [];
    items.forEach((i, idx) => {
      if (!i || typeof i.full !== 'string' || typeof i.thumb !== 'string' || typeof i.order_id !== 'number') { skipped += 1; return; }
      entries.push({
        full: i.full,
        thumb: i.thumb,
        shipment_id: typeof i.shipment_id === 'number' ? i.shipment_id : null,
        order_id: i.order_id,
        ts: typeof i.ts === 'number' ? i.ts : 0,
        actor: typeof i.actor === 'string' ? i.actor : '', // '' -> callers fall back to the current user
        // DETERMINISTIC key for keyless rows: a retry after a partial
        // import overwrites the same records instead of duplicating them
        // (the legacy snapshot is never rewritten by current code)
        key: typeof i.key === 'string' ? i.key : `legacy-${idx}-${i.order_id}`,
        recovered: i.recovered === true,
      });
    });
    if (skipped > 0) console.warn(`photoStash: skipped ${skipped} malformed legacy stash record(s) with no image payload`);
    try {
      for (const e of entries) {
        if (memRemoved.has(e.key)) continue; // discarded while memory-overlaid: do not resurrect
        await idbOp('readwrite', s => s.put(e));
        memPhotos.delete(e.key);
      }
      localStorage.removeItem(LEGACY_KEY);
      legacyImported = true;
    } catch {
      // IndexedDB unavailable or aborted partway: keep the legacy key for
      // the next attempt, and surface every row through the memory
      // overlay so pre-upgrade saved photos stay VISIBLE in the recovery
      // UIs instead of silently disappearing
      for (const e of entries) {
        if (!memPhotos.has(e.key) && !memRemoved.has(e.key)) memPhotos.set(e.key, e);
      }
    }
  } catch {
    legacyImported = true; // unparseable JSON: nothing recoverable; do not loop
    console.warn('photoStash: legacy stash was unreadable and was left in place');
  }
};

// readOk=false means the DURABLE store could not be read: photos saved
// earlier may exist but be invisible. Callers must warn rather than
// present an empty recovery UI as "no saved photos". Reads are
// ORDER-SCOPED via the by_order index — only the active order's rows
// (each holding a multi-hundred-KB full image) ever materialize.
export type StashReadResult = { photos: StashedPhoto[]; readOk: boolean };
export const readStash = async (orderId: number): Promise<StashReadResult> => {
  await importLegacy();
  let persisted: StashedPhoto[] = [];
  let readOk = true;
  try {
    persisted = await idbOp('readonly', s =>
      s.index(ORDER_INDEX).getAll(IDBKeyRange.only(orderId)) as IDBRequest<StashedPhoto[]>);
  } catch { persisted = []; readOk = false; }
  const merged = new Map<string, StashedPhoto>();
  for (const p of persisted) if (!memRemoved.has(p.key)) merged.set(p.key, p);
  for (const [k, v] of memPhotos) if (v.order_id === orderId) merged.set(k, v);
  return { photos: [...merged.values()], readOk };
};

// Re-read ONE entry by key — the guard callers run immediately before
// binding/uploading, so a stale snapshot cannot override a newer
// discard or reclassification made in another tab. null = the entry no
// longer exists (or the durable store cannot confirm it) — abort.
export const stashGet = async (key: string): Promise<StashedPhoto | null> => {
  if (memRemoved.has(key)) return null;
  const mem = memPhotos.get(key);
  if (mem) return mem;
  try {
    const row = await idbOp('readonly', s => s.get(key) as IDBRequest<StashedPhoto | undefined>);
    return row ?? null;
  } catch { return null; }
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
