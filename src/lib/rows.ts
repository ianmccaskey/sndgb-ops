/**
 * Normalize a useLoadAction result for safe iteration.
 *
 * Until an action resolves (or while it is disabled), useLoadAction returns
 * its SECOND argument — the while-loading value — not rows. Every call here
 * passes `[]`, so a load reads as "no rows yet"; the placeholders this helper
 * used to meet (`[null]`, `[groupBuyId]`) were ids passed there as if it were
 * a dependency list. rows() still keeps only object entries (a primitive is
 * never a row) and anything that is not an array becomes `[]`. Route every
 * action result through rows() before iterating, and check the hook's
 * loading flag before reading an empty list as "none".
 */
export function rows<T>(data: unknown): T[] {
  return Array.isArray(data)
    ? (data.filter(x => x != null && typeof x === 'object') as T[])
    : [];
}

/**
 * Strip the SQL-side '#' transport guard from a digit-only text column.
 * Long digit-only values (22-digit USPS tracking numbers) exceed
 * Number.MAX_SAFE_INTEGER, and the platform transport re-types digit-only
 * text as JS numbers — rounding them beyond recovery. Actions prefix such
 * columns with '#' ("'#' || tracking_number") so the value always travels
 * as text; every consumer unwraps with dbText() at the row boundary.
 */
export function dbText(v: unknown): string {
  const s = v == null ? '' : String(v);
  return s.startsWith('#') ? s.slice(1) : s;
}

/** First non-null row, for single-row lookups (detail queries, settings). */
export function firstRow<T>(data: unknown): T | undefined {
  return rows<T>(data)[0];
}
