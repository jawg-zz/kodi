import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import {
  listTenantInvoices,
  listTenantPayments,
} from "../lib/api";
import { stkInitiate, stkStatus } from "../lib/api";
import type { InvoiceWithRefs, MpesaTransaction, PaymentWithRefs } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Input } from "../components/Field";
import { Badge, Card, CardBody, ErrorBanner, Loading, Stat } from "../components/ui";
import { InvoiceStatusBadge, Money, paymentMethodLabel } from "../components/domain";
import { formatKES, monthLabel, normalizeKenyanPhone, parseKES } from "@kodi/shared";

export function PortalPage() {
  const { tenant } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);
  const [showPay, setShowPay] = useState(false);
  const [tx, setTx] = useState<MpesaTransaction | null>(null);

  const load = async () => {
    if (!tenant) return;
    setLoading(true);
    setError(null);
    try {
      const [inv, pay] = await Promise.all([
        listTenantInvoices(tenant.id),
        listTenantPayments(tenant.id),
      ]);
      setInvoices(inv);
      setPayments(pay);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id]);

  useEffect(() => {
    if (!tx || tx.status !== "pending") return;
    const timer = setInterval(async () => {
      try {
        const latest = await stkStatus(tx.checkout_request_id);
        setTx(latest);
        if (latest.status === "success") void load();
      } catch {
        // keep polling
      }
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.checkout_request_id, tx?.status]);

  if (loading) return <Loading label="Loading your account…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!tenant) return <ErrorBanner message="Tenant account not found." />;

  const balance = invoices.reduce((s, i) => s + i.balance, 0);
  const oldest = invoices.filter((i) => i.balance > 0).at(-1);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Balance owed" value={formatKES(balance)} accent={balance > 0 ? "red" : "green"} sub={oldest ? `oldest: ${monthLabel(oldest.month)}` : "all paid up"} />
        <Stat label="Invoices" value={String(invoices.length)} sub={`${invoices.filter((i) => i.status === "paid").length} paid`} />
        <Stat label="Payments made" value={String(payments.length)} sub={payments.length ? `latest ${formatKES(payments[0].amount)}` : "none yet"} />
      </div>

      {balance > 0 && (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Pay your rent</h2>
                <p className="text-sm text-slate-500">
                  Pay via M-Pesa to your own number — you'll get an STK prompt to enter your PIN.
                </p>
              </div>
              <Button onClick={() => setShowPay(true)}>Pay via M-Pesa</Button>
            </div>
            {tx && tx.status === "pending" && (
              <div className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                A prompt for {formatKES(tx.amount)} was sent to your phone. Enter your M-Pesa PIN to complete it — this page updates automatically.
              </div>
            )}
            {tx && tx.status === "success" && (
              <div className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">
                Payment of {formatKES(tx.amount)} confirmed{tx.mpesa_receipt ? ` (M-Pesa ${tx.mpesa_receipt})` : ""}. Thank you!
              </div>
            )}
            {tx && (tx.status === "failed" || tx.status === "timeout") && (
              <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                The payment did not complete{tx.result_desc ? `: ${tx.result_desc}` : "."} You can try again.
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <h2 className="mb-2 font-semibold">Your invoices</h2>
          {invoices.length === 0 ? (
            <p className="text-sm text-slate-500">No invoices yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2 pr-3">Month</th>
                    <th className="py-2 pr-3 text-right">Total</th>
                    <th className="py-2 pr-3 text-right">Balance</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td className="py-2 pr-3 font-medium">{monthLabel(i.month)}</td>
                      <td className="py-2 pr-3 text-right"><Money value={i.total} /></td>
                      <td className="py-2 pr-3 text-right"><Money value={i.balance} /></td>
                      <td className="py-2"><InvoiceStatusBadge status={i.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Your payments</h2>
            <a href={`/print/statement/${tenant.id}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-600 hover:underline">
              Print statement
            </a>
          </div>
          {payments.length === 0 ? (
            <p className="text-sm text-slate-500">No payments yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <p className="font-medium">{p.receipt_no}</p>
                    <p className="text-xs text-slate-500">
                      {paymentMethodLabel(p.method)}{p.mpesa_code ? ` · ${p.mpesa_code}` : ""} · {new Date(p.paid_at).toLocaleDateString("en-GB")}
                    </p>
                  </div>
                  <Money value={p.amount} className="font-semibold text-brand-600" />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {showPay && (
        <SelfPayModal
          tenantId={tenant.id}
          phone={tenant.phone}
          balance={balance}
          onClose={() => setShowPay(false)}
          onStarted={setTx}
        />
      )}
    </div>
  );
}

function SelfPayModal({ tenantId, phone, balance, onClose, onStarted }: {
  tenantId: string;
  phone: string;
  balance: number;
  onClose: () => void;
  onStarted: (tx: MpesaTransaction) => void;
}) {
  const [amount, setAmount] = useState(String(balance));
  const [number, setNumber] = useState(phone);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseKES(amount);
    const normalized = normalizeKenyanPhone(number);
    if (value === null || value < 1) { setError("Enter a valid amount in KES."); return; }
    if (!normalized) { setError("Enter a valid Safaricom number."); return; }
    setBusy(true);
    setError(null);
    try {
      const { checkoutRequestId } = await stkInitiate({ tenantId, phone: normalized, amount: value });
      onStarted({ checkout_request_id: checkoutRequestId, status: "pending", amount: value } as MpesaTransaction);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold">Pay via M-Pesa</h2>
        </div>
        <form onSubmit={pay} className="space-y-4 px-5 py-4">
          <Field label="Amount (KES)" required hint={`Your balance is ${formatKES(balance)}.`}>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" required />
          </Field>
          <Field label="Safaricom number" required hint="The prompt goes to this number.">
            <Input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" required />
          </Field>
          {error && <ErrorBanner message={error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Sending prompt…" : "Send M-Pesa prompt"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TenantBadgeCheck() {
  return <Badge tone="slate">tenant</Badge>;
}
