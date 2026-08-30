import { HTMLCanvasElementLuminanceSource } from '@zxing/browser';
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader } from '@zxing/library';

/*
 * Carrier-label scanning: decode the tracking barcode from a phone photo
 * of a shipping label, fully client-side (zxing — no network, no keys).
 *
 * Every major carrier prints the tracking number as a Code 128 barcode
 * (USPS IMpb is GS1-128, which IS Code 128; older FedEx ground used
 * ITF). The photo is tried at two scales and two rotations — labels get
 * photographed sideways — and TRY_HARDER covers mirrored/low-contrast
 * lines. Decoding a still is deliberate (no live viewfinder): it rides
 * the same capture="environment" input as package photos and works
 * identically on iPhone and Android.
 *
 * Barcode payloads are NOT always the bare tracking number: USPS IMpb
 * prefixes a routing "420" + 5- or 9-digit ZIP; FedEx encodes a long
 * form whose SUFFIX is the public tracking number. So matching works on
 * alphanumeric fingerprints with prefix-stripped candidates and
 * bounded suffix comparison, against numbers the app already stores
 * canonically (UPPER, trimmed).
 */

const drawScaledRotated = (bitmap: ImageBitmap, maxEdge: number, rotateDeg: 0 | 90): HTMLCanvasElement => {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  if (rotateDeg === 90) { canvas.width = h; canvas.height = w; } else { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image processing is unavailable in this browser.');
  if (rotateDeg === 90) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
};

/**
 * ALL distinct barcode texts found in the photo (empty = none found).
 * Carrier labels routinely carry SEVERAL Code 128 barcodes (routing,
 * service, tracking), so every image variant runs a MULTI-barcode
 * decode and every variant is scanned — no early stop that could lock
 * onto a routing barcode and never see the tracking one.
 */
export async function decodeCarrierLabel(file: File): Promise<string[]> {
  if (!file.type.startsWith('image/')) throw new Error(`"${file.name}" is not an image.`);
  // decoding runs on the main thread (no worker in this stack), so the
  // workload is bounded end to end: the WALL-CLOCK budget starts BEFORE
  // the image load, large captures are resize-bounded DURING decode
  // (createImageBitmap resize options — a 48MP phone photo never fully
  // rasterizes; engines without the options fall back to a plain load),
  // canvases cap at <=2000px, and the search loop YIELDS between passes
  // so the page keeps painting instead of freezing in one long task
  const DEADLINE_MS = 4000;
  const started = performance.now();
  const overBudget = () => performance.now() - started > DEADLINE_MS;
  const yieldToUi = () => new Promise<void>(r => setTimeout(r, 0));
  const bitmap = await (file.size > 1_500_000
    ? createImageBitmap(file, { resizeWidth: 2000, resizeQuality: 'high' }).catch(() => createImageBitmap(file))
    : createImageBitmap(file)
  ).catch(() => null);
  if (!bitmap) throw new Error(`Could not read "${file.name}" as an image.`);
  try {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.ITF]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new MultiFormatReader();
    const texts = new Set<string>();
    for (const maxEdge of [2000, 1200]) {
      for (const rot of [0, 90] as const) {
        if (overBudget()) return [...texts];
        const canvas = drawScaledRotated(bitmap, maxEdge, rot);
        // mask-and-rescan: after each decode, blank the found barcode and
        // scan again so a routing/service barcode cannot shadow the
        // tracking one. 1D result points are SPARSE ENDPOINTS (not a
        // bounding box), so the mask is a FULL-WIDTH stripe around the
        // scanline with escalating height — and a repeated read does not
        // burn the budget: it widens the stripe and tries again, bailing
        // only when masking clearly is not biting.
        const seenHere = new Set<string>();
        let repeats = 0;
        for (let pass = 0; pass < 8; pass++) {
          if (overBudget()) return [...texts];
          await yieldToUi();
          try {
            const bb = new BinaryBitmap(new HybridBinarizer(new HTMLCanvasElementLuminanceSource(canvas)));
            const res = reader.decode(bb, hints);
            const t = res.getText().trim();
            if (t && seenHere.has(t)) repeats += 1;
            else if (t) { seenHere.add(t); texts.add(t); repeats = 0; }
            if (repeats >= 2) break; // stripe not covering it; stop spinning
            const pts = res.getResultPoints() || [];
            if (pts.length === 0) break;
            const ys = pts.map(p => p.getY());
            const ctx = canvas.getContext('2d');
            if (!ctx) break;
            ctx.fillStyle = '#ffffff';
            const pad = 100 * (repeats + 1);
            const y0 = Math.max(0, Math.min(...ys) - pad);
            const y1 = Math.min(canvas.height, Math.max(...ys) + pad);
            ctx.fillRect(0, y0, canvas.width, y1 - y0);
          } catch { break; /* nothing further in this variant */ }
        }
      }
    }
    return [...texts];
  } finally {
    bitmap.close();
  }
}

const fingerprint = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Candidate tracking fingerprints for one decoded barcode payload. */
export const trackingCandidates = (raw: string): string[] => {
  const fp = fingerprint(raw);
  const out = new Set<string>();
  if (fp.length >= 8) out.add(fp);
  // USPS IMpb / GS1: routing application identifier "420" + ZIP5 or
  // ZIP+4 precedes the tracking, with NO delimiter in the digit string —
  // a greedy ZIP+4 strip would eat the first 4 tracking digits on the
  // (very common) ZIP5 labels, so BOTH strip depths become candidates
  // and exact matching against the stored number decides
  if (fp.startsWith('420')) {
    for (const zipLen of [5, 9] as const) {
      const rest = fp.slice(3 + zipLen);
      if (rest.length >= 8 && /^\d+$/.test(fp.slice(3, 3 + zipLen))) out.add(rest);
    }
  }
  return [...out];
};

/**
 * How does a decoded candidate set relate to a STORED tracking number?
 * 'exact' = a candidate fingerprint equals the stored fingerprint — the
 * only grade strong enough to AUTO-receive. 'suffix' = the scan carries
 * the stored number as a suffix or vice versa (FedEx long forms, partial
 * reads) — surfaced as a likely match for the operator to act on from
 * the card, never auto-received. null = no relation.
 */
export type TrackingMatchKind = 'exact' | 'suffix';
export const matchTracking = (candidates: string[], stored: string): TrackingMatchKind | null => {
  const t = fingerprint(stored);
  if (t.length < 8) return null;
  if (candidates.some(c => c === t)) return 'exact';
  if (candidates.some(c => c.endsWith(t) || (c.length >= 12 && t.endsWith(c)))) return 'suffix';
  return null;
};

/**
 * Structural carrier inference from a candidate: UPS numbers start 1Z
 * (unmistakable); USPS-style IMpb numbers are 9[2-5] + 19-25 more
 * digits (DHL eCommerce final-mile uses the same GS1 shape, so both
 * carriers are compatible). null = shape proves nothing.
 */
export const candidateCarrier = (c: string): 'ups' | 'usps_like' | null =>
  c.startsWith('1Z') ? 'ups' : /^9[2-5]\d{19,25}$/.test(c) ? 'usps_like' : null;

/** Is a stored package's carrier compatible with an inferred shape? */
export const carrierCompatible = (inferred: 'ups' | 'usps_like' | null, storedCarrier: string): boolean =>
  inferred == null ? true
    : inferred === 'ups' ? storedCarrier === 'ups'
    : storedCarrier === 'usps' || storedCarrier === 'dhl_ecommerce';
