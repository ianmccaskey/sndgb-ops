import { action } from '@uibakery/data';

/**
 * Backend-executed POST against api.resend.com through the 'Resend API'
 * HTTP datasource (Resend blocks browser CORS, same situation as Shippo
 * — see DATASOURCE.md in this folder). params.body is a pre-serialized
 * JSON string. params.idem is Resend's Idempotency-Key: they store keys
 * for 24h and return the FIRST send's result for a repeat, so a retried
 * request can never deliver the same shipment email twice even if the
 * DB-side claim were somehow re-won inside that window.
 */
function resendPost() {
  return action('resendPost', 'HTTP', {
    datasourceName: 'Resend API',
    options: {
      method: 'POST',
      url: '{{params.url}}',
      headers: {
        Authorization: 'Bearer {{params.token}}',
        'Content-Type': 'application/json',
        'Idempotency-Key': '{{params.idem}}',
      },
      bodyType: 'raw',
      body: '{{params.body}}',
    },
  });
}

export default resendPost;
