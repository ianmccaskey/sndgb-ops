import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/fmt';
import type { AutoReconState } from '@/app/AutoRecon';
import type { AutoReconItem, AutoReconSummary } from '@/lib/autoRecon';
import { Loader2, Zap, CheckCircle2, AlertTriangle } from 'lucide-react';

/**
 * What the auto-reconcile pass did, as a card: the counts in one line, then
 * every item it touched or could not settle, grouped so "needs you" is the
 * operator's to-do list and the rest is the receipt. Shown on the Import
 * page after a pull and on the Reconciliation page.
 */

/** One line for the floating import widget and the card header. */
export function autoReconLine(s: AutoReconSummary): string {
  const parts: string[] = [];
  if (s.verified) parts.push(`${s.verified} verified`);
  if (s.mismatch) parts.push(`${s.mismatch} native (needs pricing)`);
  if (s.repointed) parts.push(`${s.repointed} re-pointed`);
  if (s.railsCorrected) parts.push(`${s.railsCorrected} rail${s.railsCorrected === 1 ? '' : 's'} corrected`);
  if (s.needsYou) parts.push(`${s.needsYou} need${s.needsYou === 1 ? 's' : ''} you`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.errors) parts.push(`${s.errors} error${s.errors === 1 ? '' : 's'}`);
  if (parts.length === 0) return s.pendingSeen === 0 ? 'nothing pending' : 'nothing changed';
  return parts.join(' · ');
}

const KIND_LABEL: Record<AutoReconItem['kind'], string> = {
  verified: 'verified', mismatch: 'native', repointed: 're-pointed', rail: 'rail', needs_you: 'needs you', skipped: 'skipped', error: 'error',
};
const KIND_CLASS: Record<AutoReconItem['kind'], string> = {
  verified: 'text-emerald-300', mismatch: 'text-amber-300', repointed: 'text-cyan-300', rail: 'text-cyan-300',
  needs_you: 'text-amber-300', skipped: 'text-muted-foreground', error: 'text-rose-400',
};

export function AutoReconCard({ state, onRun, onOpenOrder, canRun }: {
  state: AutoReconState;
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
            Auto-reconcile
            <span className="text-muted-foreground font-normal text-sm">
              {state.running ? `running (${state.trigger})…` : state.error ? state.error : s ? `${autoReconLine(s)} · ${fmtDateTime(s.finishedAt)}` : ''}
            </span>
          </CardTitle>
          {onRun && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={state.running || canRun === false} onClick={onRun}>
              <Zap className="h-3.5 w-3.5" /> {state.running ? 'Running…' : s ? 'Run again' : 'Run now'}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Verifies pending crypto hashes on-chain, re-points a hash to the one other network that shows it paying our wallet, and corrects an order's rail to where its verified money sits. It never rejects, overrides or moves a hash between orders — those are listed under "needs you".
        </p>
      </CardHeader>
      {s && (todo.length > 0 || done.length > 0 || s.configMissing.length > 0) && (
        <CardContent className="space-y-2 text-sm">
          {s.configMissing.length > 0 && (
            <p className="text-xs text-amber-300">No provider key for {s.configMissing.map(m => m.toUpperCase()).join(', ')} — set it in Settings; those payments were skipped.</p>
          )}
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

function Row({ item, onOpenOrder }: { item: AutoReconItem; onOpenOrder?: (orderId: number) => void }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`shrink-0 w-20 font-semibold uppercase ${KIND_CLASS[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
      {onOpenOrder && item.orderId > 0
        ? <button type="button" className="shrink-0 font-medium text-cyan-300 hover:underline" onClick={() => onOpenOrder(item.orderId)}>{item.orderNumber}</button>
        : <span className="shrink-0 font-medium">{item.orderNumber}</span>}
      <span className="text-muted-foreground break-words min-w-0">{item.message}</span>
    </li>
  );
}
