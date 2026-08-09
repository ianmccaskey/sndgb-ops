import React from 'react';
import { Badge } from '@/components/ui/badge';

const STYLES: Record<string, string> = {
  // reconciliation
  matched: 'bg-green-100 text-green-800',
  short: 'bg-red-100 text-red-800',
  over: 'bg-blue-100 text-blue-800',
  awaiting: 'bg-amber-100 text-amber-800',
  // payments
  pending: 'bg-amber-100 text-amber-800',
  verified: 'bg-green-100 text-green-800',
  mismatch: 'bg-red-100 text-red-800',
  rejected: 'bg-gray-200 text-gray-600',
  // orders
  imported: 'bg-gray-100 text-gray-700',
  flagged: 'bg-red-100 text-red-800',
  refunded: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-gray-200 text-gray-600',
  // vendors
  unpaid: 'bg-amber-100 text-amber-800',
  partial: 'bg-blue-100 text-blue-800',
  paid: 'bg-green-100 text-green-800',
  OVERPAID: 'bg-red-100 text-red-800 font-bold',
  // shipments
  packed: 'bg-blue-100 text-blue-800',
  shipped: 'bg-green-100 text-green-800',
  delivered: 'bg-green-200 text-green-900',
  reshipped: 'bg-violet-100 text-violet-800',
};

export function StatusPill({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={`${STYLES[value] || 'bg-gray-100 text-gray-700'} border-0`}>
      {value}
    </Badge>
  );
}
