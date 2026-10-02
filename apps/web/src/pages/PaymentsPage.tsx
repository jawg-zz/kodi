import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatDateTime, monthLabel } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  acknowledgeAlert,
  bulkMatchC2bByPhone,
  getCreditLedger,
  getPayment,
  listAlerts,
  listC2bPayments,
  listMpesaTransactions,
  listPayments,
  listTenants,
  listWebhookLog,
  linkDuplicateC2bPayment,
  matchC2bPayment,
  queryTransactionStatus,
  quoteBongaPoints,
  redeemBongaPoints,
  refundPayment,
  rejectC2bPayment,
  reverseDarajaPayment,
  suggestC2bTenant,
  verifyC2bTransaction,
  voidPayment,
} from "../lib/api";
import type { C2bPayment, C2bSuggestion, PaymentAlert, PaymentStatus, PaymentWithRefs, Tenant, WebhookHit } from "../lib/types";
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
  const [c2bQueue, setC2bQueue] = useState<C2bPayment[]>([]);
  const [alerts, setAlerts] = useState<PaymentAlert[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookHit[]>([]);
  const [showWebhooks, setShowWebhooks] = useState(false);
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
      const [p, t, txs, c2b, al] = await Promise.all([
        listPayments(org.id),
        listTenants(org.id),
        listMpesaTransactions(org.id).catch(() => []),
        listC2bPayments(org.id, "pending_review").catch(() => []),
        listAlerts(org.id).catch(() => []),
      ]);
      setPayments(p);
      setTenants(t);
      setPendingTx(txs.filter((x) => x.status === "pending"));
      setC2bQueue(c2b);
      setAlerts(al);
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
        sub={`${shown.length} payment${shown.length === 1 ? "" : "s"}, ${new Intl.NumberFormat("en-US").format(activeTotal)} KES active`}
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                if (!org) return;
                if (showWebhooks) {
                  setShowWebhooks(false);
                  return;
                }
                try {
                  setWebhooks(await listWebhookLog(org.id));
                } catch {
                  setWebhooks([]);
                }
                setShowWebhooks(true);
              }}
            >
              Webhook log
            </Button>
            <Button onClick={() => setShowModal(true)}>Record payment</Button>
          </div>
        }
      />

      {alerts.length > 0 && (
        <AlertsCard alerts={alerts} onChanged={load} />
      )}

      {showWebhooks && (
        <WebhookCard hits={webhooks} onClose={() => setShowWebhooks(false)} />
      )}

      {c2bQueue.length > 0 && org && (
        <C2bReviewCard
          queue={c2bQueue}
          tenants={tenants}
          payments={payments}
          orgId={org.id}
          onChanged={load}
        />
      )}

      {pendingTx.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50/60">
          <div className="p-4">
            <p className="text-sm font-semibold text-amber-900">
              {pendingTx.length} M-Pesa prompt{pendingTx.length === 1 ? "" : "s"} awaiting PIN
            </p>
            <ul className="mt-2 space-y-1 text-sm text-amber-900">
              {pendingTx.slice(0, 5).map((t) => (
                <li key={t.id} className="flex justify-between gap-2">
                  <span>{tenantName(t.tenant_id)}, <Money value={t.amount} /></span>
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
              <option value="mpesa_c2b">M-Pesa (Paybill)</option>
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
            <table className="rtable w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
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
                    <td data-label="Receipt" className="px-4 py-3">
                      <Link to={`/app/payments/${p.id}`} className="font-medium text-slate-900 underline-offset-2 hover:underline">
                        {p.receipt_no}
                      </Link>
                    </td>
                    <td data-label="Tenant" className="px-4 py-3">
                      <Link to={`/app/tenants/${p.tenant_id}`} className="hover:underline">
                        {p.tenant?.full_name ?? tenantName(p.tenant_id)}
                      </Link>
                    </td>
                    <td data-label="Amount" className="px-4 py-3 text-right"><Money value={p.amount} className="font-semibold text-brand-600" /></td>
                    <td data-label="Method" className="px-4 py-3">
                      {paymentMethodLabel(p.method)}
                      {p.mpesa_code && <span className="ml-1 text-xs text-slate-500">{p.mpesa_code}</span>}
                    </td>
                    <td data-label="Date" className="px-4 py-3">{formatDateTime(p.paid_at)}</td>
                    <td data-label="Status" className="px-4 py-3"><PaymentStatusBadge status={(p.status ?? "active") as PaymentStatus} /></td>
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
  const { org } = useAuth();
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentWithRefs | null>(null);
  const [ledger, setLedger] = useState<{ id: string; note: string | null; created_at: string }[]>([]);
  const [reverseMode, setReverseMode] = useState<"void" | "refund" | null>(null);
  const [darajaReversing, setDarajaReversing] = useState(false);
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

  const doDarajaReverse = async () => {
    if (!id || !org || !payment?.mpesa_code) return;
    setDarajaReversing(true);
    setError(null);
    try {
      const r = await reverseDarajaPayment({
        orgId: org.id,
        paymentId: id,
        remarks: reason.trim() || "Kodi duplicate-debit reversal",
      });
      setNotice(
        `Reversal accepted at Daraja (${r.conversation_id}). The payment auto-voids when the completion callback arrives — track it in Settings → Verification.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDarajaReversing(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={`Receipt ${payment.receipt_no}`}
        sub={`${payment.tenant?.full_name ?? ""} — ${formatDateTime(payment.paid_at)}`}
        actions={
          <div className="flex gap-2">
            {!reversed && (
              <>
                <Button variant="secondary" onClick={() => setReverseMode("void")}>Void…</Button>
                <Button variant="secondary" onClick={() => setReverseMode("refund")}>Refund…</Button>
                {payment.mpesa_code && (
                  <Button variant="secondary" onClick={doDarajaReverse} disabled={darajaReversing}>
                    {darajaReversing ? "Reversing…" : "Reverse at Daraja"}
                  </Button>
                )}
              </>
            )}
            <Link to={`/print/receipt/${payment.id}`} target="_blank" rel="noreferrer">
              <Button>Print receipt</Button>
            </Link>
          </div>
        }
      />
      {notice && (
        <div className="print-ink mb-4 rounded-xl border border-brand-100 bg-brand-50 p-3 text-sm font-medium text-brand-700">
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
          <div className="flex justify-between"><span className="text-slate-500">Method</span><span>{paymentMethodLabel(payment.method)}{payment.mpesa_code ? `, ${payment.mpesa_code}` : ""}</span></div>
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

/** Anomaly alerts: new senders, bursts, outliers. Acknowledge to clear. */
function AlertsCard({ alerts, onChanged }: {
  alerts: PaymentAlert[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const ack = async (id: string) => {
    setBusy(id);
    try {
      await acknowledgeAlert(id);
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-4 border-red-200 bg-red-50/50">
      <div className="p-4">
        <p className="text-sm font-semibold text-red-900">
          {alerts.length} payment alert{alerts.length === 1 ? "" : "s"}
        </p>
        <ul className="mt-2 space-y-2">
          {alerts.slice(0, 5).map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
              <div>
                <p className="font-medium text-red-950">{a.title}</p>
                {a.detail && <p className="text-xs text-red-700">{a.detail}</p>}
              </div>
              <Button size="sm" variant="secondary" onClick={() => ack(a.id)} disabled={busy === a.id}>
                {busy === a.id ? "…" : "Acknowledge"}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/** Daraja webhook debug trail: route, outcome, latency per hit. */
function WebhookCard({ hits, onClose }: {
  hits: WebhookHit[];
  onClose: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Card className="mb-4">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Webhook log ({hits.length})</p>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        {hits.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No webhook hits yet — they appear here as Daraja calls in.</p>
        ) : (
          <div className="mt-2 max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-1 pr-2">When</th>
                  <th className="py-1 pr-2">Route</th>
                  <th className="py-1 pr-2">TransID</th>
                  <th className="py-1 pr-2">Outcome</th>
                  <th className="py-1 text-right">ms</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {hits.slice(0, 50).map((h) => (
                  <>
                    <tr
                      key={h.id}
                      className={h.detail ? "cursor-pointer hover:bg-slate-50" : undefined}
                      onClick={() => h.detail && setOpenId(openId === h.id ? null : h.id)}
                      title={h.detail ? "Click to expand detail" : undefined}
                    >
                      <td className="py-1 pr-2 text-slate-500">
                        {new Date(h.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </td>
                      <td className="py-1 pr-2">{h.route}</td>
                      <td className="py-1 pr-2 font-mono">{h.trans_id ?? "—"}</td>
                      <td className="py-1 pr-2">
                        <Badge tone={/matched|success|duplicate/.test(h.outcome) ? "green" : /pending|late/.test(h.outcome) ? "amber" : /error|fail|unknown/.test(h.outcome) ? "red" : "slate"}>
                          {h.outcome}
                        </Badge>
                      </td>
                      <td className="py-1 text-right text-slate-500">{h.latency_ms ?? "—"}</td>
                    </tr>
                    {openId === h.id && h.detail && (
                      <tr key={`${h.id}-detail`}>
                        <td colSpan={5} className="bg-slate-50 px-2 py-1 font-mono text-[11px] break-all text-slate-600">
                          {h.detail}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Paybill hits that arrived with an unrecognised account number. Real
 * money is sitting in M-Pesa — staff attach each row to the right tenant
 * (records through the ledger) or reject it with a reason.
 */
function C2bReviewCard({ queue, tenants, payments, orgId, onChanged }: {
  queue: C2bPayment[];
  tenants: Tenant[];
  payments: PaymentWithRefs[];
  orgId: string;
  onChanged: () => Promise<void>;
}) {
  const [matchFor, setMatchFor] = useState<string | null>(null);
  const [tenantPick, setTenantPick] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMatchFor(null);
    setTenantPick("");
    setReason("");
    setError(null);
  };

  const doMatch = async () => {
    if (!matchFor || !tenantPick) return;
    setBusy(true);
    setError(null);
    try {
      await matchC2bPayment(matchFor, tenantPick);
      close();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doReject = async () => {
    if (!matchFor || !reason.trim()) {
      setError("Give a reason — it goes into the audit trail.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rejectC2bPayment(matchFor, reason.trim());
      close();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = queue.find((r) => r.id === matchFor) ?? null;

  const doBulk = async () => {
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const res = await bulkMatchC2bByPhone(orgId);
      setBulkMsg(
        res.matched > 0
          ? `${res.matched} payment${res.matched === 1 ? "" : "s"} matched by sender phone${res.skipped > 0 ? `, ${res.skipped} still need review` : ""}.`
          : "No unambiguous sender-phone matches — review the rows below.",
      );
      await onChanged();
    } catch (e) {
      setBulkMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <>
      <Card className="mb-4 border-purple-200 bg-purple-50/50">
        <div className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-purple-900">
              {queue.length} Paybill payment{queue.length === 1 ? "" : "s"} need{queue.length === 1 ? "s" : ""} matching
            </p>
            <Button size="sm" variant="secondary" onClick={doBulk} disabled={bulkBusy}>
              {bulkBusy ? "Matching…" : "Match all by sender phone"}
            </Button>
          </div>
          <p className="mt-0.5 text-xs text-purple-700">
            Money arrived via the M-Pesa menu with an unrecognised account number. Match it to a tenant or reject it.
          </p>
          {bulkMsg && <p className="mt-1 text-xs font-medium text-purple-900">{bulkMsg}</p>}
          <ul className="mt-2 divide-y divide-purple-100">
            {queue.slice(0, 8).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <p className="font-medium text-purple-950">
                    <Money value={r.amount} />, {r.trans_id}
                  </p>
                  <p className="text-xs text-purple-700">
                    {r.bill_ref ? `account "${r.bill_ref}" · ` : "no account · "}
                    {r.sender_name ?? r.msisdn} · {r.match_reason}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => { setMatchFor(r.id); setTenantPick(""); setReason(""); setError(null); }}>
                  Review
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {active && (
        <Modal title={`Match Paybill ${active.trans_id}`} onClose={close}>
          <MatchModalBody
            payment={active}
            tenants={tenants}
            payments={payments}
            tenantPick={tenantPick}
            setTenantPick={setTenantPick}
            reason={reason}
            setReason={setReason}
            busy={busy}
            error={error}
            onMatch={doMatch}
            onReject={doReject}
            onClose={close}
            onChanged={onChanged}
          />
        </Modal>
      )}
    </>
  );
}

function MatchModalBody({ payment, tenants, payments, tenantPick, setTenantPick, reason, setReason, busy, error, onMatch, onReject, onClose, onChanged }: {
  payment: C2bPayment;
  tenants: Tenant[];
  payments: PaymentWithRefs[];
  tenantPick: string;
  setTenantPick: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  error: string | null;
  onMatch: () => void;
  onReject: () => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [suggestions, setSuggestions] = useState<C2bSuggestion[] | null>(null);
  const [risk, setRisk] = useState<{ risk: string; checks: string[] } | null>(null);
  const [darajaStatus, setDarajaStatus] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [bonga, setBonga] = useState<{ points: number; value_kes: number } | null>(null);
  const [bongaBusy, setBongaBusy] = useState(false);
  const [bongaMsg, setBongaMsg] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  // Cross-channel duplicate: same receipt already recorded as a payment
  // (STK callback won the race). Offer a one-tap link, no new entry.
  const duplicateOf = payments.find(
    (p) => (p.mpesa_code ?? "") !== "" && p.mpesa_code === payment.trans_id && (p.status ?? "active") === "active",
  );

  const doLink = async () => {
    if (!duplicateOf) return;
    setLinkBusy(true);
    setLinkMsg(null);
    try {
      await linkDuplicateC2bPayment(payment.id, duplicateOf.id);
      setLinkMsg(`Linked to ${duplicateOf.receipt_no} — no second entry recorded.`);
      await onChanged();
      onClose();
    } catch (e) {
      setLinkMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLinkBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    suggestC2bTenant(payment.id)
      .then((s) => { if (alive) setSuggestions(s); })
      .catch(() => { if (alive) setSuggestions([]); });
    verifyC2bTransaction(payment.id)
      .then((r) => { if (alive) setRisk(r); })
      .catch(() => { if (alive) setRisk(null); });
    return () => { alive = false; };
  }, [payment.id]);

  const orgId = tenants.find((t) => t.id === tenantPick)?.org_id
    ?? tenants[0]?.org_id
    ?? "";

  const checkDaraja = async () => {
    if (!orgId) return;
    setStatusBusy(true);
    setDarajaStatus(null);
    try {
      const r = await queryTransactionStatus({ orgId, transactionId: payment.trans_id });
      setDarajaStatus(`Accepted (${r.conversation_id}) — the authoritative tier lands in Settings → Verification.`);
    } catch (e) {
      setDarajaStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusBusy(false);
    }
  };

  const quoteBonga = async () => {
    if (!orgId) return;
    setBongaBusy(true);
    setBongaMsg(null);
    try {
      const q = await quoteBongaPoints(orgId, payment.msisdn);
      setBonga({ points: q.points, value_kes: q.value_kes });
    } catch (e) {
      setBongaMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBongaBusy(false);
    }
  };

  const redeemBonga = async () => {
    if (!orgId || !tenantPick || !bonga) return;
    setBongaBusy(true);
    setBongaMsg(null);
    try {
      await redeemBongaPoints({ orgId, tenantId: tenantPick, phone: payment.msisdn, points: bonga.points });
      setBongaMsg(`Redeemed ${bonga.points} pts (~${bonga.value_kes} KES) — the tenant PIN-confirms; funds land via the normal Paybill path.`);
    } catch (e) {
      setBongaMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBongaBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <p><Money value={payment.amount} className="font-bold" /> from {payment.sender_name ?? payment.msisdn}</p>
        <p className="text-xs text-slate-500">
          {payment.bill_ref ? `Account typed: "${payment.bill_ref}" · ` : ""}
          {payment.match_reason}
        </p>
      </div>
      {risk && (
        <div className={`rounded-lg border p-3 text-sm ${risk.risk === "high" ? "border-red-200 bg-red-50 text-red-800" : risk.risk === "medium" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-green-200 bg-green-50 text-green-800"}`}>
          <p className="font-semibold">Risk: {risk.risk}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {risk.checks.slice(0, 4).map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {suggestions !== null && suggestions.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Likely tenants</p>
          <ul className="space-y-1">
            {suggestions.map((s) => (
              <li key={s.tenant_id}>
                <button
                  type="button"
                  onClick={() => setTenantPick(s.tenant_id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:border-brand-300 hover:bg-brand-50/50 ${tenantPick === s.tenant_id ? "border-brand-400 bg-brand-50" : "border-slate-200"}`}
                >
                  <span>
                    <span className="font-medium">{s.tenant_name}</span>
                    <span className="ml-2 text-xs text-slate-500">{s.signals.join(" · ")}</span>
                  </span>
                  <span className="text-xs font-medium text-brand-700">{Math.round(s.score * 100)}%</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Field label="Attach to tenant" required>
        <Select value={tenantPick} onChange={(e) => setTenantPick(e.target.value)}>
          <option value="">— Choose tenant —</option>
          {tenants.filter((t) => t.status !== "moved_out").map((t) => (
            <option key={t.id} value={t.id}>{t.full_name}</option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onMatch} disabled={busy || !tenantPick}>
          {busy ? "Matching…" : "Match & record payment"}
        </Button>
        <Button variant="secondary" onClick={checkDaraja} disabled={statusBusy}>
          {statusBusy ? "Verifying…" : "Verify at Daraja"}
        </Button>
        <Button variant="secondary" onClick={quoteBonga} disabled={bongaBusy}>
          {bongaBusy ? "Quoting…" : "Quote Bonga points"}
        </Button>
      </div>
      {darajaStatus && <p className="text-xs text-slate-500">{darajaStatus}</p>}
      {duplicateOf && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          <p>
            Same receipt already recorded as <strong>{duplicateOf.receipt_no}</strong>
            {duplicateOf.tenant?.full_name ? ` (${duplicateOf.tenant.full_name})` : ""} —{" "}
            this looks like the duplicate C2B notification for that payment.
          </p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={doLink} disabled={linkBusy}>
            {linkBusy ? "Linking…" : `Link to ${duplicateOf.receipt_no} (no new entry)`}
          </Button>
        </div>
      )}
      {linkMsg && <p className="text-xs text-slate-600">{linkMsg}</p>}
      {bonga && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p>Sender holds <strong>{bonga.points} pts</strong> (~{bonga.value_kes} KES).</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={redeemBonga} disabled={bongaBusy || !tenantPick}>
            Redeem toward {tenantPick ? "chosen tenant" : "…pick a tenant first"}
          </Button>
        </div>
      )}
      {bongaMsg && <p className="text-xs text-slate-600">{bongaMsg}</p>}
      <div className="border-t border-slate-100 pt-3">
        <Field label="Or reject (money stays with M-Pesa)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Test ping from Safaricom" />
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" onClick={onReject} disabled={busy}>Reject</Button>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}
