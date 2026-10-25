import { useMemo } from 'react';
import { useMutateAction } from '@uibakery/data';
import readAuditTrail from '@/actions/orders/readAuditTrail';
import listOrderRecon from '@/actions/recon/listOrderRecon';
import { useApp } from '@/app/AppContext';
import { lookupTxPayment } from '@/lib/verifyPayment';
import type { AssistantTools, CryptoMethod, ReconRail, ReconStatus } from './assistant';

/**
 * The assistant's READ tools, pinned to one campaign. The two load
 * actions are invoked imperatively (the getOrderTxRefs precedent); the
 * campaign id is closed over here, so the model can only ever name an
 * order number or a status — never a campaign. No campaign → no tools.
 * lookup_tx is the Verify button's on-chain lookup (Moralis / Helius
 * with the keys and receiving wallets from Settings) minus its write:
 * it reads the chain and returns what it found, nothing more.
 */
export function useAssistantTools(groupBuyId: number | null): AssistantTools {
  const { settings } = useApp();
  const [doTrail] = useMutateAction(readAuditTrail);
  const [doRecon] = useMutateAction(listOrderRecon);
  return useMemo<AssistantTools>(() => {
    if (groupBuyId == null) return {};
    return {
      get_order_timeline: (orderNumber: string) => doTrail({ order_number: orderNumber, group_buy_id: groupBuyId }),
      list_recon: (status: ReconStatus, rail: ReconRail) => doRecon({ group_buy_id: groupBuyId, recon: status, rail }),
      lookup_tx: (method: CryptoMethod, txHash: string) => lookupTxPayment(method, txHash, settings),
    };
  }, [doTrail, doRecon, groupBuyId, settings]);
}

