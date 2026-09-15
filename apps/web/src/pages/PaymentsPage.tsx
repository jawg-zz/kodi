import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatDateTime } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { getPayment, listPayments, listTenants, recordManualPayment } from "../lib/api";
import { parseKES, normalizeMpesaCode } from "@kodi/shared";
import type { PaymentWithRefs, Tenant } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Input, Select } from "../components/Field";
import { Card, EmptyState, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { Modal } from "../components/Modal";
import { Money, paymentMethodLabel } from "../components/domain";

export function PaymentsPage() {
  const { org } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [method, setMethod] = useState("all");
  const [q, setQ] = useState("");
  const [showModal, setShowModal] = useState(false);

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [p, t] = await Promise.all([listPayments(org.id), listTenants(org.id)]);
      setPayments(p);
      setTenants(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  if (loading) return <Loading label="Loading payments…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.full_name ?? "—";
  const shown = payments.filter(
    (p) =>
      (method === "all" || p.method === method) &&
      (!q ||
        (p.tenant?.full_name ?? tenantName(p.tenant_id)).toLowerCase().includes(q.toLowerCase()) ||
        p.receipt_no.toLowerCase().includes(q.toLowerCase()) ||
        (p.mpesa_code ?? "").toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div>
      <PageHeader
        title="Payments"
        sub={`${shown.length} payments · ${(() => {
          const s = shown.reduce((x, p) => x + p.amount, 0);
          return new Intl.NumberFormat("en-US").format(s);
        })()} KES recorded`}
        actions={<Button onClick={() => setShowModal(true)}>Record payment</Button>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-52">
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="all">All methods</option>
              <option value="mpesa_stk">M-Pesa (STK)</option>
              <option value="mpesa_manual">M-Pesa (manual)</option>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </Select>
          </Field>
        </div>
        <div className="max-w-sm flex-1">
          <Field label="Search">
            <Input placeholder="Tenant, receipt no, or M-Pesa code…" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title="No payments found"
          hint="Record cash, bank, or manual M-Pesa payments. STK Push payments record automatically."
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="px-4 py-3">Receipt</th>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link to={`/app/payments/${p.id}`} className="font-medium text-brand-600 hover:underline">
                        {p.receipt_no}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/app/tenants/${p.tenant_id}`} className="hover:underline">
                        {p.tenant?.full_name ?? tenantName(p.tenant_id)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right"><Money value={p.amount} className="font-semibold" /></td>
                    <td className="px-4 py-3">
                      {paymentMethodLabel(p.method)}
                      {p.mpesa_code && <span className="ml-1 text-xs text-slate-500">{p.mpesa_code}</span>}
                    </td>
                    <td className="px-4 py-3">{formatDateTime(p.paid_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {showModal && (
        <RecordAnyPaymentModal
          orgId={org!.id}
          tenants={tenants}
          onClose={() => setShowModal(false)}
          onRecorded={load}
        />
      )}
    </div>
  );
}

function RecordAnyPaymentModal({ orgId, tenants, onClose, onRecorded }: {
  orgId: string;
  tenants: Tenant[];
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  const [tenantId, setTenantId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"mpesa_manual" | "cash" | "bank">("mpesa_manual");
  const [mpesaCode, setMpesaCode] = useState("");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseKES(amount);
    if (!tenantId) { setError("Choose a tenant."); return; }
    if (value === null || value < 1) { setError("Enter a valid amount in KES."); return; }
    const code = normalizeMpesaCode(mpesaCode);
    if (method === "mpesa_manual" && !code) {
      setError("Enter the M-Pesa transaction code from the confirmation SMS (e.g. SLJ7XK2M9P).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await recordManualPayment({
        orgId,
        tenantId,
        amount: value,
        method,
        mpesaCode: method === "mpesa_manual" ? code : null,
        paidAt: new Date(paidAt || Date.now()).toISOString(),
        note: note.trim() || null,
      });
      await onRecorded();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/already exists|duplicate/i.test(msg)
        ? "This M-Pesa code was already recorded. Check Payments before retrying."
        : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Record payment" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Tenant" required>
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
            <option value="">— Choose tenant —</option>
            {tenants.filter((t) => t.status !== "moved_out").map((t) => (
              <option key={t.id} value={t.id}>{t.full_name}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount (KES)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" required />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="mpesa_manual">M-Pesa (transaction code)</option>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
            </Select>
          </Field>
        </div>
        {method === "mpesa_manual" && (
          <Field label="M-Pesa transaction code" required>
            <Input value={mpesaCode} onChange={(e) => setMpesaCode(e.target.value.toUpperCase())} placeholder="SLJ7XK2M9P" />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Date received">
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Recording…" : "Record payment"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentWithRefs | null>(null);

  useEffect(() => {
    if (!id) return;
    getPayment(id)
      .then(setPayment)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <Loading label="Loading receipt…" />;
  if (error) return <ErrorBanner message={error} />;
  if (!payment) return <ErrorBanner message="Receipt not found." />;

  return (
    <div>
      <PageHeader
        title={`Receipt ${payment.receipt_no}`}
        sub={`${payment.tenant?.full_name ?? ""} · ${formatDateTime(payment.paid_at)}`}
        actions={
          <Link to={`/print/receipt/${payment.id}`} target="_blank" rel="noreferrer">
            <Button>Print receipt</Button>
          </Link>
        }
      />
      <Card>
        <div className="space-y-2 p-5 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Amount</span><Money value={payment.amount} className="font-bold" /></div>
          <div className="flex justify-between"><span className="text-slate-500">Method</span><span>{paymentMethodLabel(payment.method)}{payment.mpesa_code ? ` · ${payment.mpesa_code}` : ""}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Date</span><span>{formatDateTime(payment.paid_at)}</span></div>
          {payment.note && <div className="flex justify-between"><span className="text-slate-500">Note</span><span>{payment.note}</span></div>}
          <div className="border-t border-slate-100 pt-2">
            <p className="mb-1 text-slate-500">Applied to</p>
            {payment.allocations.length === 0 ? (
              <p className="text-slate-500">Held as credit (no open invoices).</p>
            ) : (
              <ul className="space-y-1">
                {payment.allocations.map((a, i) => (
                  <li key={i} className="flex justify-between">
                    <span>Invoice</span><Money value={a.amount} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
