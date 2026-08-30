/**
 * Compress a camera/gallery image for shipment-photo storage: downscale to
 * a bounded long edge and re-encode as JPEG, stepping quality down until
 * the data URL fits comfortably under the server's 1.5MB row cap. Returns
 * a data:image/jpeg;base64 URL. Throws an operator-readable Error for
 * non-images or images that will not compress under the cap (extremely
 * rare — a 1600px JPEG at quality 0.5 is far smaller).
 */
const MAX_EDGE = 1600;
const THUMB_EDGE = 240;
const TARGET_BYTES = 900_000;         // data-URL length target (~675KB binary)
const QUALITIES = [0.8, 0.7, 0.6, 0.5];
// the server hard-refuses thumb_data over 80,000 chars; stay safely under
const THUMB_TARGET = 79_000;
const THUMB_QUALITIES = [0.7, 0.5, 0.35, 0.2];

export type CapturedPhoto = { full: string; thumb: string };

const drawScaled = (bitmap: ImageBitmap, maxEdge: number): HTMLCanvasElement => {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image processing is unavailable in this browser.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
};

export async function compressImageToDataUrl(file: File): Promise<CapturedPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`"${file.name}" is not an image.`);
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`Could not read "${file.name}" as an image.`);
  try {
    const canvas = drawScaled(bitmap, MAX_EDGE);
    // the small thumbnail rides in list views; the full image loads only
    // on demand when enlarged. Ratchet its quality down until it honors
    // the server's 80KB cap — a high-entropy shot can otherwise breach it
    // and surface as an undiagnosable refusal
    const thumbCanvas = drawScaled(bitmap, THUMB_EDGE);
    let thumb = '';
    for (const q of THUMB_QUALITIES) {
      thumb = thumbCanvas.toDataURL('image/jpeg', q);
      if (thumb.length <= THUMB_TARGET) break;
    }
    if (thumb.length > THUMB_TARGET) {
      throw new Error(`"${file.name}": the preview thumbnail would not compress small enough — try a simpler shot.`);
    }
    for (const q of QUALITIES) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= TARGET_BYTES) return { full: url, thumb };
    }
    const last = canvas.toDataURL('image/jpeg', 0.4);
    if (last.length <= 1_400_000) return { full: last, thumb };
    throw new Error(`"${file.name}" would not compress small enough — try a closer, simpler shot.`);
  } finally {
    bitmap.close();
  }
}
