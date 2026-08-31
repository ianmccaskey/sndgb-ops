/**
 * Normalize a useLoadAction result for safe iteration.
 *
 * When a load is disabled (`enabled: false`) or still resolving, UI Bakery's
 * useLoadAction can hand back a placeholder like `[null]` instead of an empty
 * array — so `.map`/`.filter` directly on the raw result crashes on the null
 * entry. Route every action result through rows() before iterating.
 */
export function rows<T>(data: unknown): T[] {
  // Placeholders can also be the defaultValue array (e.g. [groupBuyId] → [1])
  // — a primitive is never a row, so require object entries.
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
