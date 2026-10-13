import { useMemo } from 'react';
import { useMutateAction } from '@uibakery/data';
import readAuditTrail from '@/actions/orders/readAuditTrail';
import listOrderRecon from '@/actions/recon/listOrderRecon';
import type { AssistantTools, ReconRail, ReconStatus } from './assistant';

/**
 * The assistant's two READ tools, pinned to one campaign. Both are load
 * actions invoked imperatively (the getOrderTxRefs precedent); the
 * campaign id is closed over here, so the model can only ever name an
 * order number or a status — never a campaign. No campaign → no tools.
 */
export function useAssistantTools(groupBuyId: number | null): AssistantTools {
  const [doTrail] = useMutateAction(readAuditTrail);
  const [doRecon] = useMutateAction(listOrderRecon);
  return useMemo<AssistantTools>(() => {
    if (groupBuyId == null) return {};
    return {
      get_order_timeline: (orderNumber: string) => doTrail({ order_number: orderNumber, group_buy_id: groupBuyId }),
      list_recon: (status: ReconStatus, rail: ReconRail) => doRecon({ group_buy_id: groupBuyId, recon: status, rail }),
    };
  }, [doTrail, doRecon, groupBuyId]);
}
