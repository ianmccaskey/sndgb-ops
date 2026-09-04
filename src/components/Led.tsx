import React from 'react';

/**
 * The C-star attention LED: a small amber dot with a slow pulse ring
 * (animate-led in index.css, 2.4s). Motion is RESERVED for states owing
 * action — out-for-delivery, not-pushed, pickup-waiting, payment problems.
 * Never attach it to calm status.
 */
export function Led({ className = '' }: { className?: string }) {
  return <span className={`inline-block w-2 h-2 rounded-full bg-amber-400 animate-led shrink-0 ${className}`} aria-hidden="true" />;
}
