import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatDateTime, monthLabel } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  getCreditLedger,
  getPayment,
  listMpesaTransactions,
  listPayments,
  listTenants,
  refundPayment,
  voidPayment,
} from "../lib/api";
import type { PaymentStatus, PaymentWithRefs, Tenant } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Input, Select } from "../components/Field";
import { Badge, Card, EmptyState, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { Modal } from "../components/Modal";
import { Money, paymentMethodLabel, PaymentStatusBadge } from "../components/domain";
import { RecordPaymentFields } from "../components/RecordPaymentForm";
import type { MpesaTransaction } from "../lib/types";

type SortKey = "date" | "amount" | "receipt";

const TX_LABEL: Record<string, string> = {
  pending: "Waiting for PIN",
  success: "Paid",
  failed: "Failed",
  timeout: "Expired",
};

export function PaymentsPage() {
  const { org } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [pendingTx, setPendingTx] = useState<MpesaTransaction[]>([]);
  const [method, setMethod] = useState("all");
  const [status, setStatus] = useState("all");
  const [tenantId, setTenantId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [showModal, setShowModal] = useState(false);

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [p, t, txs] = await Promise.all([
        listPayments(org.id),
        listTenants(org.id),
        listMpesaTransactions(org.id).catch(() => []),
      ]);
      setPayments(p);
      setTenants(t);
      setPendingTx(txs.filter((x) => x.status === "pending"));
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

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.full_name ?? "—";

  const shown = useMemo(() => {
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = to ? new Date(`${to}T23:59:59`).getTime() : null;
    const min = minAmount ? Number(minAmount.replace(/[^0-9]/g, "")) : null;
    const rows = payments.filter((p) => {
      if (method !== "all" && p.method !== method) return false;
      if (status !== "all" && (p.status ?? "active") !== status) return false;
      if (tenantId !== "all" && p.tenant_id !== tenantId) return false;
      const paidMs = new Date(p.paid_at).getTime();
      if (fromMs !== null && !(paidMs >= fromMs)) return false;
      if (toMs !== null && !(paidMs <= toMs)) return false;
      if (min !== null && Number.isFinite(min) && !(p.amount >= min)) return false;
      if (q) {
        const needle = q.toLowerCase();
        const hay = [
          p.tenant?.full_name ?? tenantName(p.tenant_id),
          p.receipt_no,
          p.mpesa_code ?? "",
          p.note ?? "",
        ].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    rows.sort((a, b) => {
      if (sort === "amount") return b.amount - a.amount;
      if (sort === "receipt") return b.receipt_no.localeCompare(a.receipt_no);
      return new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime();
    });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, method, status, tenantId, from, to, minAmount, q, sort]);

  if (loading) return <Loading label="Loading payments…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  const activeTotal = shown
    .filter((p) => (p.status ?? "active") === "active")
    .reduce((x, p) => x + p.amount, 0);

  return (
    <div>
      <PageHeader
        title="Payments"
        sub={`${shown.length} payments · ${new Intl.NumberFormat("en-US").format(activeTotal)} KES active`}
        actions={<Button onClick={() => setShowModal(true)}>Record payment</Button>}
      />

      {pendingTx.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50/60">
          <div className="p-4">
            <p className="text-sm font-semibold text-amber-900">
              {pendingTx.length} M-Pesa prompt{pendingTx.length === 1 ? "" : "s"} awaiting PIN
            </p>
            <ul className="mt-2 space-y-1 text-sm text-amber-900">
              {pendingTx.slice(0, 5).map((t) => (
                <li key={t.id} className="flex justify-between gap-2">
                  <span>{tenantName(t.tenant_id)} · <Money value={t.amount} /></span>
                  <span className="text-xs text-amber-700">
                    {new Date(t.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-700">
              Confirmed payments record automatically — no need to record them by hand.
            </p>
          </div>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-44">
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
        <div className="w-36">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="voided">Voided</option>
              <option value="refunded">Refunded</option>
            </Select>
          </Field>
        </div>
        <div className="w-52">
          <Field label="Tenant">
            <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="all">All tenants</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.full_name}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-40">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        </div>
        <div className="w-40">
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Min amount">
            <Input value={minAmount} onChange={(e) => setMinAmount(e.target.value)} inputMode="numeric" placeholder="KES" />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Sort">
            <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="date">Newest first</option>
              <option value="amount">Largest first</option>
              <option value="receipt">Receipt no.</option>
            </Select>
          </Field>
        </div>
        <div className="max-w-sm flex-1">
          <Field label="Search">
            <Input placeholder="Tenant, receipt no, M-Pesa code, or note…" value={q} onChange={(e) => setQ(e.target.value)} />
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
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((p) => (
                  <tr key={p.id} className={`hover:bg-slate-50 ${(p.status ?? "active") !== "active" ? "opacity-60" : ""}`}>
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
                    <td className="px-4 py-3"><PaymentStatusBadge status={(p.status ?? "active") as PaymentStatus} /></td>
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
  const active = tenants.filter((t) => t.status !== "moved_out");

  return (
    <Modal title="Record payment" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Tenant" required>
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
            <option value="">— Choose tenant —</option>
            {active.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name}</option>
            ))}
          </Select>
        </Field>
        {tenantId ? (
          <RecordPaymentFields
            orgId={orgId}
            tenantId={tenantId}
            suggested={0}
            onDone={async () => {
              await onRecorded();
              onClose();
            }}
          />
        ) : (
          <p className="text-sm text-slate-500">Choose a tenant to see open invoices and the allocation preview.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentWithRefs | null>(null);
  const [ledger, setLedger] = useState<{ id: string; note: string | null; created_at: string }[]>([]);
  const [reverseMode, setReverseMode] = useState<"void" | "refund" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const p = await getPayment(id);
      setPayment(p);
      if (p) {
        try {
          const rows = await getCreditLedger(p.tenant_id);
          setLedger(
            rows
              .filter((r) => r.payment_id === p.id)
              .map((r) => ({ id: r.id, note: r.note, created_at: r.created_at })),
          );
        } catch {
          setLedger([]);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) return <Loading label="Loading receipt…" />;
  if (error) return <ErrorBanner message={error} />;
  if (!payment) return <ErrorBanner message="Receipt not found." />;

  const reversed = (payment.status ?? "active") !== "active";

  const doReverse = async () => {
    if (!reverseMode || !id) return;
    if (!reason.trim()) {
      setError("Give a reason — it goes into the audit trail.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = reverseMode === "void"
        ? await voidPayment(id, reason.trim())
        : await refundPayment(id, reason.trim());
      setReverseMode(null);
      setReason("");
      setNotice(
        reverseMode === "void"
          ? `Payment voided. Invoices restored${res.credit_shortfall > 0 ? `; ${new Intl.NumberFormat("en-US").format(res.credit_shortfall)} KES of created credit was already spent and could not be clawed back` : ""}.`
          : `Refund recorded. Invoices restored${res.credit_shortfall > 0 ? `; ${new Intl.NumberFormat("en-US").format(res.credit_shortfall)} KES of created credit was already spent` : ""}.`,
      );
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={`Receipt ${payment.receipt_no}`}
        sub={`${payment.tenant?.full_name ?? ""} · ${formatDateTime(payment.paid_at)}`}
        actions={
          <div className="flex gap-2">
            {!reversed && (
              <>
                <Button variant="secondary" onClick={() => setReverseMode("void")}>Void…</Button>
                <Button variant="secondary" onClick={() => setReverseMode("refund")}>Refund…</Button>
              </>
            )}
            <Link to={`/print/receipt/${payment.id}`} target="_blank" rel="noreferrer">
              <Button>Print receipt</Button>
            </Link>
          </div>
        }
      />
      {notice && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {notice}
        </div>
      )}
      {reversed && (
        <div className="mb-4 rounded-xl border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
          This payment was {payment.status === "voided" ? "voided" : "refunded"}
          {payment.reverse_reason ? `: ${payment.reverse_reason}` : ""}. It stays
          visible for the audit trail but no longer counts in totals.
        </div>
      )}
      <Card>
        <div className="space-y-2 p-5 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">Status</span>
            <PaymentStatusBadge status={(payment.status ?? "active") as PaymentStatus} />
          </div>
          <div className="flex justify-between"><span className="text-slate-500">Amount</span><Money value={payment.amount} className="font-bold" /></div>
          <div className="flex justify-between"><span className="text-slate-500">Method</span><span>{paymentMethodLabel(payment.method)}{payment.mpesa_code ? ` · ${payment.mpesa_code}` : ""}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Date</span><span>{formatDateTime(payment.paid_at)}</span></div>
          {payment.note && <div className="flex justify-between"><span className="text-slate-500">Note</span><span>{payment.note}</span></div>}
          {payment.leftover_credit > 0 && (
            <div className="flex justify-between"><span className="text-slate-500">Kept as credit</span><Money value={payment.leftover_credit} /></div>
          )}
          <div className="border-t border-slate-100 pt-2">
            <p className="mb-1 text-slate-500">Applied to</p>
            {payment.allocations.length === 0 ? (
              <p className="text-slate-500">Held as prepaid credit — applies automatically to the next invoice.</p>
            ) : (
              <ul className="space-y-1">
                {payment.allocations.map((a, i) => (
                  <li key={i} className="flex justify-between">
                    <span>{a.month ? monthLabel(a.month) : "Invoice"}</span><Money value={a.amount} />
                  </li>
                ))}
              </ul>
            )}
            {ledger.length > 0 && (
              <p className="mt-2 text-xs text-slate-400">
                Credit trail: {ledger.map((l) => l.note ?? "entry").join(" · ")}
              </p>
            )}
          </div>
        </div>
      </Card>

      {reverseMode && (
        <Modal
          title={reverseMode === "void" ? `Void ${payment.receipt_no}` : `Refund ${payment.receipt_no}`}
          onClose={() => { setReverseMode(null); setReason(""); }}
        >
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {reverseMode === "void"
                ? "Voiding restores the invoice balances this payment settled and claws back any credit it created. Use it for wrong-tenant, wrong-amount, or test entries."
                : "Refunding does the same ledger reversal and records that the money went back to the tenant. Describe how the refund was made below."}
            </p>
            <Field
              label={reverseMode === "void" ? "Reason for void" : "How was the refund made?"}
              required
            >
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reverseMode === "void" ? "e.g. Wrong tenant selected" : "e.g. M-Pesa reversal SMS …"}
              />
            </Field>
            {error && <ErrorBanner message={error} />}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setReverseMode(null); setReason(""); }}>Cancel</Button>
              <Button onClick={doReverse} disabled={busy}>
                {busy ? "Working…" : reverseMode === "void" ? "Void payment" : "Record refund"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function PendingTxBadge({ status }: { status: string }) {
  return <Badge tone={status === "pending" ? "amber" : status === "success" ? "green" : "red"}>{TX_LABEL[status] ?? status}</Badge>;
}
