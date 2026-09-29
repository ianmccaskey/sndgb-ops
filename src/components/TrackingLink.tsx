import React from 'react';
import { trackingUrl } from '@/lib/trackingUrl';

/**
 * A tracking number that opens the carrier's tracking page in a new tab
 * when the carrier is recognized; renders as plain text otherwise, so
 * every call site can use it unconditionally. stopPropagation so a link
 * inside a clickable row opens the page instead of the row.
 */
export function TrackingLink({ carrier, tracking, className = '', children }: {
  carrier: string | null | undefined;
  tracking: string | null | undefined;
  className?: string;
  children?: React.ReactNode;
}) {
  const url = trackingUrl(carrier, tracking);
  const content = children ?? String(tracking ?? '');
  if (!url) return <span className={className}>{content}</span>;
  return (
    // inline-block + padding-with-negative-margins: a phone-sized tap
    // target on 11px mono text without shifting layout (and it survives
    // truncated table cells). Full-strength dotted underline — /60 muted
    // was near-invisible on the dark theme and hover never fires on touch,
    // so the underline IS the whole "this is clickable" signal. The title
    // carries the NUMBER (not just "open tracking") so a truncated cell's
    // hidden digits stay recoverable on desktop.
    <a href={url} target="_blank" rel="noreferrer"
      className={`inline-block py-2 -my-2 px-1 -mx-1 underline underline-offset-2 decoration-dotted decoration-muted-foreground hover:text-foreground ${className}`}
      title={`Track ${String(tracking ?? '').trim()} on the carrier's site`}
      onClick={e => e.stopPropagation()}>
      {content}
    </a>
  );
}
