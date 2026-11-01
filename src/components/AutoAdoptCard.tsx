import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/fmt';
import type { AutoAdoptState } from '@/app/AutoAdopt';
import type { AutoAdoptItem, AutoAdoptSummary } from '@/lib/autoAdopt';
import { Loader2, Zap, CheckCircle2, AlertTriangle } from 'lucide-react';

/**
 * What the auto-adopt pass did, as a card: the counts in one line, then
 * every line it recorded, wrote back, or could not settle — "needs you" is
 * the operator's to-do list, the rest is the receipt. Shown on the Import
 * page after an ordering-app pull and on the Fulfillment page.
 */

/** One line for the floating import widget and the card header. */
export function autoAdoptLine(s: AutoAdoptSummary): string {
  const parts: string[] = [];
  if (s.adopted) parts.push(`${s.adopted} recorded from the ordering app`);
  if (s.vendorMarked) parts.push(`${s.vendorMarked} vendor shipped`);
  if (s.pushed) parts.push(`${s.pushed} written back`);
  if (s.needsYou) parts.push(`${s.needsYou} need${s.needsYou === 1 ? 's' : ''} you`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.errors) parts.push(`${s.errors} error${s.errors === 1 ? '' : 's'}`);
  if (parts.length === 0) return s.handMarks === 0 ? 'nothing marked by hand there' : 'everything already recorded';
  return parts.join(' · ');
}

const KIND_LABEL: Record<AutoAdoptItem['kind'], string> = {
  adopted: 'recorded', vendor_marked: 'vendor', pushed: 'written back', needs_you: 'needs you', skipped: 'skipped', error: 'error',
};
const KIND_CLASS: Record<AutoAdoptItem['kind'], string> = {
  adopted: 'text-emerald-300', vendor_marked: 'text-emerald-300', pushed: 'text-cyan-300',
  needs_you: 'text-amber-300', skipped: 'text-muted-foreground', error: 'text-rose-400',
};

export function AutoAdoptCard({ state, onRun, onOpenOrder, canRun }: {
  state: AutoAdoptState;
  /** when set, the card offers "Run again" */
  onRun?: () => void;
  onOpenOrder?: (orderId: number) => void;
  canRun?: boolean;
}) {
  const s = state.summary;
  const todo = s ? s.items.filter(i => i.kind === 'needs_you' || i.kind === 'error') : [];
  const done = s ? s.items.filter(i => i.kind !== 'needs_you' && i.kind !== 'error') : [];
  const tone = state.running ? 'border-cyan-400/40' : state.error ? 'border-rose-400/40' : todo.length > 0 ? 'border-amber-400/40' : undefined;
  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            {state.running
              ? <Loader2 className="w-4 h-4 animate-spin text-cyan-300" />
              : state.error ? <AlertTriangle className="w-4 h-4 text-rose-400" />
              : todo.length > 0 ? <AlertTriangle className="w-4 h-4 text-amber-300" />
              : <CheckCircle2 className="w-4 h-4 text-emerald-300" />}
            Ordering-app shipments
            <span className="text-muted-foreground font-normal text-sm">
              {state.running ? `checking (${state.trigger})…` : state.error ? state.error : s ? `${autoAdoptLine(s)} · ${fmtDateTime(s.finishedAt)}` : ''}
            </span>
          </CardTitle>
          {onRun && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={state.running || canRun === false} onClick={onRun}>
              <Zap className="h-3.5 w-3.5" /> {state.running ? 'Running…' : s ? 'Run again' : 'Run now'}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Pulls down what was marked shipped by hand in the ordering app: records it here as a box with its ordering-app date and no tracking, marks vendor-direct lines vendor shipped, and writes ship dates back to the ordering app for lines that already shipped from here. It never records over a box or draft already here, never acts on an order-level status alone, and never guesses between two dates — those are listed under "needs you".
        </p>
      </CardHeader>
      {s && (todo.length > 0 || done.length > 0) && (
        <CardContent className="space-y-2 text-sm">
          {todo.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase text-amber-300 mb-1">Needs you ({todo.length})</div>
              <ul className="space-y-1">
                {todo.map((i, n) => <Row key={n} item={i} onOpenOrder={onOpenOrder} />)}
              </ul>
            </div>
          )}
          {done.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Done ({done.length})</div>
              <ul className="space-y-1">
                {done.map((i, n) => <Row key={n} item={i} onOpenOrder={onOpenOrder} />)}
              </ul>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Row({ item, onOpenOrder }: { item: AutoAdoptItem; onOpenOrder?: (orderId: number) => void }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`shrink-0 w-24 font-semibold uppercase ${KIND_CLASS[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
      {onOpenOrder && item.orderId > 0
        ? <button type="button" className="shrink-0 font-medium text-cyan-300 hover:underline" onClick={() => onOpenOrder(item.orderId)}>{item.orderNumber}</button>
        : <span className="shrink-0 font-medium">{item.orderNumber}</span>}
      <span className="text-muted-foreground break-words min-w-0">{item.message}</span>
    </li>
  );
}
