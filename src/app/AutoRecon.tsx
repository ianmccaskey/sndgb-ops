import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import listPendingCryptoPayments from '@/actions/recon/listPendingCryptoPayments';
import listRailCandidates from '@/actions/recon/listRailCandidates';
import logAutoReconRun from '@/actions/recon/logAutoReconRun';
import recordChainVerification from '@/actions/payments/recordChainVerification';
import repointPendingPaymentNetwork from '@/actions/payments/repointPendingPaymentNetwork';
import updateOrderRail from '@/actions/orders/updateOrderRail';
import appendOrderAdminNote from '@/actions/orders/appendOrderAdminNote';
import { useApp } from '@/app/AppContext';
import { runAutoRecon, AutoReconSummary } from '@/lib/autoRecon';

/**
 * App-level home of the auto-reconcile pass (src/lib/autoRecon.ts), so one
 * run at a time exists across the whole app: the import runner starts one
 * after every pull and the Reconciliation page starts one when it opens
 * with pending crypto payments (and on demand). Two pages must never run
 * the same lookups side by side — the SQL guards would make the second
 * run harmless, but it would double every provider call.
 *
 * The run reads the CURRENT operator and settings at execution time
 * (envRef), like the import runner: a first-render closure would freeze a
 * late-resolving user name into audit rows. Every write is audited under
 * "<operator> (auto-reconcile)".
 */

export type AutoReconState = {
  running: boolean;
  groupBuyId: number | null;
  /** what started the run: 'after import' | 'recon page' | 'manual' */
  trigger: string | null;
  summary: AutoReconSummary | null;
  error: string | null;
};

type Api = {
  state: AutoReconState;
  /**
   * resolves to the summary — or to null when a run was already active, in
   * which case the request is QUEUED (one per campaign, latest trigger
   * wins) and runs as soon as the active one finishes; the state then
   * reports that later run
   */
  run: (groupBuyId: number, trigger: string) => Promise<AutoReconSummary | null>;
  dismiss: () => void;
};

const IDLE: AutoReconState = { running: false, groupBuyId: null, trigger: null, summary: null, error: null };
const Ctx = createContext<Api | null>(null);

export function useAutoRecon(): Api {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAutoRecon must be used within AutoReconProvider');
  return ctx;
}

export function AutoReconProvider({ children }: { children: React.ReactNode }) {
  const { userName, settings } = useApp();
  const [doPending] = useMutateAction(listPendingCryptoPayments);
  const [doRailCandidates] = useMutateAction(listRailCandidates);
  const [doLogRun] = useMutateAction(logAutoReconRun);
  const [doRecord] = useMutateAction(recordChainVerification);
  const [doRepoint] = useMutateAction(repointPendingPaymentNetwork);
  const [doUpdateRail] = useMutateAction(updateOrderRail);
  const [doAppendNote] = useMutateAction(appendOrderAdminNote);
  const [state, setState] = useState<AutoReconState>(IDLE);
  const activeRef = useRef(false);
  // requests that arrived while a run was active — an import finishing
  // while the Reconciliation page's pass runs, a campaign switch mid-run.
  // Dropping them would leave just-imported hashes unchecked, so they are
  // kept (one per campaign) and drained in order when the run ends.
  const queuedRef = useRef<Map<number, string>>(new Map());
  const runRef = useRef<(groupBuyId: number, trigger: string) => Promise<AutoReconSummary | null>>(async () => null);
  const envRef = useRef({ userName, settings, doPending, doRailCandidates, doLogRun, doRecord, doRepoint, doUpdateRail, doAppendNote });
  envRef.current = { userName, settings, doPending, doRailCandidates, doLogRun, doRecord, doRepoint, doUpdateRail, doAppendNote };

  const run = useCallback(async (groupBuyId: number, trigger: string): Promise<AutoReconSummary | null> => {
    if (activeRef.current) {
      queuedRef.current.set(groupBuyId, trigger);
      return null;
    }
    activeRef.current = true;
    setState({ running: true, groupBuyId, trigger, summary: null, error: null });
    try {
      const env = envRef.current;
      const summary = await runAutoRecon(groupBuyId, {
        settings: env.settings,
        actor: `${env.userName} (auto-reconcile)`,
        listPending: (gb) => env.doPending({ group_buy_id: gb }),
        recordVerification: (p) => env.doRecord(p),
        repoint: (p) => env.doRepoint(p),
        listRailCandidates: (gb) => env.doRailCandidates({ group_buy_id: gb }),
        rail: {
          updateRail: (p) => env.doUpdateRail(p),
          appendNote: (p) => env.doAppendNote(p),
        },
        logRun: (p) => env.doLogRun(p),
      });
      summary.trigger = trigger;
      setState({ running: false, groupBuyId, trigger, summary, error: null });
      return summary;
    } catch (e: unknown) {
      setState({ running: false, groupBuyId, trigger, summary: null, error: e instanceof Error ? e.message : 'Auto-reconcile failed' });
      return null;
    } finally {
      activeRef.current = false;
      const next = queuedRef.current.entries().next();
      if (!next.done) {
        const [gb, tr] = next.value;
        queuedRef.current.delete(gb);
        void runRef.current(gb, `${tr}, queued`);
      }
    }
  }, []);
  runRef.current = run;

  const dismiss = useCallback(() => { setState(s => (s.running ? s : IDLE)); }, []);


  return <Ctx.Provider value={{ state, run, dismiss }}>{children}</Ctx.Provider>;
}
