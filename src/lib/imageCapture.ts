/**
 * Compress a camera/gallery image for shipment-photo storage: downscale to
 * a bounded long edge and re-encode as JPEG, stepping quality down until
 * the data URL fits comfortably under the server's 1.5MB row cap. Returns
 * a data:image/jpeg;base64 URL. Throws an operator-readable Error for
 * non-images or images that will not compress under the cap (extremely
 * rare — a 1600px JPEG at quality 0.5 is far smaller).
 */
const MAX_EDGE = 1600;
const TARGET_BYTES = 900_000;         // data-URL length target (~675KB binary)
const QUALITIES = [0.8, 0.7, 0.6, 0.5];

export async function compressImageToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`"${file.name}" is not an image.`);
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`Could not read "${file.name}" as an image.`);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image processing is unavailable in this browser.');
    ctx.drawImage(bitmap, 0, 0, w, h);
    for (const q of QUALITIES) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= TARGET_BYTES) return url;
    }
    const last = canvas.toDataURL('image/jpeg', 0.4);
    if (last.length <= 1_400_000) return last;
    throw new Error(`"${file.name}" would not compress small enough — try a closer, simpler shot.`);
  } finally {
    bitmap.close();
  }
}
