/**
 * Niimbot B1 label printing over Web Bluetooth (Android Chrome — the
 * operator's phone), via @mmote/niimbluelib. Prints a 50x30mm package
 * label after a scan-confirmed receive.
 *
 * Connection model: ONE module-level client kept connected for the page
 * session. The FIRST print needs a user gesture (the browser's device
 * chooser); later prints reuse the open connection and can run without
 * a gesture (which is what lets auto-print work right after a receive).
 * Any thrown transport error resets the client so the next attempt
 * reconnects cleanly.
 *
 * Label geometry: the B1 head is 384 dots (~48mm at 8 dots/mm); a
 * 50x30mm label prints as a 384x240 canvas, both multiples of 8 as
 * ImageEncoder requires. Print direction "left" matches the B1.
 */
import { NiimbotBluetoothClient, ImageEncoder, LabelType } from '@mmote/niimbluelib';

export type PackageLabelData = {
  tracking: string;
  carrier: string;
  vendor: string | null;
  address: string;
  items: { sku: string; qty: string }[];
  receivedBy: string;
};

let client: NiimbotBluetoothClient | null = null;
let connected = false;

export const niimbotSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'bluetooth' in navigator;

export const niimbotConnected = (): boolean => connected && client != null;

async function ensureClient(): Promise<NiimbotBluetoothClient> {
  if (client && connected) return client;
  const c = new NiimbotBluetoothClient();
  await c.connect();
  await c.fetchPrinterInfo();
  c.on('disconnect', () => { connected = false; client = null; });
  client = c;
  connected = true;
  return c;
}

function drawLabel(d: PackageLabelData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable on this device.');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';

  // header: carrier + vendor + received-by
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(`${d.carrier.toUpperCase()}${d.vendor ? `  ·  ${d.vendor}` : ''}`, 6, 24);
  ctx.font = '18px sans-serif';
  ctx.fillText(`${d.address}  ·  ${new Date().toLocaleDateString()}`, 6, 46);

  // tracking, large; split across two lines when long
  ctx.font = 'bold 26px monospace';
  const t = d.tracking.toUpperCase();
  if (t.length <= 20) {
    ctx.fillText(t, 6, 78);
  } else {
    ctx.fillText(t.slice(0, Math.ceil(t.length / 2)), 6, 76);
    ctx.fillText(t.slice(Math.ceil(t.length / 2)), 6, 102);
  }

  // divider
  ctx.fillRect(6, 112, 372, 2);

  // contents: up to 5 lines, then "+n more"
  ctx.font = '20px sans-serif';
  const lines = d.items.slice(0, 5).map(i => `${i.sku}  x ${i.qty}`);
  if (d.items.length > 5) lines.push(`+ ${d.items.length - 5} more`);
  let y = 136;
  for (const line of lines) {
    ctx.fillText(line, 6, y);
    y += 22;
  }

  return canvas;
}

/**
 * Print one package label. Throws with an operator-readable message on
 * failure; the caller decides whether to surface a retry button.
 */
export async function printPackageLabel(d: PackageLabelData): Promise<void> {
  if (!niimbotSupported()) {
    throw new Error('This browser has no Web Bluetooth — label printing needs Chrome on Android.');
  }
  const canvas = drawLabel(d);
  const encoded = ImageEncoder.encodeCanvas(canvas, 'left');
  let c: NiimbotBluetoothClient;
  try {
    c = await ensureClient();
  } catch (e: unknown) {
    connected = false; client = null;
    const m = e instanceof Error ? e.message : '';
    throw new Error(`Could not connect to the Niimbot (${m || 'chooser cancelled or printer off'}) — turn the B1 on and tap Print again.`);
  }
  const taskType = c.getPrintTaskType() || 'B1';
  const task = c.abstraction.newPrintTask(taskType, {
    totalPages: 1,
    density: 3,
    labelType: LabelType.WithGaps,
  });
  try {
    await task.printInit();
    await task.printPage(encoded, 1);
    await task.waitForFinished();
  } catch (e: unknown) {
    connected = false; client = null;
    const m = e instanceof Error ? e.message : '';
    throw new Error(`Print failed (${m || 'connection lost'}) — check the B1 and tap Print again.`);
  } finally {
    try { await task.printEnd(); } catch { /* connection already gone */ }
  }
}
