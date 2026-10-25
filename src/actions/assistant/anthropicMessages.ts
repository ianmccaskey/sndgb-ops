import { action } from '@uibakery/data';

/**
 * Backend-executed POST to the Claude Messages API through the
 * 'Anthropic API' HTTP datasource (see DATASOURCE.md in this folder).
 * The API key is a header stored ON THE DATASOURCE — it never travels as
 * an action param and never reaches the browser; this action only adds
 * the static protocol headers. params.body is a pre-serialized JSON
 * request (same raw-body pattern as shippoPost): src/lib/assistant.ts
 * builds it and is the only caller.
 *
 * READ-ONLY BY CONSTRUCTION: the assistant's tools are load actions the
 * pages already use plus the Verify button's on-chain lookup; no write
 * action is ever exposed to the model. A proposed fix is applied by the
 * operator's click in the dialog, through the order sheet's own handler.

 */
function anthropicMessages() {
  return action('anthropicMessages', 'HTTP', {
    datasourceName: 'Anthropic API',
    options: {
      method: 'POST',
      url: '/v1/messages',
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'Content-Type': 'application/json',
      },
      bodyType: 'raw',
      body: '{{params.body}}',
    },
  });
}

export default anthropicMessages;
