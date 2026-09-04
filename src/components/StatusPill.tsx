import React from 'react';
import { Badge } from '@/components/ui/badge';

const STYLES: Record<string, string> = {
  // reconciliation
  matched: 'bg-emerald-400/10 text-emerald-300',
  short: 'bg-rose-400/10 text-rose-300',
  over: 'bg-blue-400/10 text-blue-300',
  awaiting: 'bg-amber-400/10 text-amber-300',
  // payments
  pending: 'bg-amber-400/10 text-amber-300',
  verified: 'bg-emerald-400/10 text-emerald-300',
  mismatch: 'bg-rose-400/10 text-rose-300',
  rejected: 'bg-slate-400/10 text-slate-400',
  // orders
  imported: 'bg-slate-400/10 text-slate-300',
  flagged: 'bg-rose-400/10 text-rose-300',
  refunded: 'bg-slate-400/10 text-slate-400',
  cancelled: 'bg-slate-400/10 text-slate-400',
  // vendors
  unpaid: 'bg-amber-400/10 text-amber-300',
  partial: 'bg-blue-400/10 text-blue-300',
  paid: 'bg-emerald-400/10 text-emerald-300',
  OVERPAID: 'bg-rose-400/10 text-rose-300 font-bold',
  // shipments
  packed: 'bg-blue-400/10 text-blue-300',
  shipped: 'bg-emerald-400/10 text-emerald-300',
  delivered: 'bg-green-200 text-emerald-300',
  reshipped: 'bg-violet-400/10 text-violet-300',
};

export function StatusPill({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={`${STYLES[value] || 'bg-slate-400/10 text-slate-300'} border-0`}>
      {value}
    </Badge>
  );
}
