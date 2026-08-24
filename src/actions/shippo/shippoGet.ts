import { action } from '@uibakery/data';

/**
 * Backend-executed GET against api.goshippo.com — the 'Shippo API' HTTP
 * datasource holds the base URL and UI Bakery's SERVER makes the request,
 * so browser CORS cannot break it (Shippo dropped browser-direct API
 * calls in 2026-08 by removing Access-Control-Allow-Headers from its
 * preflight responses). params.url is a RELATIVE path+query; params.token
 * is the operator's Shippo key from Settings (client-supplied under the
 * app's accepted trust model, exactly as it was when the browser called
 * Shippo directly).
 */
function shippoGet() {
  return action('shippoGet', 'HTTP', {
    datasourceName: 'Shippo API',
    options: {
      method: 'GET',
      url: '{{params.url}}',
      headers: { Authorization: 'ShippoToken {{params.token}}' },
    },
  });
}

export default shippoGet;
