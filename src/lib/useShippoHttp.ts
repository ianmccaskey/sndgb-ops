import { useMemo } from 'react';
import { useMutateAction } from '@uibakery/data';
import shippoGet from '@/actions/shippo/shippoGet';
import shippoPost from '@/actions/shippo/shippoPost';

/**
 * Transport pair for the Shippo client: every call executes on UI
 * Bakery's BACKEND through the 'Shippo API' HTTP datasource, so browser
 * CORS can never break it. All Shippo semantics (money discipline,
 * pagination proofs, error taxonomy) stay in src/lib/shippo.ts — this
 * hook only supplies the wire.
 */
export type ShippoHttp = {
  get: (token: string, path: string) => Promise<unknown>;
  post: (token: string, path: string, body: unknown) => Promise<unknown>;
};

export function useShippoHttp(): ShippoHttp {
  const [doGet] = useMutateAction(shippoGet);
  const [doPost] = useMutateAction(shippoPost);
  return useMemo(() => ({
    get: (token: string, path: string) => doGet({ url: path, token }),
    post: (token: string, path: string, body: unknown) => doPost({ url: path, token, body: JSON.stringify(body) }),
  }), [doGet, doPost]);
}
