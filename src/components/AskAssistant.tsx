import React, { useEffect, useRef, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import logAssistantCall from '@/actions/assistant/logAssistantCall';
import logAssistantFix from '@/actions/assistant/logAssistantFix';
import { useApp } from '@/app/AppContext';
import { useAssistantHttp } from '@/lib/useAssistantHttp';
import { askAssistant, describeFix, normalizeAssistantError, scrubText } from '@/lib/assistant';
import type { ApiMessage, AssistantContext, AssistantTools, AssistantUsage, ProposedFix } from '@/lib/assistant';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Sparkles } from 'lucide-react';

/*
 * "Ask about this" — the read-only assistant's one surface. The caller
 * hands it PII-free facts (src/lib/assistant.ts builders), campaign-pinned
 * read tools, and optionally a way to hand a draft back into a field the
 * operator still submits — or, on the order sheet, a way to APPLY a fix
 * the model proposed (onApplyFix). A proposal is a card with an editable
 * reason and an Apply button; the click calls the caller's handler, which
 * is the same handler its own buttons use. This component writes two
 * kinds of audit row, both under the operator: one per question
 * (assistant_asked) and one per proposal applied (assistant_fix_applied).
 */

type Entry = {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  meta?: { model: string; usage: AssistantUsage; toolsRan: string[] };
  /** fixes the model proposed with this answer — rendered as cards, applied only on click */
  proposals?: ProposedFix[];
};

type FixState = { status: 'busy' | 'applied' | 'refused'; message: string };

export type AskAssistantProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  context: AssistantContext;
  tools: AssistantTools;
  /** the row the questions are about — audited as assistant_asked */
  scope: { table: 'orders' | 'group_buys'; rowPk: number };
  suggestions?: string[];
  /** asked automatically when the dialog opens on a fresh subject (e.g. "draft the tracking email") */
  initialQuestion?: string;
  /** when set, each answer offers a button that hands its text to the caller (e.g. prefill the admin note) */
  onUseDraft?: (text: string) => void;
  useDraftLabel?: string;
  /**
   * when set, the model may propose fixes (propose_fix) and each one renders
   * as a card with an Apply button that calls this — the caller runs the same
   * audited control its own button would, and reports ok + a message. Only a
   * caller whose scope is an order should pass it.
   */
  onApplyFix?: (fix: ProposedFix) => Promise<{ ok: boolean; message: string }>;
};

