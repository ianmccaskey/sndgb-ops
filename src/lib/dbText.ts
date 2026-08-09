/**
 * The datasource's "parse numeric values" option converts any digit-only
 * string (tracking numbers, leading-zero ZIPs) into a JS float, destroying
 * it (e.g. 24-digit USPS tracking → 4.23e+23). Actions guard such TEXT
 * columns by prefixing '#' in the SELECT; this strips the guard for
 * display/copy. Safe on unguarded values.
 */
export function dbText(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return s.startsWith('#') ? s.slice(1) : s;
}
