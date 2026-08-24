/*
 * Minimal RFC-4180 CSV parsing for the Receiving importers: quoted
 * fields, "" escapes, CR/LF/CRLF line ends, BOM stripped, blank lines
 * dropped. FAILS CLOSED on malformed quoting — a stray quote inside an
 * unquoted field, text after a closing quote, or an unclosed quote at
 * EOF returns an error instead of silently shifting data into the
 * wrong columns. No streaming — operator CSVs are small.
 */

export type CsvResult = { rows: string[][]; error: string | null };

export function parseCsv(text: string): CsvResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let quoteClosed = false; // just left a quoted field; only , or EOL may follow
  let line = 1;
  const s = text.replace(/^\uFEFF/, '');

  const endField = () => { row.push(field); field = ''; fieldWasQuoted = false; quoteClosed = false; };
  const endRow = () => {
    endField();
    if (row.some(f => f.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; quoteClosed = true; }
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (quoteClosed && c !== ',' && c !== '\n' && c !== '\r') {
      return { rows: [], error: `line ${line}: unexpected text after a closing quote — fix the quoting and re-parse.` };
    } else if (c === '"') {
      if (field !== '' || fieldWasQuoted) {
        return { rows: [], error: `line ${line}: stray quote inside an unquoted field — quote the whole field (and double any inner quotes).` };
      }
      inQuotes = true; fieldWasQuoted = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
      line++;
    } else {
      field += c;
    }
  }
  if (inQuotes) return { rows: [], error: `line ${line}: unclosed quote at end of input.` };
  endRow();
  return { rows, error: null };
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
