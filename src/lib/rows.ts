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

/** First non-null row, for single-row lookups (detail queries, settings). */
export function firstRow<T>(data: unknown): T | undefined {
  return rows<T>(data)[0];
}
