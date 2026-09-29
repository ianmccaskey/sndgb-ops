import { useMemo } from 'react';
import { useMutateAction } from '@uibakery/data';
import claimShipmentEmail from '@/actions/fulfillment/claimShipmentEmail';
import recordShipmentEmailError from '@/actions/fulfillment/recordShipmentEmailError';
import claimTransferEmail from '@/actions/receiving/claimTransferEmail';
import recordTransferEmailError from '@/actions/receiving/recordTransferEmailError';
import { firstRow, dbText } from './rows';
import { shipEmailConfig, sendShipEmail } from './shipEmail';
import { useResendHttp } from './useResendHttp';

/**
 * The claim → send → release dance, identical for order shipments and
 * direct-ship transfers. Every finalize-success path calls notify*()
 * unconditionally and appends the returned outcome line ('' = nothing to
 * say): the SQL claim decides eligibility (finalized, customer email
 * present, tracking present, no refund activity, not already sent), so
 * call sites carry no email logic.
 *
 * TEST-MODE GUARD runs before the claim: a test-key label's tracking is
 * simulated, and a claim without a send would permanently mark the row
 * sent — so in test mode nothing is claimed and nothing is sent.
 *
 * Known crash window, accepted: if the browser dies between claim and
 * send, the row reads "sent" with no email. Fail-safe in the direction
 * that matters (never a duplicate email to a customer), and the next
 * tracking touch-point (the Shipped tab) shows the box anyway.
 */
type ClaimRow = {
  id: string | number; carrier: string | null; servicelevel: string;
  tracking_number: string; email: string; dest_name: string; order_number: string;
  items: { sku: string; name: string | null; qty: string | number }[] | null;
};

/** ok distinguishes "good news" from "needs attention" so call sites can
 * color the note correctly — a sent confirmation must never render in
 * the failure channel's rose/amber. note '' = nothing to show. */
export type NotifyOutcome = { ok: boolean; note: string };

export type ShipEmailNotify = {
  enabled: boolean;
  notifyShipment: (shipmentId: number) => Promise<NotifyOutcome>;
  notifyTransfer: (transferId: number) => Promise<NotifyOutcome>;
};

export function useShipEmailNotify(settings: Record<string, string>, testMode: boolean): ShipEmailNotify {
  const resend = useResendHttp();
  const [doClaimShipment] = useMutateAction(claimShipmentEmail);
  const [doShipmentError] = useMutateAction(recordShipmentEmailError);
  const [doClaimTransfer] = useMutateAction(claimTransferEmail);
  const [doTransferError] = useMutateAction(recordTransferEmailError);

  return useMemo(() => {
    const cfg = shipEmailConfig(settings);
    const notify = async (
      claim: (p: Record<string, unknown>) => Promise<unknown>,
      recordError: (p: Record<string, unknown>) => Promise<unknown>,
      idParam: string, idemPrefix: string, id: number,
    ): Promise<NotifyOutcome> => {
      if (!cfg.enabled || testMode) return { ok: true, note: '' };
      let row: ClaimRow | undefined;
      try {
        row = firstRow<ClaimRow>(await claim({ [idParam]: id }));
      } catch {
        // ambiguous: the claim may or may not have committed. Say so —
        // a silent '' would hide a shipment whose email needs a look.
        return { ok: false, note: 'Shipment email status UNKNOWN — the send claim did not confirm. Check this row after reloading; if it shows neither sent nor an error, it was not sent.' };
      }
      if (!row) return { ok: true, note: '' };
      try {
        await sendShipEmail(resend, cfg, {
          to: row.email, name: row.dest_name, orderNumber: dbText(row.order_number),
          carrier: dbText(row.carrier), servicelevel: row.servicelevel,
          tracking: dbText(row.tracking_number),
          // Number() strips NUMERIC's trailing decimals (2.00 → 2) so the
          // customer never reads "× 2.00"
          items: (row.items || []).map(i => ({ sku: i.sku, name: String(i.name || ''), qty: String(Number(i.qty)) })),
        }, `${idemPrefix}-${id}`);
        return { ok: true, note: `Shipment email sent to ${row.email}.` };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'send failed';
        await recordError({ [idParam]: id, error: msg.slice(0, 500) }).catch(() => null);
        return { ok: false, note: `Shipment email NOT sent — ${msg} Retry with "Send email" on the row.` };
      }
    };
    return {
      enabled: cfg.enabled,
      notifyShipment: (shipmentId: number) => notify(doClaimShipment, doShipmentError, 'shipment_id', 'shipment', shipmentId),
      notifyTransfer: (transferId: number) => notify(doClaimTransfer, doTransferError, 'transfer_id', 'transfer', transferId),
    };
  }, [settings, testMode, resend, doClaimShipment, doShipmentError, doClaimTransfer, doTransferError]);
}
