/**
 * Niimbot B1 label printing — via the PRINTER HELPER PAGE, not in-app.
 *
 * The app runs inside UI Bakery's cross-origin iframe whose permissions
 * policy does NOT grant Web Bluetooth ("Access to the feature
 * 'bluetooth' is disallowed by permissions policy"), so the printer can
 * never be reached from this page. Instead, the Print button opens a
 * tiny static helper page (hosted on the repo's GitHub Pages) as a
 * POPUP — a top-level window where Web Bluetooth is allowed. The label
 * payload travels in the URL FRAGMENT, which is never sent to any
 * server: no package data leaves the phone.
 *
 * The helper (docs/printer/index.html) draws the 50x30 label, connects
 * to the B1 (first use: Chrome's device chooser; afterwards Chrome's
 * persisted grant lets it auto-connect and print with no taps), prints,
 * and closes itself.
 */
export type PackageLabelData = {
  tracking: string;
  carrier: string;
  vendor: string | null;
  address: string;
  items: { sku: string; qty: string }[];
  receivedBy: string;
};

const PRINTER_PAGE_URL = 'https://ianmccaskey.github.io/sndgb-ops/printer/';

export const niimbotSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'bluetooth' in navigator;

/** Open the printer popup for one label. Returns false when the popup
 * was blocked (the caller tells the operator to allow popups). Must be
 * called from a user gesture. */
export function openPrinterPage(d: PackageLabelData): boolean {
  const payload = { ...d, date: new Date().toLocaleDateString() };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const w = window.open(`${PRINTER_PAGE_URL}#${b64}`, '_blank');
  return w != null;
}
