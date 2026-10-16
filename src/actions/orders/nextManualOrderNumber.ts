import { action } from '@uibakery/data';

/**
 * The next free MANUAL order number for a campaign — what the Add order
 * dialog prefills. Manual orders exist only in this app (never in base44 or
 * the storefront), so their numbers must be ones NO upstream can mint:
 *
 *   <campaign prefix>-X<NNN>      e.g. 2026-MB5-X001, 2026-X001
 *
 * Every upstream number ends in a digits-only segment (base44 mints
 * YYYY-CODE-NNN or YYYY-NNN; the storefront mints YYYY-CODE-NNN with a
 * [A-Z0-9]{2,8} code), so a last segment of 'X' + digits can never collide
 * with a pulled or pasted row, and the registry (1790100300) keeps it unique
 * across both writers.
 *
 * The prefix is DERIVED from the campaign's own upstream numbers (everything
 * before the last hyphen of its most common shape), so a manual order reads
 * as part of the campaign; a campaign with no upstream orders yet falls back
 * to the current year. The counter runs over the registry (both writers,
 * every campaign) so a number is never offered twice. createManualOrder
 * re-derives the prefix and refuses any number that does not match.
 */
function nextManualOrderNumber() {
  return action('nextManualOrderNumber', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH shape AS (
        SELECT regexp_replace(o.order_number, '-[^-]*$', '') AS prefix, count(*) AS n
        FROM orders o
        WHERE o.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
          AND COALESCE(o.raw_import->>'source', '') <> 'manual'
          AND regexp_replace(o.order_number, '-[^-]*$', '') ~ '^[0-9]{4}(-[A-Z0-9]{2,8})?$'
        GROUP BY 1
        ORDER BY n DESC, 1
        LIMIT 1
      ), pfx AS (
        SELECT COALESCE((SELECT prefix FROM shape), to_char(now(), 'YYYY')) AS prefix
      ), taken AS (
        SELECT COALESCE(max(substring(r.order_number from '-X([0-9]+)$')::int), 0) AS last_n
        FROM order_number_registry r, pfx
        WHERE r.order_number LIKE pfx.prefix || '-X%'
          AND r.order_number ~ '-X[0-9]+$'
      )
      SELECT pfx.prefix,
             pfx.prefix || '-X' || lpad((taken.last_n + 1)::text, 3, '0') AS order_number
      FROM pfx, taken
    `,
  });
}

export default nextManualOrderNumber;
