import React from 'react';

/**
 * A labeled form field: PERSISTENT label above the control, optional hint
 * below. The house answer to placeholder-as-label (form-UX sweep,
 * 2026-09-12): placeholders vanish the moment a field holds a value, so
 * every filled form became a memory test. Placeholders remain allowed
 * INSIDE a Field as examples/hints only — never as the field's identity.
 */
export function Field({ label, hint, className = '', children }: {
  label: string; hint?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1 min-w-0 ${className}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}
