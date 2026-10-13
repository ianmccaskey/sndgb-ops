import { action } from '@uibakery/data';

/**
 * Durable record of one failed import row, written by the runner the
 * moment the row fails so the failure survives the next pull and a
 * reload (the in-memory results do neither). ONE open row per
 * (campaign, order): a repeat failure refreshes the open row — latest
 * message wins, seen_count ticks — instead of stacking duplicates.
 * The partial unique index arbitrates two admins' concurrent runs; the
 * loser's INSERT turns into the UPDATE via ON CONFLICT on it. Recording
 * is advisory: the runner never lets a failed record break the run.
 */
function recordImportFailure() {
  return action('recordImportFailure', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO import_failures (group_buy_id, order_number, message)
      SELECT NULLIF({{params.group_buy_id}}::text, '')::bigint,
             {{params.order_number}}::text,
             {{params.message}}::text
      WHERE NULLIF({{params.group_buy_id}}::text, '') IS NOT NULL
        AND btrim({{params.order_number}}::text) <> ''
        AND btrim({{params.message}}::text) <> ''
      ON CONFLICT (group_buy_id, order_number) WHERE resolved_at IS NULL
      DO UPDATE SET message = EXCLUDED.message,
                    last_seen_at = now(),
                    seen_count = import_failures.seen_count + 1
      RETURNING id
    `,
  });
}

export default recordImportFailure;
