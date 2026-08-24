/*
 * Minimal RFC-4180-ish CSV parsing for the Receiving importers: quoted
 * fields, "" escapes, CR/LF/CRLF line ends, BOM stripped, blank lines
 * dropped. No streaming — operator CSVs are small.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * Find a column by any of several header spellings — matching ignores
 * case, spaces, underscores, and dashes ("Tracking Number" ==
 * tracking_number == trackingnumber). Returns -1 when absent.
 */
export function headerIndex(headers: string[], names: string[]): number {
  const norm = headers.map(h => h.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  for (const n of names) {
    const i = norm.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}
