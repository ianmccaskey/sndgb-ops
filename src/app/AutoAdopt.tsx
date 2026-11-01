import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import listAdoptCandidates from '@/actions/fulfillment/listAdoptCandidates';
import getAdoptCandidateOrder from '@/actions/fulfillment/getAdoptCandidateOrder';
import adoptUpstreamShipmentUntouched from '@/actions/fulfillment/adoptUpstreamShipmentUntouched';
import markOrderDirectFulfilled from '@/actions/fulfillment/markOrderDirectFulfilled';
import logAutoAdoptRun from '@/actions/fulfillment/logAutoAdoptRun';
import logUpstreamCompletion from '@/actions/fulfillment/logUpstreamCompletion';
import appendOrderAdminNote from '@/actions/orders/appendOrderAdminNote';
import claimOrderUpstream from '@/actions/fulfillment/claimOrderUpstream';
import releaseOrderUpstream from '@/actions/fulfillment/releaseOrderUpstream';
import { useApp, platformOf } from '@/app/AppContext';
import { B44_DEFAULT_APP_ID, getB44Order, listB44Orders } from '@/lib/base44';
import { pushShippedDatesUpstream, upstreamLease } from '@/lib/pushShipment';
import { runAutoAdopt, AutoAdoptSummary } from '@/lib/autoAdopt';

/**
 * App-level home of the auto-adopt pass (src/lib/autoAdopt.ts), the
 * sibling of AutoReconProvider: one run at a time across the whole app,
 * started by the import runner after every ordering-app pull and by the
 * Fulfillment page when it opens (and on demand). It applies only to a
 * campaign the ordering app runs (platformOf === 'base44'); for any other
 * campaign run() is a no-op that resolves null, so callers need no check.
 *
 * The run reads the CURRENT operator, settings and campaign list at
 * execution time (envRef): a first-render closure would freeze a
 * late-resolving user name into audit rows. Every write is audited under
 * "<operator> (auto-adopt)".
 */

export type AutoAdoptState = {
  running: boolean;
  groupBuyId: number | null;
  /** what started the run: 'after import' | 'fulfillment page' | 'manual' */
  trigger: string | null;
  summary: AutoAdoptSummary | null;
  error: string | null;
};

type Api = {
  state: AutoAdoptState;
  /**
   * resolves to the summary — or to null when the campaign is not an
   * ordering-app campaign, or when a run was already active, in which
   * case the request is QUEUED (one per campaign, latest trigger wins)
   * and runs as soon as the active one finishes
   */
  run: (groupBuyId: number, trigger: string) => Promise<AutoAdoptSummary | null>;
  dismiss: () => void;
};

const IDLE: AutoAdoptState = { running: false, groupBuyId: null, trigger: null, summary: null, error: null };
const Ctx = createContext<Api | null>(null);

export function useAutoAdopt(): Api {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAutoAdopt must be used within AutoAdoptProvider');
  return ctx;
}

export function AutoAdoptProvider({ children }: { children: React.ReactNode }) {
  const { userName, settings, groupBuys } = useApp();
  const [doCandidates] = useMutateAction(listAdoptCandidates);
  const [doOrderLines] = useMutateAction(getAdoptCandidateOrder);
  const [doAdopt] = useMutateAction(adoptUpstreamShipmentUntouched);
  const [doMarkDirect] = useMutateAction(markOrderDirectFulfilled);
  const [doLogRun] = useMutateAction(logAutoAdoptRun);
  const [doLogCompletion] = useMutateAction(logUpstreamCompletion);
  const [doAppendNote] = useMutateAction(appendOrderAdminNote);
  const [doClaimLease] = useMutateAction(claimOrderUpstream);
  const [doReleaseLease] = useMutateAction(releaseOrderUpstream);
  const [state, setState] = useState<AutoAdoptState>(IDLE);
  const activeRef = useRef(false);
  const queuedRef = useRef<Map<number, string>>(new Map());
  const runRef = useRef<(groupBuyId: number, trigger: string) => Promise<AutoAdoptSummary | null>>(async () => null);
  const envRef = useRef({ userName, settings, groupBuys, doCandidates, doOrderLines, doAdopt, doMarkDirect, doLogRun, doLogCompletion, doAppendNote, doClaimLease, doReleaseLease });
  envRef.current = { userName, settings, groupBuys, doCandidates, doOrderLines, doAdopt, doMarkDirect, doLogRun, doLogCompletion, doAppendNote, doClaimLease, doReleaseLease };

  // when each campaign's last run finished — a page-open trigger within
  // RECENT_MS of it is skipped (the Fulfillment page would otherwise
  // re-pull the whole ordering app on every visit); imports and the
  // button always run
  const lastRunRef = useRef<Map<number, number>>(new Map());
  const RECENT_MS = 5 * 60 * 1000;

  const run = useCallback(async (groupBuyId: number, trigger: string): Promise<AutoAdoptSummary | null> => {
    const env = envRef.current;
    const gb = env.groupBuys.find(g => Number(g.id) === groupBuyId) ?? null;
    if (platformOf(gb) !== 'base44' || !gb?.external_id) return null;
    if (trigger === 'fulfillment page' && Date.now() - (lastRunRef.current.get(groupBuyId) ?? 0) < RECENT_MS) return null;
    if (activeRef.current) {
      queuedRef.current.set(groupBuyId, trigger);
      return null;
    }
    activeRef.current = true;
    setState({ running: true, groupBuyId, trigger, summary: null, error: null });
    try {
      const cfg = { appId: env.settings.base44_app_id || B44_DEFAULT_APP_ID, token: env.settings.base44_token || '' };
      if (!cfg.token) throw new Error('No ordering-app token in Settings — the pass cannot read the ordering app.');
      const actor = `${env.userName} (auto-adopt)`;
      const summary = await runAutoAdopt(groupBuyId, {
        cfg,
        gbExternalId: gb.external_id,
        actor,
        lease: (orderId) => upstreamLease({ claimLease: (p) => env.doClaimLease(p), releaseLease: (p) => env.doReleaseLease(p) }, orderId, actor),
        listCandidates: (g) => env.doCandidates({ group_buy_id: g }),
        getOrderLines: (id) => env.doOrderLines({ order_id: id }),
        listUpstream: listB44Orders,
        getUpstream: getB44Order,
        adopt: (p) => env.doAdopt(p),
        markDirect: (p) => env.doMarkDirect(p),
        pushDates: pushShippedDatesUpstream,
        appendNote: (p) => env.doAppendNote(p),
        logCompletion: (p) => env.doLogCompletion(p),
        logRun: (p) => env.doLogRun(p),
      });
      summary.trigger = trigger;
      lastRunRef.current.set(groupBuyId, Date.now());
      setState({ running: false, groupBuyId, trigger, summary, error: null });
      return summary;
    } catch (e: unknown) {
      setState({ running: false, groupBuyId, trigger, summary: null, error: e instanceof Error ? e.message : 'Auto-adopt failed' });
      return null;
    } finally {
      activeRef.current = false;
      const next = queuedRef.current.entries().next();
      if (!next.done) {
        const [g, tr] = next.value;
        queuedRef.current.delete(g);
        void runRef.current(g, `${tr}, queued`);
      }
    }
  }, []);
  runRef.current = run;

  const dismiss = useCallback(() => { setState(s => (s.running ? s : IDLE)); }, []);

  return <Ctx.Provider value={{ state, run, dismiss }}>{children}</Ctx.Provider>;
}
