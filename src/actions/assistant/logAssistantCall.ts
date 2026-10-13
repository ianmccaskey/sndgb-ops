import { action } from '@uibakery/data';

/**
 * One audit row per assistant question, under the operator who asked, so
 * the assistant's reads leave the same trail as every other action. The
 * scope is the row the question was about: an order ('orders', order id)
 * or a campaign ('group_buys', campaign id, for import triage). Any other
 * scope writes nothing — the allowlist is in the query, not the caller.
 * detail = { question, model, usage, tools } — never the answer text and
 * never member data (the facts sent to the model carry none).
 */
function logAssistantCall() {
  return action('logAssistantCall', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.scope}}::text, '') AS scope,
               NULLIF({{params.row_pk}}::text, '') AS row_pk,
               NULLIF({{params.actor}}::text, '') AS actor,
               NULLIF({{params.detail}}::text, '')::jsonb AS detail
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT inp.scope, inp.row_pk, 'assistant_asked', inp.actor, inp.detail
      FROM inp
      WHERE inp.scope IN ('orders', 'group_buys')
        AND inp.row_pk IS NOT NULL AND inp.actor IS NOT NULL AND inp.detail IS NOT NULL
      RETURNING id
    `,
  });
}

export default logAssistantCall;
