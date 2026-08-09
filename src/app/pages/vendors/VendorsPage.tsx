import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listVendors from '@/actions/vendors/listVendors';
import listVendorBalances from '@/actions/vendors/listVendorBalances';
import listVendorPayments from '@/actions/vendors/listVendorPayments';
import addVendorPayment from '@/actions/vendors/addVendorPayment';
import saveVendor from '@/actions/vendors/saveVendor';
import listWallets from '@/actions/financials/listWallets';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD, fmtDate } from '@/lib/fmt';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusPill } from '@/components/StatusPill';
import { Store, AlertTriangle } from 'lucide-react';

type Vendor = { id: number; code: string; name: string; active: boolean };
type Balance = {
  vendor_id: number; vendor_code: string; owed_usd: string; paid_usd: string;
  balance_usd: string; pay_status: string;
};
type Payment = {
  id: number; paid_on: string; amount_usd: string; method: string | null;
  receipt_ref: string | null; note: string | null; vendor_code: string; wallet_name: string | null;
};
type Wallet = { id: number; name: string };

export function VendorsPage() {
  const { groupBuyId, userName } = useApp();
  const enabled = groupBuyId != null;
  const [rawVendors, , , reloadVendors] = useLoadAction(listVendors, [], {});
  const [rawBalances, , , reloadBalances] = useLoadAction(listVendorBalances, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawPayments, , , reloadPayments] = useLoadAction(listVendorPayments, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawWallets] = useLoadAction(listWallets, [], {});

  const vendors = rows<Vendor>(rawVendors);
  const balances = rows<Balance>(rawBalances);
  const payments = rows<Payment>(rawPayments);
  const wallets = rows<Wallet>(rawWallets);

  const [doPay] = useMutateAction(addVendorPayment);
  const [doSaveVendor] = useMutateAction(saveVendor);

  const [pVendor, setPVendor] = useState('');
  const [pDate, setPDate] = useState('');
  const [pAmount, setPAmount] = useState('');
  const [pWallet, setPWallet] = useState('');
  const [pMethod, setPMethod] = useState('USDC');
  const [pRef, setPRef] = useState('');
  const [pNote, setPNote] = useState('');
  const [pError, setPError] = useState('');
  const [pSaving, setPSaving] = useState(false);

  const [nvCode, setNvCode] = useState('');
  const [nvError, setNvError] = useState('');

  const overpaid = balances.filter(b => b.pay_status === 'OVERPAID');

  const recordPayment = async () => {
    const amt = Number(pAmount);
    if (!pVendor || !pDate || !(amt > 0)) {
      setPError('Vendor, date, and a positive amount are required.');
      return;
    }
    setPSaving(true); setPError('');
    try {
      await doPay({
        vendor_id: Number(pVendor), group_buy_id: groupBuyId, paid_on: pDate,
        amount_usd: amt, wallet_id: pWallet, method: pMethod, receipt_ref: pRef, note: pNote,
        actor: userName,
      });
      setPAmount(''); setPRef(''); setPNote('');
      reloadBalances(); reloadPayments();
    } catch (e: unknown) {
      setPError(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setPSaving(false);
    }
  };

  const addNewVendor = async () => {
    const code = nvCode.trim().toUpperCase();
    if (!code) { setNvError('Code required'); return; }
    setNvError('');
    try {
      await doSaveVendor({ code, name: code, notes: '', active: true });
      setNvCode('');
      reloadVendors();
    } catch (e: unknown) {
      setNvError(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Store className="h-6 w-6 text-violet-600" /> Vendors
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Balances are computed from final counts × unit cost; payments are logged, never typed over.</p>
      </div>

      {overpaid.length > 0 && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span><span className="font-semibold">{overpaid.map(o => o.vendor_code).join(', ')}</span> {overpaid.length === 1 ? 'is' : 'are'} OVERPAID — money went out beyond what's owed.</span>
        </div>
      )}

      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead className="text-right">Owed</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {balances.map(b => (
              <TableRow key={b.vendor_id}>
                <TableCell className="font-medium">{b.vendor_code}</TableCell>
                <TableCell className="text-right">{fmtUSD(b.owed_usd)}</TableCell>
                <TableCell className="text-right">{fmtUSD(b.paid_usd)}</TableCell>
                <TableCell className={`text-right font-medium ${parseFloat(b.balance_usd) < 0 ? 'text-red-600' : ''}`}>{fmtUSD(b.balance_usd)}</TableCell>
                <TableCell><StatusPill value={b.pay_status} /></TableCell>
              </TableRow>
            ))}
            {balances.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No campaign products yet — vendor balances appear once products are configured.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Record vendor payment</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Select value={pVendor} onValueChange={setPVendor}>
                <SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Vendor" /></SelectTrigger>
                <SelectContent>
                  {vendors.filter(v => v.active).map(v => <SelectItem key={v.id} value={String(v.id)}>{v.code}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input type="date" value={pDate} onChange={e => setPDate(e.target.value)} className="h-9 w-40" />
            </div>
            <div className="flex gap-2">
              <Input placeholder="Amount USD" value={pAmount} onChange={e => setPAmount(e.target.value)} className="h-9 w-36" />
              <Select value={pWallet} onValueChange={setPWallet}>
                <SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Paid from wallet" /></SelectTrigger>
                <SelectContent>
                  {wallets.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input placeholder="Method" value={pMethod} onChange={e => setPMethod(e.target.value)} className="h-9 w-24" />
            </div>
            <div className="flex gap-2">
              <Input placeholder="Receipt / tx ref (optional)" value={pRef} onChange={e => setPRef(e.target.value)} className="h-9 flex-1" />
              <Input placeholder="Note (e.g. which SKU)" value={pNote} onChange={e => setPNote(e.target.value)} className="h-9 flex-1" />
            </div>
            {pError && <p className="text-sm text-red-600">{pError}</p>}
            <Button size="sm" onClick={recordPayment} disabled={pSaving}>Record payment</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Add vendor</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Input placeholder="Vendor code (e.g. MEDUSA)" value={nvCode} onChange={e => setNvCode(e.target.value)} className="h-9 flex-1" />
              <Button size="sm" onClick={addNewVendor}>Add</Button>
            </div>
            {nvError && <p className="text-sm text-red-600">{nvError}</p>}
            <p className="text-xs text-muted-foreground">Existing: {vendors.map(v => v.code).join(', ')}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Payment log</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Wallet</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map(p => (
                <TableRow key={p.id}>
                  <TableCell>{fmtDate(p.paid_on)}</TableCell>
                  <TableCell className="font-medium">{p.vendor_code}</TableCell>
                  <TableCell className="text-right">{fmtUSD(p.amount_usd)}</TableCell>
                  <TableCell>{p.wallet_name || '—'}</TableCell>
                  <TableCell>{p.method || '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{p.note || ''}</TableCell>
                </TableRow>
              ))}
              {payments.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No vendor payments yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
