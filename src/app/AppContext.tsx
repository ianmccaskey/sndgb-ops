import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useUser, useLoadAction } from '@uibakery/data';
import listGroupBuys from '@/actions/groupBuys/listGroupBuys';
import getSettings from '@/actions/settings/getSettings';
import { rows } from '@/lib/rows';
import { useStableValue, useStableCallback } from '@/lib/useStable';

export type GroupBuyRow = {
  id: number;
  external_id: string | null;
  name: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  admin_fee_usd: string;
  shipping_fee_usd: string;
  cash_processor_fee_pct: string;
  reconcile_tolerance_usd: string;
  notes: string | null;
};

export interface AppState {
  userName: string;
  userEmail: string;
  groupBuys: GroupBuyRow[];
  groupBuy: GroupBuyRow | null;
  groupBuyId: number | null;
  setGroupBuyId: (id: number) => void;
  reloadGroupBuys: () => void;
  /** app_settings as a key→value map (API keys, wallet addresses). */
  settings: Record<string, string>;
  reloadSettings: () => void;
}

const AppContext = createContext<AppState | null>(null);

const STORAGE_KEY = 'sndgb.selectedGroupBuyId';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const user = useUser();
  const [rawBuys, buysLoading, , reloadGroupBuysRaw] = useLoadAction(listGroupBuys, [], {});
  const [rawSettings, , , reloadSettingsRaw] = useLoadAction(getSettings, [], {});
  // Stabilized BY CONTENT, not by reference: the runtime's hooks may hand
  // back a fresh results array and fresh reload functions on every render.
  // Anything derived from those feeds the context-value memo below, and an
  // unstable context value re-renders every page on EVERY provider render —
  // the builder re-renders the root constantly, so the whole app churned
  // with it ("Detected constant re-rendering").
  const groupBuys = useStableValue(useMemo(() => rows<GroupBuyRow>(rawBuys), [rawBuys]));
  const reloadGroupBuys = useStableCallback(reloadGroupBuysRaw);
  const reloadSettings = useStableCallback(reloadSettingsRaw);

  const [groupBuyId, setGroupBuyIdState] = useState<number | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? Number(saved) : null;
  });

  // Default to the most recent campaign once the list loads.
  useEffect(() => {
    if (groupBuys.length === 0) return;
    if (groupBuyId == null || !groupBuys.some(g => Number(g.id) === Number(groupBuyId))) {
      setGroupBuyIdState(Number(groupBuys[0].id));
    }
  }, [groupBuys, groupBuyId]);

  const setGroupBuyId = useCallback((id: number) => {
    localStorage.setItem(STORAGE_KEY, String(id));
    setGroupBuyIdState(id);
  }, []);

  const settings = useStableValue(useMemo(() => {
    const map: Record<string, string> = {};
    for (const r of rows<{ key: string; value: string | null }>(rawSettings)) {
      map[r.key] = r.value || '';
    }
    return map;
  }, [rawSettings]));

  const value = useMemo<AppState>(() => ({
    userName: user.name || user.email || 'Admin',
    userEmail: user.email || '',
    groupBuys,
    groupBuy: groupBuys.find(g => Number(g.id) === Number(groupBuyId)) || null,
    groupBuyId: groupBuyId == null ? null : Number(groupBuyId),
    setGroupBuyId,
    reloadGroupBuys,
    settings,
    reloadSettings,
  }), [user.name, user.email, groupBuys, groupBuyId, setGroupBuyId, settings, reloadGroupBuys, reloadSettings]);

  if (buysLoading && groupBuys.length === 0) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground animate-pulse">Loading workspace…</div>
      </div>
    );
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
