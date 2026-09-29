import type { ResendHttp } from './useResendHttp';
import { trackingUrl } from './trackingUrl';

/*
 * The app's own "your order has shipped" email, sent via Resend at label
 * finalize. Exists because Shippo's dashboard notification toggle never
 * fires for API-purchased labels (no Order objects → empty Orders tab →
 * no notifications), verified 2026-09.
 *
 * SEND DISCIPLINE:
 *  - The DB row (shipments/transfers.tracking_email_sent_at) is the
 *    CLAIM: callers must win the claim action's CAS before calling
 *    sendShipEmail, so recovery paths re-running a finalize can never
 *    email a customer twice.
 *  - Belt on top of that claim: every send carries a Resend
 *    Idempotency-Key derived from the row's identity — Resend stores
 *    keys 24h and replays the first result for a repeat.
 *  - ONE attempt per claim, no retry loop here: a failure releases the
 *    claim (recordEmailError) and the operator retries from the UI. An
 *    ambiguous failure at worst re-sends a duplicate "shipped" notice —
 *    annoying, not money — so this path needs none of the Shippo
 *    purchase machinery.
 */

export type ShipEmailConfig = { key: string; from: string; replyTo: string; enabled: boolean };

/** Feature switch = both a Resend key and a from-address are configured. */
export function shipEmailConfig(settings: Record<string, string>): ShipEmailConfig {
  const key = (settings.resend_api_key || '').trim();
  const from = (settings.ship_email_from || '').trim();
  return { key, from, replyTo: (settings.ship_email_reply_to || '').trim(), enabled: !!key && !!from };
}

export type ShipEmailPayload = {
  to: string;
  name: string;              // recipient's name from the label destination
  orderNumber: string;       // customer-facing order number
  carrier: string;
  servicelevel: string;
  tracking: string;
  // name is what the customer ordered by; sku is the admin code, used
  // only as a fallback when a product has no name
  items: { sku: string; name: string; qty: string }[];
};

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CARRIER_LABELS: Record<string, string> = {
  usps: 'USPS', ups: 'UPS', fedex: 'FedEx', dhl_express: 'DHL Express',
  dhl_ecommerce: 'DHL eCommerce', canada_post: 'Canada Post',
};
export function carrierLabel(carrier: string): string {
  return CARRIER_LABELS[carrier.trim().toLowerCase()] || carrier.trim();
}

/**
 * Subject + HTML + plain text. Deliberately plain, table-free HTML with
 * inline styles only — transactional emails render in clients where
 * stylesheets don't exist, and a "shipped" notice lives or dies on the
 * tracking number being readable and clickable.
 */
export function buildShipEmail(p: ShipEmailPayload, opts?: { senderName?: string; canReply?: boolean }): { subject: string; html: string; text: string } {
  const url = trackingUrl(p.carrier, p.tracking);
  const carrier = carrierLabel(p.carrier);
  const service = p.servicelevel.trim();
  const first = p.name.trim().split(/\s+/)[0] || 'there';
  const itemLines = p.items.map(i => `${(i.name || i.sku).trim() || i.sku} × ${i.qty}`);
  const sender = (opts?.senderName || '').trim() || 'SND GB';
  const replyLine = opts?.canReply ? 'Questions? Just reply to this email.' : '';
  // "A box from" not "your order has shipped": partial fills are common
  // and the subject must never claim more than what shipped
  const subject = `A box from your order ${p.orderNumber} is on its way`;
  const trackingHtml = url
    ? `<a href="${esc(url)}" style="color:#0f766e;">${esc(p.tracking)}</a>`
    : `<span style="font-family:monospace;">${esc(p.tracking)}</span>`;
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:520px;">`,
    `<p>Hi ${esc(first)},</p>`,
    `<p>A box from your order <strong>${esc(p.orderNumber)}</strong> is on its way.</p>`,
    `<p style="margin:16px 0;padding:12px 16px;background:#f3f4f6;border-radius:6px;">`,
    `<strong>${esc(carrier)}${service ? ` — ${esc(service)}` : ''}</strong><br/>`,
    `Tracking: ${trackingHtml}</p>`,
    itemLines.length > 0
      ? `<p>In this box:<br/>${itemLines.map(l => `&nbsp;&nbsp;${esc(l)}`).join('<br/>')}</p>`
      : '',
    `<p style="color:#6b7280;font-size:13px;">If your order includes more items, they may arrive in separate boxes, each with its own tracking email.${replyLine ? ` ${esc(replyLine)}` : ''}</p>`,
    `<p>— ${esc(sender)}</p>`,
    `</div>`,
  ].filter(Boolean).join('\n');
  const text = [
    `Hi ${first},`,
    ``,
    `A box from your order ${p.orderNumber} is on its way.`,
    ``,
    `${carrier}${service ? ` — ${service}` : ''}`,
    `Tracking: ${p.tracking}${url ? `\n${url}` : ''}`,
    ...(itemLines.length > 0 ? [``, `In this box:`, ...itemLines.map(l => `  ${l}`)] : []),
    ``,
    `If your order includes more items, they may arrive in separate boxes, each with its own tracking email.${replyLine ? ` ${replyLine}` : ''}`,
    ``,
    `— ${sender}`,
  ].join('\n');
  return { subject, html, text };
}

