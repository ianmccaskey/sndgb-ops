import { action } from '@uibakery/data';

/**
 * Backend-executed POST against api.goshippo.com (see shippoGet for the
 * CORS rationale). params.body is a pre-serialized JSON string — the
 * caller controls exactly what Shippo receives. ONE action invocation is
 * ONE backend request: the money discipline (single-attempt purchases,
 * poll-by-GET) lives in src/lib/shippo.ts, which never invokes this
 * twice for the same purchase.
 */
function shippoPost() {
  return action('shippoPost', 'HTTP', {
    datasourceName: 'Shippo API',
    options: {
      method: 'POST',
      url: '{{params.url}}',
      headers: {
        Authorization: 'ShippoToken {{params.token}}',
        'Content-Type': 'application/json',
      },
      bodyType: 'raw',
      body: '{{params.body}}',
    },
  });
}

export default shippoPost;
