import { useMemo } from 'react';
import { useMutateAction } from '@uibakery/data';
import claimShipmentEmail from '@/actions/fulfillment/claimShipmentEmail';
import recordShipmentEmailError from '@/actions/fulfillment/recordShipmentEmailError';
import markShipmentEmailUnverified from '@/actions/fulfillment/markShipmentEmailUnverified';
import releaseShipmentEmailClaim from '@/actions/fulfillment/releaseShipmentEmailClaim';
import claimTransferEmail from '@/actions/receiving/claimTransferEmail';
import recordTransferEmailError from '@/actions/receiving/recordTransferEmailError';
import markTransferEmailUnverified from '@/actions/receiving/markTransferEmailUnverified';
import releaseTransferEmailClaim from '@/actions/receiving/releaseTransferEmailClaim';
import { rows, firstRow, dbText } from './rows';
import { shipEmailConfig, sendShipEmail, EmailRefusedError } from './shipEmail';
import { useResendHttp } from './useResendHttp';

/**
 * The claim → send → settle dance, identical for order shipments and
 * direct-ship transfers. Every finalize-success path calls notify*()
 * unconditionally and renders the returned outcome ('' note = nothing
 * to say): the SQL claim decides eligibility (finalized, customer email
 * present, tracking present, no refund activity, not already sent), so
 * call sites carry no email logic.
 *
 * FAILURE TAXONOMY (Codex review, 2026-09-29):
 *  - DEFINITIVE refusal (EmailRefusedError — structured 4xx): nothing
 *    was sent, so the claim is RELEASED (CAS on the exact claim token)
 *    and the row offers a retry.
 *  - AMBIGUOUS failure (everything else): the email may have been
 *    delivered, so the claim is HELD and the row is marked "email
 *    unverified" — releasing it for retry is a deliberate operator act
 *    after checking resend.com/emails, because a blind retry past
 *    Resend's 24h idempotency window could email the customer twice.
 *  - A release/mark write that itself fails is reported in the note:
 *    the row may misread until reloaded, and the operator is told so.
 *
 * TEST-MODE GUARD runs before the claim: a test-key label's tracking is
 * simulated, and a claim without a send would permanently mark the row
 * sent — so in test mode nothing is claimed and nothing is sent.
 *
 * Known crash window, accepted: if the browser dies between claim and
 * send, the row reads "emailed" with no email. Fail-safe in the
 * direction that matters (never a duplicate email to a customer).
 */
type ClaimRow = {
  id: string | number; carrier: string | null; servicelevel: string;
  claimed_at: string; tracking_number: string; email: string; dest_name: string;
  order_number: string;
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
  /** Operator-confirmed release of an UNVERIFIED claim; true = released. */
  releaseShipment: (shipmentId: number) => Promise<boolean>;
  releaseTransfer: (transferId: number) => Promise<boolean>;
};

export function useShipEmailNotify(settings: Record<string, string>, testMode: boolean): ShipEmailNotify {
  const resend = useResendHttp();
  const [doClaimShipment] = useMutateAction(claimShipmentEmail);
  const [doShipmentError] = useMutateAction(recordShipmentEmailError);
  const [doShipmentUnverified] = useMutateAction(markShipmentEmailUnverified);
  const [doShipmentRelease] = useMutateAction(releaseShipmentEmailClaim);
  const [doClaimTransfer] = useMutateAction(claimTransferEmail);
  const [doTransferError] = useMutateAction(recordTransferEmailError);
  const [doTransferUnverified] = useMutateAction(markTransferEmailUnverified);
  const [doTransferRelease] = useMutateAction(releaseTransferEmailClaim);

  return useMemo(() => {
    const cfg = shipEmailConfig(settings);
    const notify = async (
      claim: (p: Record<string, unknown>) => Promise<unknown>,
      recordError: (p: Record<string, unknown>) => Promise<unknown>,
      markUnverified: (p: Record<string, unknown>) => Promise<unknown>,
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
        const msg = (e instanceof Error ? e.message : 'send failed').slice(0, 500);
        if (e instanceof EmailRefusedError) {
          // DEFINITIVE: nothing sent — release the claim (CAS on the
          // token) so the row can retry
          let released = false;
          try {
            released = rows(await recordError({ [idParam]: id, claimed_at: row.claimed_at, error: msg })).length > 0;
          } catch { /* released stays false — reported below */ }
          return {
            ok: false,
            note: released
              ? `Shipment email NOT sent — ${msg} Retry with "Send email" on the row.`
              : `Shipment email NOT sent — ${msg} ALSO: recording the failure did not stick, so the row may wrongly show "emailed" — reload, and release it from the row if the amber state appears.`,
          };
        }
        // AMBIGUOUS: hold the claim, mark unverified — never blind-retry
        let marked = false;
        try {
          marked = rows(await markUnverified({ [idParam]: id, claimed_at: row.claimed_at, error: msg })).length > 0;
        } catch { /* marked stays false — reported below */ }
        return {
          ok: false,
          note: `Shipment email status UNKNOWN — ${msg} It may have been delivered, so the row is held${marked ? ' as "email unverified"' : ' (and marking it unverified ALSO failed — reload to see its real state)'} to prevent a double-send. Check resend.com/emails for ${row.email}, then use "Release & retry" on the row only if no send is listed.`,
        };
      }
    };
    const release = async (act: (p: Record<string, unknown>) => Promise<unknown>, idParam: string, id: number): Promise<boolean> => {
      try {
        return rows(await act({ [idParam]: id })).length > 0;
      } catch {
        return false;
      }
    };
    return {
      enabled: cfg.enabled,
      notifyShipment: (shipmentId: number) => notify(doClaimShipment, doShipmentError, doShipmentUnverified, 'shipment_id', 'shipment', shipmentId),
      notifyTransfer: (transferId: number) => notify(doClaimTransfer, doTransferError, doTransferUnverified, 'transfer_id', 'transfer', transferId),
      releaseShipment: (shipmentId: number) => release(doShipmentRelease, 'shipment_id', shipmentId),
      releaseTransfer: (transferId: number) => release(doTransferRelease, 'transfer_id', transferId),
    };
  }, [settings, testMode, resend, doClaimShipment, doShipmentError, doShipmentUnverified, doShipmentRelease, doClaimTransfer, doTransferError, doTransferUnverified, doTransferRelease]);
}