/** Key-shaped substrings never reach the UI, mirroring the Shippo client. */
function sanitize(text: string): string {
  return text.replace(/\bre_[A-Za-z0-9_]+/g, 're_***').replace(/Bearer\s+[^\s"'\\)\]}]+/gi, 'Bearer ***');
}

/**
 * The shared POST /emails wire: one attempt, positive schema gate
 * (Resend's send result is an object with a string id), key-sanitized
 * operator-readable errors with hints for the two classic failures.
 */
async function postEmail(http: ResendHttp, cfg: ShipEmailConfig, message: Record<string, unknown>, idemKey: string): Promise<void> {
  let body: unknown;
  try {
    body = await http.post(cfg.key, '/emails', {
      from: cfg.from, ...message,
      ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    }, idemKey);
  } catch (e: unknown) {
    const raw = sanitize(e instanceof Error ? e.message : String(e));
    const hint = /\b403\b/.test(raw)
      ? ' — a 403 usually means the from-domain is not verified at resend.com/domains (unverified accounts can only send to their own address), or the from address does not match the verified domain'
      : /\b401\b/.test(raw) ? ' — a 401 means Resend rejected the API key; re-check it in Settings' : '';
    throw new Error(`Resend did not accept the email (${raw.slice(0, 200)})${hint}.`);
  }
  // unwrap an axios-style envelope if the platform adds one (Resend
  // bodies never carry data+status/headers together themselves)
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)
      && ('status' in (body as Record<string, unknown>) || 'headers' in (body as Record<string, unknown>))) {
    body = (body as Record<string, unknown>).data;
  }
  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).id !== 'string') {
    throw new Error('Resend\'s response came back in an unrecognized shape — the email may or may not have been sent; check resend.com/emails before retrying.');
  }
}

/** One customer "shipped" send. Callers own the DB claim. */
export async function sendShipEmail(http: ResendHttp, cfg: ShipEmailConfig, payload: ShipEmailPayload, idemKey: string): Promise<void> {
  // the sign-off reuses the from-field's display name so the body is
  // never anonymous even when the from shows only an address
  const senderName = (cfg.from.match(/^([^<>]+)</)?.[1] || '').trim();
  const { subject, html, text } = buildShipEmail(payload, { senderName, canReply: !!cfg.replyTo });
  await postEmail(http, cfg, { to: [payload.to.trim()], subject, html, text }, idemKey);
}

/**
 * Settings-page probe through the FULL chain (datasource → backend →
 * Resend → key → from-domain): clearly labeled as a test so it can be
 * sent to anyone without reading like a real shipment notice.
 */
export async function sendTestEmail(http: ResendHttp, cfg: ShipEmailConfig, to: string): Promise<void> {
  await postEmail(http, cfg, {
    to: [to.trim()],
    subject: 'SND GB — shipment email test',
    html: '<p>This is a test of the SND GB shipment-notification email. If you can read this, the Resend key, from-address, and datasource are all working.</p>',
    text: 'This is a test of the SND GB shipment-notification email. If you can read this, the Resend key, from-address, and datasource are all working.',
  }, `settings-test-${Date.now()}`);
}
