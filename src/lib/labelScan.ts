import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

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

/** All distinct barcode texts found in the photo (empty = none found). */
export async function decodeCarrierLabel(file: File): Promise<string[]> {
  if (!file.type.startsWith('image/')) throw new Error(`"${file.name}" is not an image.`);
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`Could not read "${file.name}" as an image.`);
  try {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.ITF]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);
    const texts = new Set<string>();
    for (const maxEdge of [2000, 1200]) {
      for (const rot of [0, 90] as const) {
        try {
          const res = reader.decodeFromCanvas(drawScaledRotated(bitmap, maxEdge, rot));
          const t = res.getText().trim();
          if (t) texts.add(t);
        } catch { /* no barcode in this variant — try the next */ }
      }
      if (texts.size > 0) break; // full resolution decoded; skip downscale
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
  // USPS IMpb / GS1: routing application identifier "420" + ZIP precedes
  // the tracking; the tracking itself is what the label prints
  const zip = fp.match(/^420\d{9}/) || fp.match(/^420\d{5}/);
  if (zip) {
    const rest = fp.slice(zip[0].length);
    if (rest.length >= 8) out.add(rest);
  }
  return [...out];
};

/**
 * Does a decoded candidate set match a STORED tracking number? Exact
 * fingerprint match, or the scan carries the stored number as a suffix
 * (FedEx long form / IMpb with prefix uncovered), or — for long scans
 * only — the stored number carries the scan as a suffix.
 */
export const matchesTracking = (candidates: string[], stored: string): boolean => {
  const t = fingerprint(stored);
  if (t.length < 8) return false;
  return candidates.some(c => c === t || c.endsWith(t) || (c.length >= 12 && t.endsWith(c)));
};
