/**
 * Block-explorer transaction URLs per payment rail. Mirrors the chains the
 * parser recognizes (see parseOrderImport EXPLORER). Returns null for rails
 * with no public explorer (cash / Zelle / Venmo / PayPal / other).
 */
export function txExplorerUrl(method: string | null | undefined, hash: string | null | undefined): string | null {
  const h = (hash || '').trim();
  if (!h) return null;
  switch ((method || '').toLowerCase()) {
    case 'eth': return `https://etherscan.io/tx/${h}`;
    case 'base': return `https://basescan.org/tx/${h}`;
    case 'sol': return `https://solscan.io/tx/${h}`;
    default: return null;
  }
}

/** Compact middle-truncation for display, e.g. 0x1234abcd…9f8e7d6c. */
export function shortHash(hash: string | null | undefined, lead = 10, tail = 8): string {
  const h = (hash || '').trim();
  if (h.length <= lead + tail + 1) return h;
  return `${h.slice(0, lead)}…${h.slice(-tail)}`;
}