export function AskAssistant({ open, onClose, title, context, tools, scope, suggestions = [], initialQuestion, onUseDraft, useDraftLabel = 'Use as draft', onApplyFix }: AskAssistantProps) {
  const { userName } = useApp();
  const http = useAssistantHttp();
  const [doLog] = useMutateAction(logAssistantCall);
  const [doLogFix] = useMutateAction(logAssistantFix);
  // per proposal card (key = entry id : proposal id): the operator's edited
  // reason, and what happened when they clicked Apply
  const [fixReason, setFixReason] = useState<Record<string, string>>({});
  const [fixState, setFixState] = useState<Record<string, FixState>>({});
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const seq = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastLabel = useRef<string | null>(null);
  // the ship dialog mounts this conditionally: a request resolving after
  // close must not touch state
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // A new subject (different order, a fresh pull) starts a fresh conversation:
  // the facts live in the first turn, so stale ones must not be continued.
  const [pendingAuto, setPendingAuto] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (lastLabel.current !== context.label) {
      lastLabel.current = context.label;
      setEntries([]); setHistory([]); setNotice(''); setQuestion('');
      setFixReason({}); setFixState({});
      if (initialQuestion) setPendingAuto(initialQuestion);
    }
  }, [open, context.label, initialQuestion]);
  // the auto-question fires from state, not from the effect above, so it
  // runs once per subject with the reset applied (history is empty)
  useEffect(() => {
    if (pendingAuto == null || busy) return;
    const q = pendingAuto;
    setPendingAuto(null);
    void ask(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAuto]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [entries.length, busy]);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true); setNotice(''); setQuestion('');
    setEntries(prev => [...prev, { id: ++seq.current, role: 'user', text }]);
    try {
      const a = await askAssistant(http, { context, tools, history, question: text, allowFixes: !!onApplyFix });
      // the trail: who asked what, at what cost — never the answer. The
      // question is scrubbed (emails, phones, handles) and capped, since an
      // operator can type member data into it. Written BEFORE the unmount
      // check: a question that reached the model is audited even when the
      // dialog closed (or was remounted on a fresh load) while it ran.
      let logged = true;
      try {
        await doLog({
          scope: scope.table, row_pk: String(scope.rowPk), actor: userName,
          detail: JSON.stringify({ kind: context.kind, label: scrubText(context.label), question: scrubText(text).slice(0, 300), model: a.model, stop_reason: a.stopReason, usage: a.usage, tools: a.toolsRan, proposed: a.proposals.map(f => f.kind) }),
        });
      } catch {
        logged = false;
      }
      if (!mounted.current) return;
      setHistory(a.history);
      setEntries(prev => [...prev, { id: ++seq.current, role: 'assistant', text: a.text, meta: { model: a.model, usage: a.usage, toolsRan: a.toolsRan }, proposals: a.proposals }]);
      if (!logged) setNotice('Answered, but the audit row for this question could not be written.');
    } catch (e: unknown) {
      if (mounted.current) setEntries(prev => [...prev, { id: ++seq.current, role: 'error', text: normalizeAssistantError(e).message }]);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied.');
    } catch {
      setNotice('Could not copy — select the text and copy it by hand.');
    }
  };

  // Apply = the operator's click, nothing else. The caller's handler runs
  // the control (with its own guards: status re-checked, reason required,
  // one hash per order) and says what happened; on success the trail gets
  // an assistant_fix_applied row and the conversation forgets its facts,
  // so the next question is answered from the refreshed records.
  const applyFix = async (entryId: number, fix: ProposedFix) => {
    if (!onApplyFix || busy) return;
    const key = `${entryId}:${fix.id}`;
    if (fixState[key]?.status === 'busy' || fixState[key]?.status === 'applied') return;
    const reason = (fixReason[key] ?? fix.reason).trim();
    if (!reason) { setFixState(s => ({ ...s, [key]: { status: 'refused', message: 'A reason is required — it goes into the audit trail.' } })); return; }
    setFixState(s => ({ ...s, [key]: { status: 'busy', message: '' } }));
    let result: { ok: boolean; message: string };
    try {
      result = await onApplyFix({ ...fix, reason });
    } catch (e: unknown) {
      result = { ok: false, message: e instanceof Error ? e.message : 'The fix could not be applied.' };
    }
    if (!mounted.current) return;
    if (result.ok) {
      setHistory([]);
      try {
        await doLogFix({
          row_pk: String(scope.rowPk), actor: userName,
          detail: JSON.stringify({
            kind: fix.kind, what: describeFix(fix), payment_id: fix.payment_id, method: fix.method, tx_hash: fix.tx_hash, amount_usd: fix.amount_usd,
            reason: scrubText(reason).slice(0, 300), result: result.message.slice(0, 200),
          }),
        });
      } catch {
        result = { ...result, message: `${result.message} (The audit row for this applied proposal could not be written.)` };
      }
      if (!mounted.current) return;
      setNotice('Applied. The next question starts from the refreshed records.');
    }
    setFixState(s => ({ ...s, [key]: { status: result.ok ? 'applied' : 'refused', message: result.message } }));
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="w-full sm:max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2 text-left">
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-cyan-300" /> {title}</DialogTitle>
          <DialogDescription className="text-xs">
            {onApplyFix
              ? 'It explains what the app recorded and can propose a fix as a card under its answer. Nothing changes until you click Apply, which runs the same audited control as this sheet under your name — read the reason first, it goes into the trail. '
              : 'Read-only. It explains what the app recorded and names the screen to act on; it cannot change anything. '}
            Check every figure against the screen before acting. Member contact details are not sent; emails, phone numbers and handles inside notes are scrubbed — keep them out of your question too.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3 text-sm min-h-[160px]">
          {entries.length === 0 && !busy && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">About: {context.label}</p>
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map(s => (
                    <button key={s} type="button" onClick={() => ask(s)}
                      className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {entries.map(e => (
            <div key={e.id} className={e.role === 'user' ? 'flex justify-end' : ''}>
              {e.role === 'user' && (
                <div className="rounded-lg bg-muted px-3 py-2 max-w-[90%] whitespace-pre-wrap">{e.text}</div>
              )}
              {e.role === 'assistant' && (
                <div className="rounded-lg border px-3 py-2 space-y-2">
                  <div className="whitespace-pre-wrap">{e.text}</div>
                  {onApplyFix && e.proposals && e.proposals.length > 0 && (
                    <div className="space-y-2">
                      {e.proposals.map(f => {
                        const key = `${e.id}:${f.id}`;
                        const st = fixState[key];
                        const locked = st?.status === 'busy' || st?.status === 'applied';
                        return (
                          <div key={key} className="rounded border border-cyan-400/40 bg-cyan-400/5 p-2 space-y-1.5">
                            <div className="text-xs font-semibold">Proposed fix {f.id}: {describeFix(f)}</div>
                            <Textarea
                              rows={2}
                              className="text-xs"
                              value={fixReason[key] ?? f.reason}
                              onChange={ev => setFixReason(m => ({ ...m, [key]: ev.target.value }))}
                              disabled={locked}
                              placeholder="Reason (audited)"
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              {st?.status === 'applied'
                                ? <span className="text-xs font-medium text-emerald-300">Applied</span>
                                : <Button size="sm" className="h-7 text-xs" disabled={busy || locked} onClick={() => applyFix(e.id, f)}>{st?.status === 'busy' ? 'Applying…' : 'Apply'}</Button>}
                              <span className="text-[10px] text-muted-foreground">runs the same audited control as this sheet, under your name</span>
                            </div>
                            {st?.message && <p className={`text-xs ${st.status === 'refused' ? 'text-amber-300' : 'text-muted-foreground'}`}>{st.message}</p>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => copy(e.text)}>Copy</Button>
                    {onUseDraft && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { onUseDraft(e.text); setNotice('Handed to the field below — review it, then save as usual.'); }}>
                        {useDraftLabel}
                      </Button>
                    )}
                    {e.meta && (
                      <span className="text-[10px] text-muted-foreground">
                        {e.meta.model} · {e.meta.usage.input_tokens + e.meta.usage.cache_read_input_tokens} in / {e.meta.usage.output_tokens} out
                        {e.meta.toolsRan.length > 0 ? ` · looked up: ${e.meta.toolsRan.join(', ')}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {e.role === 'error' && (
                <div className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-rose-300 break-words">{e.text}</div>
              )}
            </div>
          ))}
          {busy && <p className="text-xs text-muted-foreground animate-pulse">Thinking…</p>}
          <div ref={bottomRef} />
        </div>

        <div className="border-t p-3 space-y-2">
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
          <Textarea
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); ask(question); } }}
            rows={2}
            placeholder="Ask about this… (Ctrl+Enter to send)"
            className="text-sm"
            disabled={busy}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">Each question is logged under your name (scrubbed, first 300 characters).</span>
            <Button size="sm" disabled={busy || !question.trim()} onClick={() => ask(question)}>{busy ? 'Asking…' : 'Ask'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
