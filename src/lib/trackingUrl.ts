/**
 * Carrier tracking-page URL for a tracking number, or null when the
 * carrier has no known lookup page (custom carrier tokens stay plain
 * text — a wrong guess would be worse than no link). Shared by the
 * TrackingLink component and the shipment-notification email, so the
 * link a customer gets is the exact link the operators use.
 */
export function trackingUrl(carrier: string | null | undefined, tracking: string | null | undefined): string | null {
  const t = String(tracking ?? '').trim();
  if (!t) return null;
  const enc = encodeURIComponent(t);
  switch (String(carrier ?? '').trim().toLowerCase()) {
    case 'usps': return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${enc}`;
    case 'ups': return `https://www.ups.com/track?tracknum=${enc}`;
    case 'fedex': return `https://www.fedex.com/fedextrack/?trknbr=${enc}`;
    case 'dhl_express': return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${enc}`;
    case 'dhl_ecommerce': return `https://webtrack.dhlecs.com/orders?trackingNumber=${enc}`;
    case 'canada_post': return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${enc}`;
    default: return null;
  }
}
