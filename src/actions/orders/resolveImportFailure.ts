import { action } from '@uibakery/data';

/**
 * Close one open import failure by hand (the operator judged it
 * addressed — or not worth chasing; the note says which). Zero rows =
 * already resolved (possibly auto-resolved by a clean re-import racing
 * this click) — the UI treats that as done, not as an error.
 */
function resolveImportFailure() {
  return action('resolveImportFailure', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE import_failures f
         SET resolved_at = now(),
             resolved_by = {{params.actor}}::text,
             resolution = NULLIF(btrim({{params.resolution}}::text), '')
       WHERE f.id = NULLIF({{params.failure_id}}::text, '')::bigint
         AND f.resolved_at IS NULL
      RETURNING f.id
    `,
  });
}

export default resolveImportFailure;
