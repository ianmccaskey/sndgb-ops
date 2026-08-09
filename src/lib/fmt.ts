/** Shared display formatting for money, counts, and dates. */

export function fmtUSD(v: unknown, opts: { cents?: boolean } = {}): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (isNaN(n)) return '$0';
  const digits = opts.cents === false ? 0 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtNum(v: unknown): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return isNaN(n) ? '0' : n.toLocaleString('en-US');
}

export function fmtDate(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Parse a sheet-style money string ("$5,310.00", "-$47,890.67") to a number. */
export function parseMoney(v: string | null | undefined): number {
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return isNaN(n) ? 0 : n;
}
