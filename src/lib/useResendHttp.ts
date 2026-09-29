import { useMemo } from 'react';
import { useMutateAction } from '@uibakery/data';
import resendPost from '@/actions/resend/resendPost';

/**
 * Transport for the shipment-email sender: every call executes on UI
 * Bakery's BACKEND through the 'Resend API' HTTP datasource (Resend has
 * no browser CORS). All email semantics (claim discipline, payload
 * shape, error sanitizing) stay in src/lib/shipEmail.ts — this hook only
 * supplies the wire.
 */
export type ResendHttp = {
  post: (token: string, path: string, body: unknown, idem: string) => Promise<unknown>;
};

export function useResendHttp(): ResendHttp {
  const [doPost] = useMutateAction(resendPost);
  return useMemo(() => ({
    post: (token: string, path: string, body: unknown, idem: string) =>
      doPost({ url: path, token, body: JSON.stringify(body), idem }),
  }), [doPost]);
}
